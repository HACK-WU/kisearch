/**
 * SVG 栅格化（REQ-20261123-008 · B3）
 *
 * 上游对 `data:image/svg+xml` 直接 400（实测 `UnidentifiedImageError`），而知识库里的图
 * 绝大多数是 SVG（抽样：consul 1370 张里 1369 张）。所以要在服务端画成 PNG 再送。
 *
 * ═══ 为什么必须放 worker_threads ═══
 * `resvg.render()` 是**同步 CPU 调用**，实测①纯色块 240×120 = 38~46ms；②35 个 `<text>`
 * 的信息图 = 2284~2495ms。若在主线程执行，取一次图就会卡住 daemon 的所有并发请求 2.5 秒
 * （healthz / 页面轮询 / 其它 MCP 调用全部排队）。
 * 字体配置优化（收窄 fontDirs、改指定字体文件）实测**无收益**，耗时只取决于 SVG 复杂度，
 * 所以只能靠"挪出主线程 + 缓存"两条路。
 *
 * ═══ 生命周期约定（DESIGN §3.2）═══
 * · worker 崩溃 / 退出：标记失效，下一次请求重建；**在途任务不重排**（重排会在坏 SVG 上反复崩）
 * · 队列上限 8：超限直接报错 —— 排队等待只会让调用方的 10s 超时先触发，反而更难诊断
 * · 进程退出：terminate 并等待 ≤2s，不阻塞退出
 * · 超时：单张 10s。超时后必须 **terminate 重建** —— 同步渲染中的 worker 收不到取消信号
 *
 * ═══ 缓存 ═══
 * key = `(scope, group, ref, mtimeMs, size)`：文档重导覆盖 assets 会产生新 key，旧 key
 * 靠 LRU 自然淘汰（不主动清理）。同一 key 的并发请求**复用同一个 Promise**，否则同一张
 * 复杂图会被渲两遍（白付 5s）。淘汰只淘汰**已完成**的条目。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** 与 worker 内的默认值保持一致（DESIGN §3.2：1568 是上游尺寸拐点，≈704 image_tokens） */
export const RASTER_MAX_WIDTH = 1568;
/** 单张渲染超时 */
export const RASTER_TIMEOUT_MS = 10_000;
/** 队列上限：超限直接拒绝，不排队 */
export const RASTER_QUEUE_LIMIT = 8;
/** 缓存条目数 / 字节上限 */
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;

export interface RasterResult {
  png: Buffer;
  width: number;
  height: number;
  /** true = 命中缓存（耗时 0ms） */
  cached: boolean;
}

export type RasterFailure =
  | { ok: false; code: 'IMAGE_RENDER_FAILED'; message: string }
  | { ok: false; code: 'IMAGE_QUERY_LIMIT'; message: string }
  | { ok: false; code: 'IMAGE_TOO_LARGE'; message: string };

export type RasterOutcome = ({ ok: true } & RasterResult) | RasterFailure;

// ─── worker 管理 ────────────────────────────────────────

interface Pending {
  resolve: (value: { png: Buffer; width: number; height: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function workerPath(): string {
  // worker 与本源文件同目录；用 import.meta.url 而不是 cwd —— 后者在 daemon 里不可靠
  //
  // ★ 必须 `fileURLToPath` 而不是 `.pathname`：`pathname` 是 **URL 编码**过的字符串，
  //   源码路径一旦含空格 / 中文（如 `~/My Projects/ki`、`/home/张三/ki`），
  //   `new Worker('/root/my%20project/...')` 会直接 ERR_MODULE_NOT_FOUND ——
  //   而且只在那种路径下复现，本地无空格开发环境永远碰不到。
  return fileURLToPath(new URL('./svg-raster.worker.mjs', import.meta.url));
}

function disposeWorker(reason: string): void {
  const w = worker;
  worker = null;
  if (w) {
    // terminate 是异步的，但不 await：调用方已经在等 reject
    void w.terminate().catch(() => undefined);
  }
  // 在途任务一律失败（不重排 —— 重排会在坏输入上反复崩）。
  // 文案要说明"被连带中断"而不只是复述原因：worker 是**单线程串行**的，一张图超时
  // 会终止进程、把同批其它图的请求一起带走——那些图自己没问题，报文不能让人以为它们坏了。
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(`${reason}；该请求因共享渲染进程被重建而中断（重试通常可成功）`));
    pending.delete(id);
  }
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerPath());
  w.on('message', (msg: { id: number; ok: boolean; png?: ArrayBuffer; width?: number; height?: number; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok && msg.png) {
      p.resolve({ png: Buffer.from(msg.png), width: msg.width ?? 0, height: msg.height ?? 0 });
    } else {
      p.reject(new Error(msg.error || 'SVG 渲染失败（未知原因）'));
    }
  });
  w.on('error', (err: Error) => disposeWorker(`栅格化 worker 异常：${err.message}`));
  w.on('exit', (code) => {
    // 正常退出（terminate 后）时 worker 已被置空，这里只处理意外退出
    if (worker === w) disposeWorker(`栅格化 worker 意外退出（code=${code}）`);
  });
  worker = w;
  return w;
}

