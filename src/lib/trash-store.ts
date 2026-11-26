/**
 * 回收站 · 存储层（REQ-20261113-004 · S-04 ／ REQ-20261123-005 · S02）
 *
 * 两种条目共存于同一棵树，靠 `TrashItem.kind` 区分：
 *
 *   doc 条目：`{kbDir}/{scope}/.trash/{group}/{dirName}/`
 *     ├─ meta.json      TrashItem（kind 缺省 = doc，含 relationSnapshot）
 *     ├─ content.md     原文（local KB 的 Markdown）
 *     └─ assets/…       附件（若存在；这是 **group 级共享目录** 的整目录副本）
 *
 *   group 条目：`{kbDir}/{scope}/.trash/{被删组路径}/__group__<stamp>/`
 *     ├─ meta.json      TrashItem（kind='group'，含 groupSnapshot 统计）
 *     ├─ assets.json    `[{ group, dir }]` 附件清单
 *     ├─ assets/<序号>/  每个有附件的 group 一份。**绝不按文档复制**：getAssetsDir()
 *     │                 返回的是 group 级共享目录（同组所有文档共用），按篇复制会
 *     │                 N 倍膨胀，写满盘后 fail-closed 会让**所有删除都失效**。
 *     └─ docs/NNNN/     `{ doc.json, content.md }`；身份（group / name）写在 doc.json
 *
 * 四条硬约束：
 *   1. **必须落在 scope 数据目录内** —— 才能自动进 `ki backup` 快照（Q2 归零）。
 *      绝不能放 `{sourceDir}/.ki/trash/`：那会在用户 wiki 仓库凭空造目录（`archive.md:213` 前例）；
 *   2. **回收站内的文档永不参与检索** —— 入站前已摘四类索引，恢复时必须重建；
 *   3. **同名重复删除不覆盖** —— 目录名加时间戳后缀，两份都留（恢复时按最新优先）；
 *   4. **条目坐标恒为 `(group, dirName)`** —— list / restore / purge 全靠这一对定位，
 *      不引入新 ID；`kind` 缺省按 `'doc'` 解释且**不写回**磁盘（存量兼容）。
 *
 * list 的 walk 语义：目录含 `meta.json` 即视为条目并**停止递归**。因此 group 条目
 * 天然不会被误读成 `docs/` 下的文档，也不需要另开一个回收站根目录。
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

/** 条目类型：文档快照 / 组快照。缺省按 'doc' 解释（存量条目无该字段） */
export type TrashKind = 'doc' | 'group';

/** 入站时不需要保存的索引字段：恢复必须重建，沿用旧 ID 会与残留索引撞车 */
type SnapshotOmit = 'memoryIds' | 'memoryId' | 'ftsIds' | 'ftsLocators' | 'ftsIndexComplete';

export interface TrashItem {
  /** 条目类型；存量条目无该字段，读侧补成 'doc'，**不写回** */
  kind?: TrashKind;
  scope: string;
  /** doc：relation 所属 group；group：被删组自身的规范路径 */
  group: string;
  /** doc：relation 名；group：组路径最后一段 */
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
  /** 目录名（同名重复删除时带 `__yyyyMMddHHmmss` 后缀；group 条目固定 `__group__` 前缀） */
  dirName: string;
  hasAssets: boolean;
  sizeBytes: number;
  /** 仅 doc */
  relationSnapshot?: Omit<Relation, SnapshotOmit>;
  /** 仅 group：组快照统计；每篇的明细在 `docs/NNNN/doc.json` */
  groupSnapshot?: GroupSnapshot;
}

/** 组条目的组级统计（明细不在此，避免 list 时读大文件） */
export interface GroupSnapshot {
  version: 1;
  /** 被删组规范路径 */
  path: string;
  /** 自身 + 全部子组（含空组）—— 恢复时要逐个重建树节点 */
  groups: string[];
  /** = docs/ 子目录数（部分恢复后收缩） */
  docCount: number;
  /** 附件清单：每个有附件的 group 一条，dir 是 assets/ 下的序号目录 */
  assets: Array<{ group: string; dir: string }>;
}

/**
 * `docs/NNNN/doc.json`。
 *
 * `source` 决定恢复能力，三档来自「篇目集合取 relations 分片键 ∪ KB 键并集」这条规则：
 *   both       —— 分片与 KB 都有，完整恢复
 *   shard-only —— 只有元数据、读不到正文（残壳），恢复后无正文
 *   kb-only    —— 只有正文、分片里没有 relation（元数据不一致），恢复为最小元数据
 */
