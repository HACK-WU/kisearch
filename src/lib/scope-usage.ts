/**
 * scope 级调用量统计（REQ-20261112-001 S-01）。
 *
 * 职责：把「一次请求对一个 scope 的一次读或写」按天累加，落一个单文件夹，
 * 供 `ki_scope_list` 按窗口聚合出「查询 / 写入 / 冷热」。
 *
 * 三条设计约束（改动前先读）：
 *
 * 1. **请求路径零 IO**：`recordScopeUsage()` 只做内存自增，flush 由定时器 / 阈值 /
 *    进程退出触发。同一 scope 的 coordinator 任务与引擎任务串行，请求里多一次同步
 *    磁盘写会放大队列积压（历史事故：`/api/doc/list` 25s 挂死）。
 * 2. **只有显式 `initScopeUsage()` 的进程才写**（daemon）。CLI 直连、单测、嵌入式
 *    调用不初始化 ⇒ 静默丢弃 ⇒ 天然单写者。**不要把 init 放进 `createMcpHttpServer`**：
 *    它是导出函数，单测也会创建，会把「单写者」前提当场打破。
 * 3. **失败也计入**（需求 D7）：埋点放在 coordinator 的 `finally`，鉴权/越权拒绝
 *    发生在入队之前，不计数。
 *
 * 存储形态：单 JSON 全量聚合（`{dataDir}/.ki-usage/scope-usage.json`），
 * 一次读全量 —— `ki_scope_list` 的读路径上有 162+ 个 scope，逐 scope 一个文件会
 * 直接拖垮列表（`src/scope.ts` 的文档计数缓存注释已明确读路径不为新增长效机制）。
 */
import fs from 'fs';
import path from 'path';
import type { KiConfig } from './config.js';
import { walWrite } from './wal.js';
import {
  MAX_USAGE_SCOPES,
  SCOPE_USAGE_NAME_RE,
  USAGE_FLUSH_INTERVAL_MS,
  USAGE_FLUSH_THRESHOLD,
  USAGE_RETENTION_DAYS,
} from './constants.js';

export type UsageKind = 'read' | 'write';

/** 窗口聚合结果（S-02 消费） */
export interface ScopeUsageSnapshot {
  read: number;
  write: number;
  /** 窗口内最近一次调用（毫秒）；0 = 窗口内无调用 */
  lastUsedAt: number;
  /**
   * 该 scope 首次被统计到的本地日期 `YYYY-MM-DD`；与窗口无关，供 S-02 算 coveredDays。
   * ★ 不随日桶裁剪回退 —— 否则老库会随天数推移"变成新库"。
   */
  firstSeen: string;
}

/** `[read, write]` 二元组：比 `{read,write}` 省约 3 倍体积（162 scope × 90 天） */
type DayBucket = [number, number];

interface ScopeRecord {
  firstSeen: string;
  lastUsedAt: number;
  days: Record<string, DayBucket>;
}

interface UsageFile {
  v: number;
  updatedAt: string;
  scopes: Record<string, ScopeRecord>;
}

const USAGE_VERSION = 1;
const USAGE_DIR_NAME = '.ki-usage';
const USAGE_FILE_NAME = 'scope-usage.json';

interface MemEntry {
  days: Map<string, DayBucket>;
  lastUsedAt: number;
  firstSeen: string;
}

interface UsageStore {
  dataDir: string;
  entries: Map<string, MemEntry>;
  pending: number;
  timer: NodeJS.Timeout | null;
}

let store: UsageStore | null = null;
let exitHookInstalled = false;
/** stderr 告警节流（每类消息 10 分钟最多一次），避免磁盘故障时刷屏 */
const lastWarnAt = new Map<string, number>();

export function getUsageStorePath(config: Pick<KiConfig, 'dataDir'>): string {
  return path.join(config.dataDir, USAGE_DIR_NAME, USAGE_FILE_NAME);
}