/** 进程退出时清理，避免 daemon 关闭被 worker 拖住 */
process.once('exit', () => {
  try {
    void worker?.terminate();
  } catch {
    // 退出路径上不做任何补救
  }
});

// ─── 缓存 ───────────────────────────────────────────────

interface CacheEntry {
  png: Buffer;
  width: number;
  height: number;
}

/** 简单 LRU：Map 的插入顺序即访问顺序（命中时先删再插） */
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RasterOutcome>>();
let cacheBytes = 0;

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: CacheEntry): void {
  const prev = cache.get(key);
  if (prev) {
    cacheBytes -= prev.png.byteLength;
    cache.delete(key);
  }
  cache.set(key, entry);
  cacheBytes += entry.png.byteLength;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted) cacheBytes -= evicted.png.byteLength;
  }
}

/** 仅供测试：清空缓存与在途表 */
export function __resetRasterState(): void {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
}

/** 仅供测试：当前缓存条目数 */
export function __rasterCacheSize(): number {
  return cache.size;
}

// ─── 渲染 ───────────────────────────────────────────────

/** 一次渲染请求（不做缓存，内部用） */
function renderOnce(svgText: string): Promise<{ png: Buffer; width: number; height: number }> {
  if (pending.size >= RASTER_QUEUE_LIMIT) {
    return Promise.reject(Object.assign(new Error('栅格化队列已满'), { code: 'IMAGE_QUERY_LIMIT' }));
  }
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // 同步渲染中的 worker 收不到取消信号 → 只能 terminate 重建
      disposeWorker(`SVG 渲染超时（>${RASTER_TIMEOUT_MS}ms）`);
      reject(new Error(`SVG 渲染超时（>${RASTER_TIMEOUT_MS}ms）`));
    }, RASTER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, svg: svgText, maxWidth: RASTER_MAX_WIDTH });
  });
}

/**
 * 渲染一个 SVG 文件为 PNG（带缓存与并发去重）。
 *
 * @param absPath  已通过双锚点校验的**绝对路径**
 * @param cacheKey 缓存 key 的业务部分（`scope|group|ref`）；函数内部再拼 mtime + size，
 *                 这样文件被重导覆盖后自动失效
 */
export async function rasterizeSvgFile(absPath: string, cacheKey: string): Promise<RasterOutcome> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, code: 'IMAGE_RENDER_FAILED', message: `读取 SVG 失败（${code}）` };
  }
  if (stat.size > 4 * 1024 * 1024) {
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      message: `SVG 源文件 ${Math.round(stat.size / 1024)}KB 超过单张上限 4MB`,
    };
  }

  const key = `${cacheKey}|${stat.mtimeMs}|${stat.size}`;

  const hit = cacheGet(key);
  if (hit) return { ok: true, ...hit, cached: true };

  // 并发去重：同一张图同时被两个请求取时复用同一次渲染
  const running = inflight.get(key);
  if (running) {
    const shared = await running;
    if (!shared.ok) return shared;
    return { ...shared, cached: true };
  }

  const task = (async (): Promise<RasterOutcome> => {
    let svgText: string;
    try {
      svgText = await fs.promises.readFile(absPath, 'utf8');
    } catch (err) {
      return {
        ok: false,
        code: 'IMAGE_RENDER_FAILED',
        message: `读取 SVG 失败（${(err as NodeJS.ErrnoException).code}）`,
      };
    }
    try {
      const rendered = await renderOnce(svgText);
      cacheSet(key, rendered);
      return { ok: true, ...rendered, cached: false };
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'IMAGE_QUERY_LIMIT') {
        return { ok: false, code: 'IMAGE_QUERY_LIMIT', message: '栅格化队列已满，请稍后重试或减少一次取图张数' };
      }
      return { ok: false, code: 'IMAGE_RENDER_FAILED', message: `SVG 渲染失败：${e.message}` };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** 仅供测试/诊断：拼接缓存 key 的业务部分 */
export function rasterCacheKey(scope: string, group: string, ref: string): string {
  return `${scope}|${group}|${ref}`;
}

/** 仅供测试：worker 是否存活 */
export function __rasterWorkerAlive(): boolean {
  return worker !== null;
}

/** 仅供测试：在途任务数 */
export function __rasterPendingCount(): number {
  return pending.size;
}

/** 仅供测试：路径解析（确认 .mjs 能被找到） */
export function __rasterWorkerPath(): string {
  return workerPath();
}