export interface GroupSnapshotDoc {
  group: string;
  name: string;
  source: 'both' | 'shard-only' | 'kb-only';
  /** 正文字节数（无正文为 0） */
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

/**
 * 条目目录名是否合法（单段，不得逃出 `{group}/`）。
 *
 * `group` 由 {@link safeGroupSegments} 兜底，但 `dirName` 直接来自 HTTP body
 * （restore / purge）与 query（trash/content），此前没有任何校验：`path.join` 会把
 * `../` 归一化掉 ⇒ 可用 `dirName: "../../../../tmp/x"` 对宿主机任意已存在目录执行
 * `rmSync(recursive)`（事件 #80）。这里必须是**白名单式单段判定**，而不是"拦某些串"。
 */
export function isSafeTrashDirName(dirName: string): boolean {
  /*
   * 只拒**空串**，不拒「全空格」：空串会让 `path.join` 落到 group 目录（等价 `.`，
   * 但语义上不是调用方要的条目）；而全空格是合法目录名（relation 名允许空格），
   * 一并拒掉同样会造成「删不掉也恢复不了」的死锁。
   */
  if (!dirName) return false;
  /**
   * 只拦 `..`，**不拦 `.`**：`..` 会逃出当前 group（这是要防的），而 `.` 只归一到
   * group 目录本身。relation 名恰为 `.` 是合法的（`isUnsafeRelationName` 只拦 `/`、`\`、`..`），
   * 此时条目目录名就是 `.` —— 一并拒掉会让这类条目**既恢复不了也删不掉**（死锁）。
   *
   * `.` 的退化语义（数据模型固有、非本处引入）：该条目的目录就是 group 的回收站目录，
   * `listTrash` 见到 meta.json 即停止递归 ⇒ 同组的其他条目会被它"吞"掉、不在列表里出现。
   * 放行它只是为了「已存在的那条还能读/能恢复/能删」。
   */
  if (dirName === '..') return false;
  // 分隔符与 NUL：任何一段都可能把路径搬出当前 group
  if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('\0')) return false;
  return true;
}