/**
 * 注入配置并拉起 flush 定时器（幂等）。
 *
 * ★ 调用点：`src/mcp-server.ts` 的 daemon 启动流程，`startDaemonRpcServer()` **之前**。
 *   不要放进 `src/lib/mcp-http.ts` —— 见文件头约束 2。
 */
export function initScopeUsage(config: Pick<KiConfig, 'dataDir'>): void {
  if (store && store.dataDir === config.dataDir) return;
  if (store?.timer) clearInterval(store.timer);

  store = {
    dataDir: config.dataDir,
    entries: new Map(),
    pending: 0,
    timer: null,
  };
  const timer = setInterval(() => flushScopeUsage(), USAGE_FLUSH_INTERVAL_MS);
  // unref：统计定时器不得阻止进程退出
  timer.unref?.();
  store.timer = timer;

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 正常退出补一次 flush（walWrite 是同步的，exit 钩子里可用）。
    // kill -9 / OOM 会丢最近一个周期的增量，属已声明的可接受精度。
    process.once('exit', () => {
      try { flushScopeUsage(); } catch { /* 退出路径不抛错 */ }
    });
  }
}

/**
 * 记一次调用（请求路径上调用）。**纯内存、O(1)、不抛错、不落盘**。
 *
 * 未调用 `initScopeUsage` 的进程直接丢弃（该进程不是统计写者）。
 * scope 名不合法（含视图名走同一字符集）时丢弃 —— 埋点取的是原始字面量，
 * 失败调用也会走到这里，不校验就等于给统计文件开了个无界写入口。
 */
export function recordScopeUsage(scope: string, kind: UsageKind, at: number = Date.now()): void {
  try {
    const s = store;
    if (!s) return;
    const name = typeof scope === 'string' ? scope.trim() : '';
    if (!SCOPE_USAGE_NAME_RE.test(name)) return;

    let entry = s.entries.get(name);
    if (!entry) {
      if (s.entries.size >= MAX_USAGE_SCOPES) {
        warnThrottled(
          'usage-scope-limit',
          `[kisearch] scope 用量统计已达 ${MAX_USAGE_SCOPES} 个 scope 名上限，新名字不再计入。`
          + ' 常见原因是请求里传了不存在/拼错的 scope。',
        );
        return;
      }
      entry = { days: new Map(), lastUsedAt: 0, firstSeen: formatLocalDate(at) };
      s.entries.set(name, entry);
    }

    const day = formatLocalDate(at);
    const bucket = entry.days.get(day) ?? [0, 0];
    if (kind === 'read') bucket[0] += 1;
    else bucket[1] += 1;
    entry.days.set(day, bucket);

    if (at > entry.lastUsedAt) entry.lastUsedAt = at;
    s.pending += 1;
    if (s.pending >= USAGE_FLUSH_THRESHOLD) flushScopeUsage();
  } catch {
    // 统计永不影响主链路：任何异常在此终止
  }
}

/** 立即落盘（定时器 / 阈值 / 进程退出调用）；未初始化或无事可做时为 no-op */
export function flushScopeUsage(): void {
  const s = store;
  if (!s || s.entries.size === 0) return;

  // 取走增量：flush 期间的新的记录会落进新的 entries，互不干扰
  const delta = s.entries;
  s.entries = new Map();
  s.pending = 0;

  try {
    const file = readUsageFile(s.dataDir) ?? emptyUsageFile();
    for (const [name, mem] of delta) {
      const rec = file.scopes[name] ?? { firstSeen: mem.firstSeen, lastUsedAt: 0, days: {} };
      if (mem.firstSeen < rec.firstSeen) rec.firstSeen = mem.firstSeen;
      for (const [day, bucket] of mem.days) {
        const cur = rec.days[day] ?? [0, 0];
        rec.days[day] = [cur[0] + bucket[0], cur[1] + bucket[1]];
      }
      if (mem.lastUsedAt > rec.lastUsedAt) rec.lastUsedAt = mem.lastUsedAt;
      file.scopes[name] = rec;
    }
    pruneUsageFile(file);
    file.updatedAt = new Date().toISOString();
    walWrite(getUsageStorePath({ dataDir: s.dataDir }), file);
    // 写盘后缓存必然过期，主动失效避免 30s 内读到旧值
    usageCache = null;
  } catch (err) {
    // 写失败：增量回填内存，下个周期重试（不丢、不抛、不阻塞）
    for (const [name, mem] of delta) {
      const cur = s.entries.get(name);
      if (!cur) { s.entries.set(name, mem); continue; }
      for (const [day, bucket] of mem.days) {
        const exist = cur.days.get(day) ?? [0, 0];
        cur.days.set(day, [exist[0] + bucket[0], exist[1] + bucket[1]]);
      }
      if (mem.lastUsedAt > cur.lastUsedAt) cur.lastUsedAt = mem.lastUsedAt;
      if (mem.firstSeen < cur.firstSeen) cur.firstSeen = mem.firstSeen;
    }
    warnThrottled('usage-flush-failed', `[kisearch] scope 用量统计写盘失败（下次重试）：${(err as Error).message}`);
  }
}

