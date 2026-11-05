import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KiConfig } from './config.js';
import { getVectorDimensionStatus } from './vector-client.js';

export type VectorDimensionSnapshotState = 'compatible' | 'mismatch' | 'unknown';

export interface VectorDimensionSnapshot {
  scope: string;
  state: VectorDimensionSnapshotState;
  configured: number;
  /**
   * 当前配置的 embedding 标识（REQ-20261016-002，总览页「嵌入模型」面板）。
   *
   * ★ 与 `configured` 同口径：**由读路径从 config 活读**，快照文件里即使写了也会被覆盖
   *   ⇒ 改配置后不会展示陈旧模型名（守 N-2：语义只表达"配置"，不表达"索引时实际使用的
   *   模型" —— 集合侧不持久化模型名，见 vector-client.buildCreateConfig）。
   */
  model: string;
  provider: string;
  baseURL: string;
  persisted?: number;
  /** 各向量字段索引完成度（0~1）；REQ-20261009-003 S-02 —— 0 表示索引未建（检索走暴力扫描） */
  indexCompleteness?: Record<string, number>;
  checkedAt?: number;
  error?: string;
  staleAfterMs: number;
}

/** 配置侧 embedding 标识（活读 config；快照文件里的同名值不参与判定） */
function configuredIdentity(
  config: Pick<KiConfig, 'embedding'>,
): Pick<VectorDimensionSnapshot, 'model' | 'provider' | 'baseURL'> {
  return {
    model: config.embedding.model,
    provider: config.embedding.provider,
    baseURL: config.embedding.baseURL,
  };
}

const SNAPSHOT_DIR = '.vector-status';
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

function snapshotPath(config: Pick<KiConfig, 'dataDir'>, scope: string): string {
  const key = crypto.createHash('sha256').update(scope).digest('hex');
  return path.join(config.dataDir, SNAPSHOT_DIR, `${key}.json`);
}

