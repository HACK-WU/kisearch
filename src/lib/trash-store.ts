/**
 * 回收站 · 存储层（REQ-20261113-004 · S-04）
 *
 * 落点：`{dataDir}/{scope}/.trash/{group}/{dirName}/`
 *   ├─ meta.json    TrashItem（含 relationSnapshot）
 *   ├─ content.md   原文（local KB 的 Markdown）
 *   └─ assets/…     附件（若存在）
 *
 * 三条硬约束：
 *   1. **必须落在 scope 数据目录内** —— 才能自动进 `ki backup` 快照（Q2 归零）。
 *      绝不能放 `{sourceDir}/.ki/trash/`：那会在用户 wiki 仓库凭空造目录（`archive.md:213` 前例）；
 *   2. **回收站内的文档永不参与检索** —— 入站前已摘四类索引，恢复时必须重建；
 *   3. **同名重复删除不覆盖** —— 目录名加时间戳后缀，两份都留（恢复时按最新优先）。
 *
 * 本层只做读写与路径，业务语义（何时入站、期限重算、索引重建）在 `trash-service.ts`。
 */

import fs from 'fs';
import path from 'path';
import { getKbDir, validateScope } from './scope.js';
import { readJson, writeJson } from './store.js';
import { DEFAULT_TRASH_SETTINGS, TRASH_KEEP_DAYS, type TrashKeepDays, type TrashExpireAction, type TrashSettings } from './governance-store.js';
import type { Relation } from './scoring.js';

export type TrashReason = 'temp-expired' | 'event-closed' | 'event-expired' | 'manual';

/** 入站时不需要保存的索引字段：恢复必须重建，沿用旧 ID 会与残留索引撞车 */
type SnapshotOmit = 'memoryIds' | 'memoryId' | 'ftsIds' | 'ftsLocators' | 'ftsIndexComplete';

export interface TrashItem {
  scope: string;
  group: string;
  name: string;
  reason: TrashReason;
  deletedAt: number;
  /** 站内到期时间（deletedAt + keepDays） */
  expiresAt: number;
  /**
   * 原期限长度（天）：只能取 `relationSnapshot.ttlDays`。
   * **不得**用 `expiresAt - now` 反推 —— 文档正是过期后才进站的，那一刻差值 ≤ 0。
   */
  ttlDays: number;
  /** ttlDays 是回退值（存量条目无该字段）时为 true */
  ttlAssumed: boolean;
  restoreCount: number;
  /** 目录名（同名重复删除时带 `__yyyyMMddHHmmss` 后缀） */
  dirName: string;
  hasAssets: boolean;
  sizeBytes: number;
  relationSnapshot?: Omit<Relation, SnapshotOmit>;
}

export function getTrashRoot(scope: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), '.trash');
}

export function getTrashSettingsPath(scope: string): string {
  return path.join(getTrashRoot(scope), '_settings.json');
}

/** 读取回收站设置；文件不存在 → 内存缺省（不创建文件） */
export function readTrashSettings(scope: string): TrashSettings {
  const raw = readJson<Partial<TrashSettings>>(getTrashSettingsPath(scope));
  if (!raw) return { ...DEFAULT_TRASH_SETTINGS };
  const keepDays = TRASH_KEEP_DAYS.includes(raw.keepDays as TrashKeepDays)
    ? (raw.keepDays as TrashKeepDays)
    : DEFAULT_TRASH_SETTINGS.keepDays;
  const expireAction: TrashExpireAction = raw.expireAction === 'notify' ? 'notify' : 'purge';
  return { keepDays, expireAction };
}

export function writeTrashSettings(scope: string, settings: TrashSettings): TrashSettings {
  const next: TrashSettings = { ...settings };
  fs.mkdirSync(getTrashRoot(scope), { recursive: true });
  writeJson(getTrashSettingsPath(scope), next as unknown as Record<string, unknown>);
  return next;
}

/** group 路径安全化：禁止空段与 `..`（group 已由 resolveGroupPath 校验，这里再兜一层） */
function safeGroupSegments(group: string): string[] {
  const segs = group.split('/').map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    if (seg === '.' || seg === '..' || seg.includes('\0')) {
      throw new Error(`非法的 Group 路径片段：${seg}`);
    }
  }
  return segs;
}

function trashItemDir(scope: string, group: string, dirName: string): string {
  return path.join(getTrashRoot(scope), ...safeGroupSegments(group), dirName);
}

/** 目录名去重：同名已存在时加时间戳后缀，两份都保留 */
function resolveDirName(scope: string, group: string, relation: string, now: number): string {
  const base = relation;
  const candidate = path.join(getTrashRoot(scope), ...safeGroupSegments(group), base);
  if (!fs.existsSync(candidate)) return base;
  // 精确到毫秒：同一秒内连续两次删除（批量/脚本）如果只到秒会撞名并覆盖前一份 meta
  const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  return `${base}__${stamp}`;
}

