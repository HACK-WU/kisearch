/**
 * 图集包的校验与落盘内核（设计 S01 §3.3~§3.5）。
 *
 * 唯一写入口：installPackage。CLI 与（二期）HTTP 上传都只能走这里，禁止各自实现校验
 * ——两条入口各写一套必然漂移，而漂移的代价是「某种坏包能从某一侧装进库」。
 *
 * 顺序固定：先全部在内存里校验完，再动磁盘；落盘用 tmp + rename 原子替换，
 * 任何时刻磁盘上要么是旧包要么是新包，不会出现半个文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson, scopeDirExists } from '../store.js';
import { AtlasError } from './errors.js';
import { MAX_ENTRY_BYTES, openZip } from './zip-read.js';
import {
  archiveDir,
  archiveFilePath,
  atlasDir,
  entryPath,
  metaPath,
  packageZipPath,
  safeJoin,
} from './paths.js';
import type { AtlasMeta, AtlasStatus, InstallOptions, InstallResult } from './types.js';

/** 包内 meta.json 的体积上限（它只是几十字节的元信息，不该是内容载体） */
const MAX_INNER_META_BYTES = 8 * 1024;

const HTML_RE = /\.html?$/i;
/** 外链资源判据（与需求 §3.2 一致：src / href 指向 http(s) 即拒） */
const EXTERNAL_RE = /(?:src|href)\s*=\s*"(https?:\/\/[^"]+)"|url\((https?:\/\/[^)]+)\)/i;

/** 包内根目录下的 html（不含子目录；大小写不敏感） */
function pickRootHtml(entries: { name: string }[]): string {
  const candidates = entries.filter((e) => !e.name.includes('/') && HTML_RE.test(e.name));
  if (candidates.length === 0) {
    throw new AtlasError(
      'ENTRY_NOT_FOUND',
      '包内根目录没有 .html',
      '用 pack_atlas.py <图集目录> dist/ --zip 重新打包（html 必须落在包根，不能放子目录）',
    );
  }
  if (candidates.length > 1) {
    throw new AtlasError(
      'ENTRY_NOT_FOUND',
      `包内根目录有 ${candidates.length} 个 .html（${candidates.map((c) => c.name).join(', ')}），无法确定用哪个`,
      '一个包只放一份图集；多份请分库或分次上传',
    );
  }
  return candidates[0].name;
}

/** entry 内容校验：DOCTYPE / baked / 外链（设计 §3.3 第 8 步） */
function validateEntryHtml(html: Buffer, name: string): void {
  const head = html.subarray(0, 2048).toString('utf8');
  if (!/<!DOCTYPE html/i.test(head)) {
    throw new AtlasError('PACKAGE_INVALID', `entry 不是合法 HTML（缺 <!DOCTYPE html>）：${name}`);
  }
  const text = html.toString('utf8');
  if (!/"baked"\s*:\s*true/.test(text)) {
    throw new AtlasError(
      'PACKAGE_INVALID',
      'entry 缺少 baked:true（这是未烘焙产物，运行时会去找 atlas.config.json）',
      '用 pack_atlas.py 打包（不要上传 build 产物）',
    );
  }
  const external = text.match(EXTERNAL_RE);
  if (external) {
    throw new AtlasError(
      'PACKAGE_INVALID',
      `entry 含外链资源：${(external[1] || external[2]).slice(0, 80)}`,
      '图集必须离线自包含：把字体/图片内联或删掉外链后重新打包',
    );
  }
}

