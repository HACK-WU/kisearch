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
  persisted?: number;
  checkedAt?: number;
  error?: string;
  staleAfterMs: number;
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
      ...(status.persisted !== undefined ? { persisted: status.persisted } : {}),
      checkedAt: Date.now(),
      staleAfterMs: SNAPSHOT_TTL_MS,
    };
    writeSnapshot(config, snapshot);
    return snapshot;
  } catch (error) {
    const snapshot: VectorDimensionSnapshot = {
      scope,
      state: 'unknown',
      configured: config.embedding.dimension,
      checkedAt: Date.now(),
      error: safeError(error),
      staleAfterMs: SNAPSHOT_TTL_MS,
    };
    writeSnapshot(config, snapshot);
    return snapshot;
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
      ...(persisted !== undefined ? { persisted } : {}),
      checkedAt: stored.checkedAt,
      staleAfterMs: SNAPSHOT_TTL_MS,
    };
  } catch {
    return unknown();
  }
}