function safeError(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(^|[\s([{:：='"])(?:\/[^\s,;)}，。；'"]+|[A-Za-z]:\\[^\s,;)}，。；'"]+)/g, '$1[path]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

function writeSnapshot(config: Pick<KiConfig, 'dataDir'>, value: VectorDimensionSnapshot): void {
  const dir = path.join(config.dataDir, SNAPSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw Object.assign(new Error('向量维度快照目录不安全'), { code: 'VECTOR_STATUS_UNSAFE' });
  }
  const file = snapshotPath(config, value.scope);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

export async function refreshVectorDimensionSnapshot(
  config: KiConfig,
  scope: string,
): Promise<VectorDimensionSnapshot> {
  try {
    const status = await getVectorDimensionStatus(scope);
    const snapshot: VectorDimensionSnapshot = {
      scope: status.scope,
      state: status.compatible ? 'compatible' : 'mismatch',
      configured: status.configured,
      ...configuredIdentity(config),
      ...(status.persisted !== undefined ? { persisted: status.persisted } : {}),
      ...(status.indexCompleteness ? { indexCompleteness: status.indexCompleteness } : {}),
      checkedAt: Date.now(),
      staleAfterMs: SNAPSHOT_TTL_MS,
    };
    writeSnapshot(config, snapshot);
    return snapshot;
  } catch (error) {
    /*
     * ★ 保留上次确认的 `persisted`：refresh 失败只代表「这一次没查成」，不代表
     *   集合维度变了。视图页的「维度不一致」标记依赖 readPersistedVectorDimension
     *   读这个结构性事实；若在这里抹掉，一次偶发的锁冲突 / embedding 超时就会
     *   让已确认的 mismatch 静默消失（fail-loud 退化成静默漏标）。
     *   `state` 仍为 unknown，顶栏 banner / 总览面板的「未确认」语义不受影响
     *   （readVectorDimensionSnapshot 遇 state==='unknown' 一律返回 unknown()）。
     *   本机实证：2 份 unknown 快照（非法 scope）均无 persisted，正是该分支产物。
     */
    const previousPersisted = readPersistedVectorDimension(config, scope);
    const snapshot: VectorDimensionSnapshot = {
      scope,
      state: 'unknown',
      configured: config.embedding.dimension,
      ...configuredIdentity(config),
      ...(previousPersisted !== undefined ? { persisted: previousPersisted } : {}),
      checkedAt: Date.now(),
      error: safeError(error),
      staleAfterMs: SNAPSHOT_TTL_MS,
    };
    writeSnapshot(config, snapshot);
    return snapshot;
  }
}

/**
 * 读快照里「上次确认的集合 dense 维度」——**不看 TTL**。
 *
 * 为什么与 `readVectorDimensionSnapshot` 分开：后者表达「最近一次体检结论」，
 * 5 分钟没复查就降级 unknown 并丢掉 persisted，供顶栏 banner / 总览面板使用
 * （那两处必须诚实说明「没刚查过」）。而集合的 dense schema 维度是**结构性事实**：
 * 只有删集合、rebuild-vector 或重新导入才会变，这些路径都会 refresh 写新快照
 * （`restore.ts` / `import.ts` / 任务收尾）。把它按 5 分钟 TTL 丢掉，会让视图页
 * 的「维度不一致」标记在真实数据里一个都不出现 —— 本机实测 178 份快照全部过期，
 * 含一份 `persisted=4096 / configured=1024` 的真实 mismatch。
 *
 * ⚠ 代价：集合被外部手段重建却没刷新快照时可能误报 mismatch。按 fail-loud 取舍，
 *    宁可多提示并给重建命令，也不能把「语义检索静默跳过该库」吞掉；调用方应在
 *    hover 里说明「依据上次维度检查」并给出重新检查的出路。
 *
 * 安全校验与 `readVectorDimensionSnapshot` 同口径：非符号链接、≤8KB、scope 匹配；
 * persisted 额外要求**正整数**（维度只能是正整数，避免伪造/损坏值被当成 mismatch）。
 * 任何异常一律 `undefined`（调用方据此降级为「未确认」）。
 * 本函数只读文件，不打开 zvec、不加进程锁。
 */
export function readPersistedVectorDimension(
  config: Pick<KiConfig, 'dataDir' | 'embedding'>,
  scope: string,
): number | undefined {
  try {
    const file = snapshotPath(config, scope);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024) return undefined;
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as VectorDimensionSnapshot;
    const persisted = stored.persisted;
    if (stored.scope !== scope || typeof persisted !== 'number'
      || !Number.isInteger(persisted) || persisted <= 0) return undefined;
    return persisted;
  } catch {
    return undefined;
  }
}

/** Read only the last confirmed snapshot; this function never opens or probes zvec. */
export function readVectorDimensionSnapshot(
  config: Pick<KiConfig, 'dataDir' | 'embedding'>,
  scope: string,
): VectorDimensionSnapshot {
  const unknown = (): VectorDimensionSnapshot => ({
    scope,
    state: 'unknown',
    configured: config.embedding.dimension,
    ...configuredIdentity(config),
    staleAfterMs: SNAPSHOT_TTL_MS,
  });
  try {
    const file = snapshotPath(config, scope);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024) return unknown();
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as VectorDimensionSnapshot;
    if (stored.scope !== scope || !Number.isFinite(stored.configured)
      || (stored.persisted !== undefined && !Number.isFinite(stored.persisted))
      || !Number.isFinite(stored.checkedAt)) return unknown();
    if (Date.now() - stored.checkedAt! > SNAPSHOT_TTL_MS || stored.state === 'unknown') {
      return { ...unknown(), checkedAt: stored.checkedAt, ...(stored.error ? { error: stored.error } : {}) };
    }
    const persisted = stored.persisted;
    const state: VectorDimensionSnapshotState = persisted === undefined || persisted === config.embedding.dimension
      ? 'compatible'
      : 'mismatch';
    return {
      scope,
      state,
      configured: config.embedding.dimension,
      ...configuredIdentity(config),
      ...(persisted !== undefined ? { persisted } : {}),
      // S-02：索引完成度随快照返回（此前重建对象时会丢失该字段）
      ...(stored.indexCompleteness ? { indexCompleteness: stored.indexCompleteness } : {}),
      checkedAt: stored.checkedAt,
      staleAfterMs: SNAPSHOT_TTL_MS,
    };
  } catch {
    return unknown();
  }
}