/** 测试用：丢弃进程内状态（等价于「从未初始化」） */
export function resetScopeUsageForTest(): void {
  if (store?.timer) clearInterval(store.timer);
  store = null;
  usageCache = null;
  lastWarnAt.clear();
}

/**
 * 读取并按窗口聚合；`null` = 统计不可用（文件缺失 / 损坏 / 读失败）。
 *
 * 返回的 key 是**原始 scope 名**（可能含视图名），视图摊分由 S-02 做 —— 埋点层
 * 不解析视图（那会把 `scope-view` 拖进调度层，且破坏 O(1)）。
 */
export function readScopeUsage(
  config: Pick<KiConfig, 'dataDir'>,
  windowDays: number,
): Map<string, ScopeUsageSnapshot> | null {
  const file = readUsageFileCached(config.dataDir);
  if (!file) return null;

  const cutoff = formatLocalDate(Date.now() - Math.max(1, windowDays - 1) * 86_400_000);
  const out = new Map<string, ScopeUsageSnapshot>();
  for (const [name, rec] of Object.entries(file.scopes)) {
    let read = 0;
    let write = 0;
    for (const [day, bucket] of Object.entries(rec.days)) {
      // YYYY-MM-DD 字典序 == 时间序，字符串比较即可
      if (day < cutoff) continue;
      read += bucket[0];
      write += bucket[1];
    }
    out.set(name, {
      read,
      write,
      // 窗口内一旦有调用，`rec.lastUsedAt` 必然也落在窗口内（它是「最近一次」），
      // 直接用精确毫秒值；不要用日桶 key 反推日期 —— 那会把它退化成「当天 0 点」。
      lastUsedAt: read + write > 0 ? rec.lastUsedAt : 0,
      firstSeen: rec.firstSeen,
    });
  }
  return out;
}

/**
 * 读取统计文件级元信息（`since` / `updatedAt`）；`null` = 统计不可用。
 *
 * `since` 取**全局最早的 firstSeen**（所有 scope 相同），用于「自 X 起统计」tooltip；
 * 每 scope 的覆盖天数另由 `firstSeen` 派生（见 S-02 的 `coveredDays`）。
 */
export function readScopeUsageMeta(
  config: Pick<KiConfig, 'dataDir'>,
): { since: string; updatedAt: string } | null {
  const file = readUsageFileCached(config.dataDir);
  if (!file) return null;
  let since = '';
  for (const rec of Object.values(file.scopes)) {
    if (!rec.firstSeen) continue;
    if (!since || rec.firstSeen < since) since = rec.firstSeen;
  }
  return {
    since: since || formatLocalDate(Date.now()),
    updatedAt: file.updatedAt || new Date().toISOString(),
  };
}

// ─── 内部：文件读写与缓存 ───

interface UsageCache {
  file: string;
  mtimeMs: number;
  size: number;
  parsed: UsageFile | null;
}
let usageCache: UsageCache | null = null;