function trashItemDir(scope: string, group: string, dirName: string): string {
  // 纵深防御：HTTP 三入口已前置判过（返回 400），这里再兜一层，避免新调用方绕过
  if (!isSafeTrashDirName(dirName)) {
    throw new Error(`非法的回收站条目名：${dirName}`);
  }
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
  /** 附件目录；存在则整体复制（未给 `assetRels` 时的旧行为） */
  assetsDir?: string;
  /**
   * 只复制这些相对路径的附件（`assetRels` 来自文档正文的引用，见 #102）。
   *
   * 给了就**不再整组复制**：删一篇只备份它用到的图。显式空数组 = 这篇没有图，
   * 结果与「没有 assetsDir」一致。传 `undefined` 才退回全量复制（组快照等旧调用方）。
   */
  assetRels?: string[];
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
  const { scope, group, relation, reason, now, content, assetsDir, assetRels, relationSnapshot, keepDays } = args;
  const dirName = resolveDirName(scope, group, relation, now);
  const target = trashItemDir(scope, group, dirName);

  fs.mkdirSync(target, { recursive: true });

  if (content) {
    fs.writeFileSync(path.join(target, 'content.md'), content, 'utf-8');
  }

  let hasAssets = false;
  if (assetsDir && fs.existsSync(assetsDir)) {
    const dest = path.join(target, 'assets');
    if (assetRels === undefined) {
      // 旧行为（组快照等）：整目录复制
      fs.cpSync(assetsDir, dest, { recursive: true });
      hasAssets = true;
    } else if (assetRels.length > 0) {
      /**
       * 按引用复制（#102）：单篇删除只备份它用到的图。
       *
       * 为什么不会丢恢复能力：其它图从未被删除，仍在 `{group}/assets/` 里；
       * 恢复时 `restoreFromTrash` 把条目内的副本合并复制回去（同名覆盖，幂等）。
       */
      const root = path.resolve(assetsDir);
      for (const rel of assetRels) {
        const src = path.resolve(root, rel);
        if (src !== root && !src.startsWith(root + path.sep)) continue; // 越界：跳过
        if (!fs.existsSync(src)) continue;
        const dst = path.join(dest, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        hasAssets = true;
      }
    }
  }

  // 快照去掉索引入口字段：恢复时必须重建，沿用旧 ID 会与残留索引撞车
  let snapshot: TrashItem['relationSnapshot'];
  if (relationSnapshot) {
    const { memoryIds: _mi, memoryId: _m, ftsIds: _f, ftsLocators: _fl, ftsIndexComplete: _fc, ...rest } = relationSnapshot;
    snapshot = rest;
  }

  /**
   * 缺省回退 7 天，**不能是 0**（challenger C2）：
   * 0 天会让 `expiresAt = now + 0` —— 条目进站即到期，下次清理直接删除，
   * 恢复出来也会立刻再过期。设计要求是「回退默认保留天数并标 ttlAssumed」。
   */
  const fallbackDays = 7;
  const assumedTtl = typeof snapshot?.ttlDays !== 'number' || snapshot.ttlDays <= 0;
  const ttlDays = assumedTtl ? fallbackDays : snapshot!.ttlDays!;
  const item: TrashItem = {
    scope,
    group,
    name: relation,
    reason,
    deletedAt: now,
    expiresAt: now + keepDays * 86_400_000,
    ttlDays,
    ttlAssumed: assumedTtl,
    restoreCount: args.restoreCount ?? 0,
    dirName,
    hasAssets,
    sizeBytes: dirSizeBytes(target),
    ...(snapshot ? { relationSnapshot: snapshot } : {}),
  };

  writeJson(path.join(target, 'meta.json'), item as unknown as Record<string, unknown>);
  return item;
}

// ─── 组条目（REQ-20261123-005 · S02）──────────────────────────────────────

export interface GroupTrashDocInput {
  group: string;
  name: string;
  source: GroupSnapshotDoc['source'];
  /** 读不到正文时省略（shard-only 残壳：只剩元数据） */
  content?: string;
  relationSnapshot?: Relation;
}

export interface WriteGroupTrashArgs {
  scope: string;
  /** 被删组规范路径 */
  group: string;
  reason: TrashReason;
  now: number;
  /** 自身 + 全部子组（含空组）—— 恢复时逐个重建树节点 */
  groups: string[];
  docs: GroupTrashDocInput[];
  /** 只传真实存在的附件目录，且**每个 group 一份**（附件是 group 级共享目录） */
  assets: Array<{ group: string; assetsDir: string }>;
  keepDays: number;
}

/** 组条目目录名：`__group__` + 毫秒时间戳，与文档条目、历史组条目互不覆盖 */
function groupDirName(now: number): string {
  return `__group__${new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}`;
}

/** 索引字段不落快照：恢复必须重建，沿用旧 ID 会与残留索引撞车 */
function stripSnapshot(snapshot: Relation | undefined): Omit<Relation, SnapshotOmit> | undefined {
  if (!snapshot) return undefined;
  const { memoryIds: _mi, memoryId: _m, ftsIds: _f, ftsLocators: _fl, ftsIndexComplete: _fc, ...rest } = snapshot;
  return rest;
}

/**
 * 写入组条目（REQ-20261123-005 · S02）。调用方必须已持 scope 写锁。
 *
 * 写入顺序**刻意与可观测性绑定**（写反了就是坑）：
 *   ① 先写 `meta.json` 骨架 —— 之后任何中途失败都留下一个「可见但可能不完整」的条目，
 *      用户能在回收站里彻底删除它；反过来（先写 docs、最后写 meta）会留下一堆
 *      `listTrash` 看不见、用户也删不掉的磁盘垃圾。
 *   ② 逐篇写 `docs/NNNN/`
 *   ③ 逐 group 复制附件到 `assets/<序号>/` 并写 `assets.json`
 *   ④ 回填 `docCount` / `sizeBytes`（**累加得到，不做事后递归统计**：文件数是单篇的
 *      几十上百倍，递归扫描在写锁内执行会拖住该库全部写操作）
 *
 * 任一步失败：本函数**自行回滚**（删掉整个组条目目录）并抛出，调用方据此中止删除，
 * 保证「没备份成功就绝不删数据」。
 */
export function writeGroupTrashItem(args: WriteGroupTrashArgs): TrashItem {
  const { scope, group, reason, now, groups, docs, assets, keepDays } = args;
  const dirName = groupDirName(now);
  const target = trashItemDir(scope, group, dirName);
  const segs = group.split('/').filter(Boolean);

  const item: TrashItem = {
    kind: 'group',
    scope,
    group,
    name: segs[segs.length - 1] ?? group,
    reason,
    deletedAt: now,
    expiresAt: now + keepDays * 86_400_000,
    /** 组条目没有「原期限」概念，保留期即其生命周期；标 ttlAssumed 免得恢复侧按文档口径续期 */
    ttlDays: keepDays,
    ttlAssumed: true,
    restoreCount: 0,
    dirName,
    hasAssets: false,
    sizeBytes: 0,
    groupSnapshot: { version: 1, path: group, groups, docCount: 0, assets: [] },
  };

  try {
    fs.mkdirSync(target, { recursive: true });
    writeJson(path.join(target, 'meta.json'), item as unknown as Record<string, unknown>);

    let sizeBytes = 0;
    docs.forEach((doc, index) => {
      const dir = path.join(target, 'docs', String(index + 1).padStart(4, '0'));
      fs.mkdirSync(dir, { recursive: true });
      const snapshot = stripSnapshot(doc.relationSnapshot);
      const record: GroupSnapshotDoc = {
        group: doc.group,
        name: doc.name,
        source: doc.source,
        sizeBytes: doc.content ? Buffer.byteLength(doc.content, 'utf-8') : 0,
        ...(snapshot ? { relationSnapshot: snapshot } : {}),
      };
      writeJson(path.join(dir, 'doc.json'), record as unknown as Record<string, unknown>);
      if (doc.content) fs.writeFileSync(path.join(dir, 'content.md'), doc.content, 'utf-8');
      sizeBytes += record.sizeBytes;
    });

    const manifest: Array<{ group: string; dir: string }> = [];
    assets.forEach((entry, index) => {
      if (!fs.existsSync(entry.assetsDir)) return;
      const dir = String(index + 1).padStart(4, '0');
      fs.cpSync(entry.assetsDir, path.join(target, 'assets', dir), { recursive: true });
      manifest.push({ group: entry.group, dir });
      // 统计**源**目录一次即可；复制后再递归一遍是白花写锁时间
      sizeBytes += dirSizeBytes(entry.assetsDir);
    });
    if (manifest.length > 0) {
      fs.writeFileSync(path.join(target, 'assets.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    }

    const next: TrashItem = {
      ...item,
      hasAssets: manifest.length > 0,
      sizeBytes,
      groupSnapshot: { ...item.groupSnapshot!, docCount: docs.length, assets: manifest },
    };
    writeJson(path.join(target, 'meta.json'), next as unknown as Record<string, unknown>);
    return next;
  } catch (err) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch { /* 回滚失败：调用方会在 warnings 里提示手动彻底删除 */ }
    throw err;
  }
}

export interface GroupSnapshotDocEntry {
  /** `docs/` 下的目录名（如 `0001`） */
  dirName: string;
  dir: string;
  /** `doc.json` 缺失或损坏时为 null，恢复侧计入 failed 而不是抛错 */
  doc: GroupSnapshotDoc | null;
  content: string;
}

/** 遍历组条目的 `docs/`（不通过 trashItemDir 逐篇寻址，直接扫目录） */
export function readGroupSnapshotDocs(scope: string, group: string, dirName: string): GroupSnapshotDocEntry[] {
  const root = path.join(trashItemDir(scope, group, dirName), 'docs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: GroupSnapshotDocEntry[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let doc: GroupSnapshotDoc | null = null;
    try {
      doc = readJson<GroupSnapshotDoc>(path.join(dir, 'doc.json'));
    } catch {
      doc = null;
    }
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir, 'content.md'), 'utf-8');
    } catch { /* shard-only 残壳没有正文 */ }
    out.push({ dirName: e.name, dir, doc, content });
  }
  return out;
}