/** 读取包内可选 meta.json（根目录），非法则忽略并返回 null（不因元信息缺失阻断安装） */
function readInnerMeta(zip: ReturnType<typeof openZip>): Record<string, unknown> | null {
  const name = zip.entries.find((e) => e.name === 'meta.json')?.name;
  if (!name) return null;
  const entry = zip.entries.find((e) => e.name === name);
  if (!entry || entry.size > MAX_INNER_META_BYTES) return null;
  try {
    const raw = zip.read(name).toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * 从烘焙产物内嵌的 config JSON 提取元信息。
 *
 * 为什么需要它：`pack_atlas.py --zip` 只打 `atlas.html + MANIFEST.txt`，**不带 meta.json**
 * （实测：上传后标题变成库名、基线变成 `-@-`）。而烘焙后的 config 本来就内联在 html 里，
 * 从它取 title/branch/baseline 既零成本又永不与内容不同步——比要求生成侧额外带一份
 * meta.json 更可靠（少一处可能不同步的副本）。
 *
 * 只在文件前 512 KB 内找：config 一定在 head 附近，不必为元信息扫完整个大包。
 */
function readEmbeddedMeta(html: Buffer): Record<string, unknown> | null {
  /**
   * 用 indexOf 定位标记，而不是「只扫前 N KB」：每张 archify 图会在 head 注入约 90 KB
   * base64 字体，6 图包的 config 会被推到 1 MB 之后（本仓实测：254 KB 的包已在偏移 107 KB，
   * 按 512 KB 窗口取，图一多就会静默取不到元信息）。
   */
  const marker = Buffer.from('<script id="demo-config"');
  let at = html.indexOf(marker);
  if (at < 0) at = html.indexOf(Buffer.from('type="application/json"'));
  const start = at >= 0 ? at : 0;
  const win = html.subarray(start, Math.min(html.length, start + 2 * 1024 * 1024)).toString('utf8');
  const m = win.match(/<script[^>]*id="demo-config"[^>]*>([\s\S]*?)<\/script>/i)
    ?? win.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 生成侧用下划线命名（generated_at），平台用驼峰；两处都要认 */
const FIELD_ALIAS: Record<string, string> = { generatedAt: 'generated_at' };

/**
 * 安装一个图集包：校验 → 归档旧版 → 原子替换 → 写 meta。
 *
 * @param scope 目标库（调用方需自行保证库存在且非只读；内核只负责包与文件）
 * @param zipBuf 包内容
 */
export function installPackage(scope: string, zipBuf: Buffer, opts: InstallOptions = {}): InstallResult {
  // ── 1. 全部在内存里校验完 ──
  const zip = openZip(zipBuf);
  for (const e of zip.entries) safeJoin(atlasDir(scope), e.name); // 路径安全（不落盘，只判合法性）
  const entryName = pickRootHtml(zip.entries);
  const html = zip.read(entryName);
  if (html.length > MAX_ENTRY_BYTES) {
    throw new AtlasError('TOO_LARGE', `entry ${(html.length / 1024 / 1024).toFixed(1)} MB 超过上限 ${MAX_ENTRY_BYTES / 1024 / 1024} MB`, '减少视图数量后重打包');
  }
  validateEntryHtml(html, entryName);

  /**
   * 元信息合并（不是二选一）：包内 meta.json 覆盖内嵌 config 的同名字段（前者是显式声明），
   * 但缺失的字段各取所长——只给 title 的 meta.json 不该把 baseline 一起吞掉。
   */
  const fileMeta = readInnerMeta(zip);
  const embedded = readEmbeddedMeta(html);
  const inner = fileMeta || embedded ? { ...(embedded ?? {}), ...(fileMeta ?? {}) } : null;
  const pick = <K extends keyof NonNullable<InstallOptions['meta']>>(k: K): string => {
    const fromInner = str(inner?.[k as string]) || str(inner?.[FIELD_ALIAS[k as string] ?? '']);
    if (fromInner) return fromInner;
    const fromOpt = opts.meta?.[k];
    return typeof fromOpt === 'string' ? fromOpt : '';
  };
  // 图数：config 里没有 viewCount 字段，用 pages 的数量推（比留空更有用）
  const pages = inner?.pages;
  const viewCount = num(inner?.viewCount)
    ?? (pages && typeof pages === 'object' ? Object.keys(pages as Record<string, unknown>).length : undefined)
    ?? opts.meta?.viewCount;
  const meta: AtlasMeta = {
    title: pick('title') || scope,
    branch: pick('branch') || '-',
    baseline: pick('baseline') || '-',
    generatedAt: pick('generatedAt') || new Date().toISOString(),
    viewCount,
    entries: zip.entries,
    size: html.length,
    packageSize: zipBuf.length,
    sha256: createHash('sha256').update(html).digest('hex'),
    // 原 zip 的指纹：远程客户端不解包，只能算这个（见 AtlasMeta.packageSha256 注释）
    packageSha256: createHash('sha256').update(zipBuf).digest('hex'),
    uploadedAt: new Date().toISOString(),
    uploadedBy: opts.uploadedBy,
  };

  // ── 2. 落盘（全部在 try 里，失败清 tmp） ──
  // ⚠️ 一期无并发保护：两个 `ki atlas upload` 同时跑时，rename 保证「要么旧要么新」，
  // 但 archive 可能少一份或多一份。单用户 CLI 场景可接受；二期 HTTP 上传必须套
  // withScopeWriteLock（src/lib/scope-write-lock.ts），否则并发写会互相覆盖归档。
  const dir = atlasDir(scope);
  fs.mkdirSync(archiveDir(scope), { recursive: true });
  let archived = false;
  const stamp = Date.now();
  const tmpHtml = path.join(dir, `.tmp-${stamp}.html`);
  const tmpZip = path.join(dir, `.tmp-${stamp}.zip`);
  try {
    // 归档上一版（只留 1 版：先清旧 archive，再放新的，避免无限增长）
    if (fs.existsSync(packageZipPath(scope))) {
      // 归档名只计算一次：archiveFilePath 按当前时间生成，两次调用跨毫秒会得到不同名字，
      // 那样「保留名」与真实文件名不符，刚归档的文件会被当成旧版删掉（S-01 测试 ⑪ 抓到的真 bug）。
      const target = archiveFilePath(scope);
      fs.copyFileSync(packageZipPath(scope), target);
      archived = true;
      const keep = path.basename(target);
      for (const old of fs.readdirSync(archiveDir(scope))) {
        if (old !== keep) fs.rmSync(path.join(archiveDir(scope), old), { force: true });
      }
    }
    fs.writeFileSync(tmpHtml, html);
    fs.renameSync(tmpHtml, entryPath(scope));
    fs.writeFileSync(tmpZip, zipBuf);
    fs.renameSync(tmpZip, packageZipPath(scope));
  } catch (err) {
    for (const tmp of [tmpHtml, tmpZip]) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    }
    throw new AtlasError('CORRUPTED', `写入图集失败：${(err as Error).message}`);
  }

  writeJson(metaPath(scope), meta as unknown as Record<string, unknown>);
  return { meta, archived };
}

/** 读取状态：库不存在或没装图集都返回 exists:false（不建目录） */
export function readStatus(scope: string): AtlasStatus {
  if (!scopeDirExists(scope)) return { exists: false };
  try {
    const meta = readJson<AtlasMeta>(metaPath(scope));
    return meta ? { exists: true, meta } : { exists: false };
  } catch {
    // meta.json 损坏（半截写 / 手工改坏）视为未安装：页面走空态，而不是让一个坏 JSON
    // 把整页打成错误态（设计 S01 §3.8）。文件本身不删，便于排查。
    return { exists: false };
  }
}

/** 读取 entry html（下发用）；缺失或 0 字节视为损坏 */
export function readEntry(scope: string): Buffer {
  const file = entryPath(scope);
  if (!fs.existsSync(file)) {
    throw new AtlasError('NOT_FOUND', `${scope} 还没有上传图集`, '用 ki atlas upload 安装，或参考 /atlas 页面上的步骤');
  }
  const buf = fs.readFileSync(file);
  if (buf.length === 0) {
    throw new AtlasError('CORRUPTED', '图集文件为空（0 字节）', '重新上传：ki atlas upload --scope ' + scope + ' --file <zip>');
  }
  return buf;
}

/** 卸载：删 entry 与 meta，保留 archive（便于回滚） */
export function removePackage(scope: string): boolean {
  const dir = atlasDir(scope);
  if (!fs.existsSync(dir)) return false;
  const had = fs.existsSync(entryPath(scope)) || fs.existsSync(metaPath(scope));
  fs.rmSync(entryPath(scope), { force: true });
  fs.rmSync(metaPath(scope), { force: true });
  return had;
}