/** 按 mtime+size 缓存解析结果；读路径上 162 个 scope 只解析一次 */
function readUsageFileCached(dataDir: string): UsageFile | null {
  const file = getUsageStorePath({ dataDir });
  try {
    const stat = fs.lstatSync(file);
    if (usageCache && usageCache.file === file
      && usageCache.mtimeMs === stat.mtimeMs && usageCache.size === stat.size) {
      return usageCache.parsed;
    }
    const parsed = readUsageFile(dataDir);
    usageCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, parsed };
    return parsed;
  } catch {
    // 文件不存在：不缓存，下次 flush 后自然出现
    usageCache = null;
    return null;
  }
}

/** 读取并校验；解析失败就地改名备份并从空开始（不阻断任何调用方） */
function readUsageFile(dataDir: string): UsageFile | null {
  const file = getUsageStorePath({ dataDir });
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as UsageFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.v !== 'number') return null;
    if (parsed.v > USAGE_VERSION) {
      // 更高版本：本进程不认识，按不可用降级（不尝试解析，避免误读字段）
      warnThrottled('usage-version', `[kisearch] scope 用量统计文件版本 ${parsed.v} 高于本程序支持（${USAGE_VERSION}），已按无数据降级。`);
      return null;
    }
    if (!parsed.scopes || typeof parsed.scopes !== 'object') return null;
    return parsed;
  } catch (err) {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}.bak`);
    } catch { /* 备份失败也要继续 */ }
    warnThrottled('usage-corrupt', `[kisearch] scope 用量统计文件损坏，已备份并从空开始：${(err as Error).message}`);
    return null;
  }
}

function emptyUsageFile(): UsageFile {
  return { v: USAGE_VERSION, updatedAt: new Date().toISOString(), scopes: {} };
}

/** 删 90 天前的日桶；`firstSeen` / `lastUsedAt` 保留。整条删除的条件是「已无任何日桶」 */
function pruneUsageFile(file: UsageFile): void {
  const cutoff = formatLocalDate(Date.now() - (USAGE_RETENTION_DAYS - 1) * 86_400_000);
  for (const [name, rec] of Object.entries(file.scopes)) {
    for (const day of Object.keys(rec.days)) {
      if (day < cutoff) delete rec.days[day];
    }
    if (Object.keys(rec.days).length === 0) {
      // 90 天内无任何调用：整条移除（死 scope 不占位；复活时 firstSeen 重新开始，语义正确）
      delete file.scopes[name];
    }
  }

  /*
   * key 数上限：`recordScopeUsage` 里的 `entries.size` 只统计「自上次 flush 以来的新增」，
   * flush 后清零 ⇒ 它约束不到**文件里累积的总 key 数**。埋点取的是 `args.scope` 原始
   * 字面量且失败调用也计入，一个循环发不同拼错 scope 名的客户端每 30s 就能加一批新 key。
   * 所以必须在落盘侧按总 key 数兜底：超出时保留最近使用的，其余丢弃。
   */
  const names = Object.keys(file.scopes);
  if (names.length > MAX_USAGE_SCOPES) {
    names.sort((a, b) => file.scopes[b].lastUsedAt - file.scopes[a].lastUsedAt);
    const keep = new Set(names.slice(0, MAX_USAGE_SCOPES));
    for (const name of names) {
      if (!keep.has(name)) delete file.scopes[name];
    }
    warnThrottled(
      'usage-scope-limit-file',
      `[kisearch] scope 用量统计的 scope 名超过 ${MAX_USAGE_SCOPES} 个，已按最近使用时间裁剪。`
      + ' 常见原因是请求里传了不存在/拼错的 scope。',
    );
  }
}

// ─── 内部：日期与告警 ───

/** 本地时区日期键（与用户看到的「近 N 天」一致；跨时区部署会以服务器本地时区切分） */
export function formatLocalDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function warnThrottled(key: string, message: string): void {
  const now = Date.now();
  const last = lastWarnAt.get(key) ?? 0;
  if (now - last < 10 * 60_000) return;
  lastWarnAt.set(key, now);
  process.stderr.write(`${message}\n`);
}