/** 读组条目的附件清单；`assets.json` 缺失或损坏时返回空数组（降级，不抛错） */
export function readGroupSnapshotAssets(
  scope: string,
  group: string,
  dirName: string,
): Array<{ group: string; dir: string; absDir: string }> {
  const base = trashItemDir(scope, group, dirName);
  const raw = readJson<unknown>(path.join(base, 'assets.json'));
  if (!Array.isArray(raw)) return [];
  const out: Array<{ group: string; dir: string; absDir: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const g = (entry as { group?: unknown }).group;
    const d = (entry as { dir?: unknown }).dir;
    if (typeof g !== 'string' || typeof d !== 'string') continue;
    const absDir = path.join(base, 'assets', d);
    if (!fs.existsSync(absDir)) continue;
    out.push({ group: g, dir: d, absDir });
  }
  return out;
}

export interface TrashEntry extends TrashItem {
  /** 目录绝对路径（内部用，不下发 API） */
  dir: string;
  /**
   * 快照里是否有正文（**读侧算出来的，不落盘**）。
   *
   * 为什么必须由后端给：`sizeBytes` 是**入站瞬间**的目录字节快照（此刻还没写 meta.json），
   * 入站后 content.md 丢失的条目该值停在旧值 >0，拿它判「正文缺失」会漏（事件 #81）。
   * 正文存在性只有读 `content.md` 才知道，所以列表阶段就一并算出来。
   *
   * 仅 `kind==='doc'` 有值；组条目没有单篇正文（`docs/NNNN/content.md` 才是正文），故缺省。
   */
  hasContent?: boolean;
}

