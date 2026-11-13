/**
 * doc-delete.ts —— 从浏览页删除单篇文档（2026-11-13）
 *
 * 为什么单独成模块而不是在 HTTP 层直接调 `executeDeleteRelation`：
 *
 *   ├─ **预检**：删除不可恢复，弹窗必须在动手前回答「源文件会不会一起没」「有没有未结束的草稿」
 *   │   「这篇是不是数据源同步下来的」——这些判据散落在 delete / wiki-sync / draft 三处，
 *   │   前端各查一次必然漂移，所以由本模块一次算清并下发。
 *   └─ **数据源处置**：与移动**刻意不同**。移动阻断（搬走后下次同步会在原组再导一份，形成副本），
 *       删除放行（不产生副本，下次同步只是把这篇重新导回来）——但必须如实预告，不能让用户以为
 *       「删了就真没了」。
 *
 * 真正的清除（KB 正文 / 元数据分片 / Group 树 / 向量 / FTS / wiki 源文件）全部复用
 * 已测链路 `executeBatchDelete(..., { wikiDelete })`，本模块不重复实现任何一步。
 */
import fs from 'node:fs';
import path from 'node:path';

import { getLocalKbDir } from './scope.js';
import { loadGroupCache } from './group-cache.js';
import { readJson } from './store.js';
import { activeDrafts } from './relation-edit-draft.js';
import { resolveWikiRootDir } from './wiki-sync.js';
import { executeBatchDelete } from '../delete-relation.js';
import { datasourceManagedFile, normalizeGroup, normalizeRelation, reject } from './doc-identity.js';

export interface DocDeleteInput {
  scope: string;
  group: string;
  relation: string;
  /**
   * 是否连 wiki 源文件一起删。
   * - `undefined` / `true`：沿用 CLI 与既有 HTTP 语义（硬删，无回收站）
   * - `false`：只从知识库移除，用户仓库里的 .md 原地不动（项目里已有同款实践：数据源 prune）
   */
  wikiDelete?: boolean;
}

/** wiki 源文件「不删」的原因（与 delete-relation 的 `wikiSkipReason` 同一套取值） */
export type WikiDeleteSkipReason = 'not-configured' | 'file-not-found' | 'source-mismatch';

export interface DocDeletePrecheck {
  ok: true;
  scope: string;
  group: string;
  relation: string;
  /** 分片或 KB 正文至少有一层存在 */
  exists: boolean;
  /** 未结束的编辑草稿数（> 0 时真正删除会被 409 拒绝） */
  pendingDrafts: number;
  /** wiki 源文件绝对路径（未配置源目录时不出现） */
  wikiPath?: string;
  /** 勾选「同时删除源文件」时是否真的会被删；false 时看 wikiSkipReason */
  wikiWillDelete: boolean;
  wikiSkipReason?: WikiDeleteSkipReason;
  /** 数据源管辖的实体文件：有值 ⇒ 删掉后下次同步会重新导入这篇 */
  datasourceSource?: string;
}

export interface DocDeleteResult {
  ok: true;
  scope: string;
  group: string;
  relation: string;
  deleted: boolean;
  wikiRemoved: boolean;
  wikiSkipReason?: string;
  datasourceSource?: string;
  /** 用户该知道但不足以判定失败的事实（源文件没删掉的原因、历史数据按文件名删等） */
  warnings: string[];
}

/** 预检与真删共用的「目标解析」：参数归一 + 存在性 + 草稿 + wiki 落点 + 数据源归属 */
interface ResolvedTarget {
  scope: string;
  group: string;
  relation: string;
  exists: boolean;
  pendingDrafts: number;
  wikiPath?: string;
  wikiWillDelete: boolean;
  wikiSkipReason?: WikiDeleteSkipReason;
  datasourceSource?: string;
}

/**
 * wiki 源文件落点与「删得掉吗」。
 *
 * ★ 必须与 delete-relation.ts 的判据逐条对齐（那边是真正的执行者）：
 *   - 删除目标**恒为命名约定路径** `<wiki>/<group>/<relation>.md`；
 *   - `sourcePath` 只用于**归属校验**（realpath 必须相同），不一致一律拒绝删 ——
 *     硬删无回收站，宁可删不掉也不误删同名文件。
 * 这里算的是「预告」，真删时以执行者的结论为准（两者不一致时回执会以执行者为准）。
 */