export interface WriteTrashArgs {
  scope: string;
  group: string;
  relation: string;
  reason: TrashReason;
  now: number;
  /** 原文（local KB 内容）；空串表示无原文可留 */
  content: string;
  /** 附件目录；存在则整体复制 */
  assetsDir?: string;
  relationSnapshot?: Relation;
  keepDays: number;
  restoreCount?: number;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch { /* 文件消失让整体统计偏小，不影响正确性 */ }
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * 写入一条回收站条目。
 *
 * 调用方必须已持 scope 写锁，且**必须在本步骤成功后才允许删除任何数据**：
 * 快照失败即中止删除（见 S-04 §3.1 失败语义）。
 */
export function writeTrashItem(args: WriteTrashArgs): TrashItem {
  const { scope, group, relation, reason, now, content, assetsDir, relationSnapshot, keepDays } = args;
  const dirName = resolveDirName(scope, group, relation, now);
  const target = trashItemDir(scope, group, dirName);

  fs.mkdirSync(target, { recursive: true });

  if (content) {
    fs.writeFileSync(path.join(target, 'content.md'), content, 'utf-8');
  }

  let hasAssets = false;
  if (assetsDir && fs.existsSync(assetsDir)) {
    const dest = path.join(target, 'assets');
    fs.cpSync(assetsDir, dest, { recursive: true });
    hasAssets = true;
  }

  // 快照去掉索引入口字段：恢复时必须重建，沿用旧 ID 会与残留索引撞车
  let snapshot: TrashItem['relationSnapshot'];
  if (relationSnapshot) {
    const { memoryIds: _mi, memoryId: _m, ftsIds: _f, ftsLocators: _fl, ftsIndexComplete: _fc, ...rest } = relationSnapshot;
    snapshot = rest;
  }

  const ttlDays = snapshot?.ttlDays ?? 0;
  const item: TrashItem = {
    scope,
    group,
    name: relation,
    reason,
    deletedAt: now,
    expiresAt: now + keepDays * 86_400_000,
    ttlDays,
    ttlAssumed: ttlDays === 0,
    restoreCount: args.restoreCount ?? 0,
    dirName,
    hasAssets,
    sizeBytes: dirSizeBytes(target),
    ...(snapshot ? { relationSnapshot: snapshot } : {}),
  };

  writeJson(path.join(target, 'meta.json'), item as unknown as Record<string, unknown>);
  return item;
}

export interface TrashEntry extends TrashItem {
  /** 目录绝对路径（内部用，不下发 API） */
  dir: string;
}

/** 列出回收站条目（按 deletedAt 倒序） */
export function listTrash(scope: string, opts: { reason?: TrashReason; limit?: number; offset?: number } = {}): {
  items: TrashEntry[];
  total: number;
} {
  const root = getTrashRoot(scope);
  const out: TrashEntry[] = [];

  const walk = (dir: string, groupSegs: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (fs.existsSync(path.join(child, 'meta.json'))) {
        try {
          const item = readJson<TrashItem>(path.join(child, 'meta.json'));
          if (item && typeof item.name === 'string') {
            out.push({ ...item, group: item.group || groupSegs.join('/'), dir: child });
          }
        } catch (err) {
          console.warn(`[trash] 跳过损坏条目 ${child}: ${(err as Error).message}`);
        }
      } else {
        walk(child, [...groupSegs, e.name]);
      }
    }
  };

  walk(root, []);
  const filtered = opts.reason ? out.filter((i) => i.reason === opts.reason) : out;
  filtered.sort((a, b) => b.deletedAt - a.deletedAt);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : filtered.length;
  return { items: filtered.slice(offset, offset + limit), total: filtered.length };
}

export interface TrashContent {
  item: TrashItem;
  content: string;
  assetsDir: string;
  dir: string;
}

export function readTrashItem(scope: string, group: string, dirName: string): TrashContent | null {
  const dir = trashItemDir(scope, group, dirName);
  let item: TrashItem | null;
  try {
    item = readJson<TrashItem>(path.join(dir, 'meta.json'));
  } catch (err) {
    throw new Error(`回收站条目损坏（${group}/${dirName}）：${(err as Error).message}`);
  }
  if (!item) return null;
  let content = '';
  try {
    content = fs.readFileSync(path.join(dir, 'content.md'), 'utf-8');
  } catch { /* 无原文（只删了元数据的历史条目） */ }
  return { item, content, assetsDir: path.join(dir, 'assets'), dir };
}

/** 物理删除条目目录；不存在时返回 false（幂等） */
export function removeTrashItem(scope: string, group: string, dirName: string): boolean {
  const dir = trashItemDir(scope, group, dirName);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 更新 meta（恢复次数 +1 等）；目录不存在返回 null */
export function updateTrashItemMeta(scope: string, group: string, dirName: string, patch: Partial<TrashItem>): TrashItem | null {
  const dir = trashItemDir(scope, group, dirName);
  const current = readJson<TrashItem>(path.join(dir, 'meta.json'));
  if (!current) return null;
  const next: TrashItem = { ...current, ...patch };
  writeJson(path.join(dir, 'meta.json'), next as unknown as Record<string, unknown>);
  return next;
}

/** 已到期条目（purgeExpired 的输入；纯读） */
export function findExpiredTrash(scope: string, now: number): TrashEntry[] {
  return listTrash(scope).items.filter((i) => i.expiresAt <= now);
}