/**
 * 条目目录里是否有**可恢复的正文**：`content.md` 存在且不是纯空白。
 *
 * 口径必须与 `moveToTrash` 的入站判定一致（那里用 `!content.trim()` 拒绝空正文），
 * 否则会出现「列表说可恢复 → 恢复才报错」的两套标准。
 *
 * 为什么只读前 4KB：列表要给最多 200 条各判一次（回收站页 / diagnostics），
 * 整篇读盘实测 200×100KB ≈ 96ms，占满一页的响应时间；只读头部把常态压到几毫秒。
 * 判据本身不变 —— 头部非空白即「有正文」；头部全空白时，只有**大于一个块**的
 * 文件才需要整篇复查（正文前面垫了 4KB 空白这种极端形状），否则必为空白。
 */
const CONTENT_PROBE_CHUNK = 4096;

function hasRestorableContent(itemDir: string): boolean {
  const contentPath = path.join(itemDir, 'content.md');
  let size: number;
  try {
    size = fs.statSync(contentPath).size;
  } catch {
    return false; // 文件不存在：正文快照缺失
  }
  if (size === 0) return false;

  const headLen = Math.min(size, CONTENT_PROBE_CHUNK);
  try {
    const buf = Buffer.alloc(headLen);
    const fd = fs.openSync(contentPath, 'r');
    try {
      fs.readSync(fd, buf, 0, headLen, 0);
    } finally {
      fs.closeSync(fd);
    }
    // 头部被截断在多字节字符中间时会得到替换字符（非空白）→ 判为有正文，不会误判成坏条目
    if (buf.toString('utf-8').trim().length > 0) return true;
  } catch {
    // 读不到（权限 / IO）：不宣称「正文缺失」——写成 false 会让页面建议用户彻底删除
    return true;
  }
  if (size <= CONTENT_PROBE_CHUNK) return false;
  try {
    return fs.readFileSync(contentPath, 'utf-8').trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * 列出回收站条目（按 deletedAt 倒序）。
 *
 * `probeContent`（默认 true）决定要不要为 doc 条目算 `hasContent`：读 `content.md` 有 IO，
 * 只给**真正需要判定「正文缺失」的消费方**开（列表页 / diagnostics）。
 * 到期清理、库体积统计只要元数据，传 false 免掉整目录读盘。
 */
export function listTrash(scope: string, opts: { reason?: TrashReason; limit?: number; offset?: number; probeContent?: boolean } = {}): {
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
            // 存量条目无 kind：读侧补成 'doc'（不写回磁盘，见头注释约束 4）
            const kind: TrashKind = item.kind === 'group' ? 'group' : 'doc';
            out.push({
              ...item,
              kind,
              group: item.group || groupSegs.join('/'),
              dir: child,
            });
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
  // 只给**本页真正要下发的**条目算 hasContent：total 计算不需要它，别为翻页外的条目读盘
  const page = filtered.slice(offset, offset + limit);
  if (opts.probeContent !== false) {
    for (const item of page) {
      // 组条目的正文在 docs/NNNN/ 里，没有单篇快照 —— 不给 hasContent，免得被误判成「坏条目」
      if (item.kind === 'doc') item.hasContent = hasRestorableContent(item.dir);
    }
  }
  return { items: page, total: filtered.length };
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

/** 已到期条目（purgeExpired 的输入；纯读、只看期限，不探正文 → probeContent:false 免读盘） */
export function findExpiredTrash(scope: string, now: number): TrashEntry[] {
  return listTrash(scope, { probeContent: false }).items.filter((i) => i.expiresAt <= now);
}