function planWikiDelete(
  scope: string,
  group: string,
  relation: string,
  record: { sourcePath?: string } | undefined,
): { file?: string; skipReason?: WikiDeleteSkipReason } {
  const root = resolveWikiRootDir(scope).dir;
  if (!root) return { skipReason: 'not-configured' };
  const file = group ? path.join(root, group, `${relation}.md`) : path.join(root, `${relation}.md`);
  // 文件不存在就**不返回路径**：前端据此决定要不要显示「同时删除源文件」勾选框 ——
  // 摆一个勾选框、勾了却什么都不会发生，比不显示更糟
  if (!fs.existsSync(file)) return { skipReason: 'file-not-found' };
  const rel = String(record?.sourcePath ?? '').trim();
  if (rel) {
    let same = false;
    try {
      same = fs.realpathSync(path.resolve(root, rel)) === fs.realpathSync(file);
    } catch {
      same = false;
    }
    if (!same) return { file, skipReason: 'source-mismatch' };
  }
  return { file };
}

function resolveTarget(input: DocDeleteInput): ResolvedTarget {
  const scope = String(input.scope ?? '').trim();
  if (!scope) reject(400, 'DOC_ID_INVALID', '缺少 scope');
  // 删除放行根保留键：根散文件本来就存在于库里，不给删等于留一个删不掉的孤儿
  const group = normalizeGroup(input.group, 'Group', true);
  const relation = normalizeRelation(input.relation, '文档名称');

  const record = loadGroupCache(scope, group)?.hot_relations.find((item) => item.text === relation);
  const content = readJson<Record<string, string>>(getLocalKbDir(scope, group))?.[relation];
  const exists = Boolean(record) || typeof content === 'string';

  const pendingDrafts = activeDrafts(scope)
    .filter((draft) => draft.group === group && draft.relation === relation).length;

  const wiki = planWikiDelete(scope, group, relation, record as { sourcePath?: string } | undefined);
  // 一次算好：两次调用会各走一遍 fs.statSync（且两次之间文件可能被删，结论互相矛盾）
  const managed = datasourceManagedFile(scope, (record as { sourcePath?: string } | undefined)?.sourcePath);
  return {
    scope,
    group,
    relation,
    exists,
    pendingDrafts,
    ...(wiki.file ? { wikiPath: wiki.file } : {}),
    wikiWillDelete: !wiki.skipReason,
    ...(wiki.skipReason ? { wikiSkipReason: wiki.skipReason } : {}),
    ...(managed ? { datasourceSource: managed } : {}),
  };
}

/** 只预检：供确认弹窗渲染后果与前置阻断，不产生任何副作用 */
export function precheckDocDelete(input: DocDeleteInput): DocDeletePrecheck {
  const target = resolveTarget(input);
  return {
    ok: true,
    scope: target.scope,
    group: target.group,
    relation: target.relation,
    exists: target.exists,
    pendingDrafts: target.pendingDrafts,
    ...(target.wikiPath ? { wikiPath: target.wikiPath } : {}),
    wikiWillDelete: target.wikiWillDelete,
    ...(target.wikiSkipReason ? { wikiSkipReason: target.wikiSkipReason } : {}),
    ...(target.datasourceSource ? { datasourceSource: target.datasourceSource } : {}),
  };
}

/**
 * 删除一篇文档。调用方负责持有 scope 写锁（HTTP 层传入 `doc-relation-delete`）。
 *
 * 与 doc-move 的差异：这里**没有回滚** —— 删除是单向的，所以宁可早失败（预检全过才动手），
 * 也不做「删一半再补回来」的假回滚。
 */
export async function deleteDocument(input: DocDeleteInput): Promise<DocDeleteResult> {
  const target = resolveTarget(input);
  if (!target.exists) {
    reject(404, 'DOC_NOT_FOUND', `文档不存在：${target.group} / ${target.relation}`);
  }
  if (target.pendingDrafts > 0) {
    reject(409, 'DOC_EDIT_IN_PROGRESS',
      `该文档有 ${target.pendingDrafts} 条未结束的编辑草稿，请先在编辑器里保存或取消后再删除`);
  }

  const wikiDelete = input.wikiDelete !== false;
  const batch = await executeBatchDelete(
    target.scope,
    [{ group: target.group, relation: target.relation }],
    { wikiDelete },
  );
  const item = batch.results[0];
  if (!item?.deleted) {
    const reason = item?.reason ?? '';
    // 草稿卫兵在并发下也可能踩到（预检与真删之间有人开了编辑器）：翻译成同一错误码
    if (/未结束的编辑草稿/.test(reason)) reject(409, 'DOC_EDIT_IN_PROGRESS', reason);
    /*
     * `deleted` 的判据是「分片里真的删到了这一条」（delete-relation:311）。所以
     * **无 reason + deleted=false = 目标此刻已经不存在**（另一个窗口先删了 / 上一次已删完），
     * 不是失败。早先这里一律抛 500，用户会看到「删除失败（未返回原因）」并反复重试，
     * 而他真正需要的信息是「它已经不在了」。
     */
    if (!reason) {
      const again = resolveTarget(input);
      if (!again.exists) {
        return {
          ok: true,
          scope: target.scope,
          group: target.group,
          relation: target.relation,
          deleted: false,
          wikiRemoved: false,
          warnings: ['这篇文档已经不存在了（可能已被其他窗口删掉）'],
        };
      }
      reject(500, 'DOC_DELETE_FAILED', '删除未生效（服务端未返回原因），请刷新后重试');
    }
    reject(500, 'DOC_DELETE_FAILED', reason);
  }

  const warnings: string[] = [];
  /*
   * Group 解析差异（**必须告知**）：`executeDeleteRelation` 内部会 `resolveGroupPath` 做模糊补全
   * （简写 Group 也能命中真实节点），而本模块的预检按调用方原样传入的 Group 算 wiki 落点。
   * 两者不一致时，源文件可能被删在了用户没预期的位置上 —— 事后也必须让他知道。
   */
  if (item.group && item.group !== target.group) {
    warnings.push(`实际删除的 Group 是「${item.group}」（按路径补全匹配，与请求的「${target.group}」不同）`);
  }
  if (target.datasourceSource) {
    warnings.push('这篇文档由数据源同步维护：下次同步仍会把它导回来，要彻底去掉请到「数据源」页停用对应来源');
  }
  if (!wikiDelete) {
    warnings.push('已按选择保留 wiki 源文件：仓库里的 .md 没有变动');
  } else if (item.wikiError) {
    warnings.push(`wiki 源文件删除失败：${item.wikiError}`);
  } else if (item.wikiSkipReason && item.wikiSkipReason !== 'wiki-delete-disabled') {
    warnings.push(wikiSkipText(item.wikiSkipReason));
  }
  /*
   * 其余清理说明（历史 relation 按文件名删、向量清理失败等）来自 `DeleteResult.reason`。
   * 已经由 wiki 分支说过的不再重复（source-mismatch 的 reason 里带绝对路径，重复会变成两行噪音）。
   */
  if (item.reason && !item.wikiError && !item.wikiSkipReason) {
    warnings.push(item.reason);
  }

  return {
    ok: true,
    scope: target.scope,
    group: target.group,
    relation: target.relation,
    deleted: true,
    wikiRemoved: item.wikiRemoved,
    ...(item.wikiSkipReason ? { wikiSkipReason: item.wikiSkipReason } : {}),
    ...(target.datasourceSource ? { datasourceSource: target.datasourceSource } : {}),
    warnings,
  };
}

/** `wikiSkipReason` → 用户能读懂的一句话（前端也有同款文案，此处用于回执） */
export function wikiSkipText(reason: string): string {
  switch (reason) {
    case 'not-configured':
      return '该知识库未配置 wiki 源目录，没有文件需要删除';
    case 'file-not-found':
      return 'wiki 源文件本来就不在命名约定的位置，未删除任何文件';
    case 'source-mismatch':
      return 'wiki 源文件与文档记录的来源不是同一个文件，出于安全未删除';
    case 'wiki-delete-disabled':
      return '按选择保留了 wiki 源文件';
    default:
      return `wiki 源文件未删除（${reason}）`;
  }
}
