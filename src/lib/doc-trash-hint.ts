/**
 * doc-trash-hint.ts —— `GET /api/doc/get` 404 时补「这篇文档已经进了回收站」的判据。
 *
 * 为什么需要：文档进站后已从 KB 摘除，`doc/get` 只能给出「Group "x" 未匹配到有效路径」。
 * 那句话在**路径写错**和**文档被删**两种场景下完全一样，用户分不清该怎么补救
 * （实测：后台任务详情里点「新增的文档」→ 看到该文案 → 被读成"视图/权限问题"）。
 * 删除是唯一可由「回收站」自行修复的状态，所以在这里把判据补齐。
 *
 * 分层：只做判定与文案，由 `handleDocGet` 决定怎么下发（HTTP 边界，不动
 * `executeGetModuleInfoLocal` —— MCP / CLI 侧的 404 文案与兜底语义保持不变）。
 *
 * 只在 404 路径调用：`listTrash` 要扫 `.trash` 目录，正常读取不吃这个成本。
 */

import { listTrash, type TrashItem, type TrashReason } from './trash-store.js';

/** 命中回收站的文档（下发到前端的结构化信息，字段名即契约） */
export interface DocTrashHit {
  /** 文档原本所在的库（视图模式下是成员库，不是视图名） */
  scope: string;
  /**
   * 命中条目类型：
   *   doc   —— 这篇文档被单独删除，正文快照在 `.trash/<group>/<dirName>/content.md`
   *   group —— 整个分组被删除，该篇随之进站
   */
  kind: 'doc' | 'group';
  /** doc：文档所在组；group：被删组自身的规范路径 */
  group: string;
  name: string;
  reason: TrashReason;
  deletedAt: number;
  /** 站内到期时间（到期后会被物理清理，届时再也恢复不了） */
  expiresAt: number;
  dirName: string;
}

/** 删除原因 → 用户能看懂的短语（`manual` 与生命周期到期要分开说，补救途径不同） */
const REASON_LABEL: Record<TrashReason, string> = {
  manual: '手动删除',
  'temp-expired': '临时文档到期',
  'event-closed': '事件归档',
  'event-expired': '事件归档到期',
};

function toHit(item: TrashItem, kind: 'doc' | 'group'): DocTrashHit {
  return {
    scope: item.scope,
    kind,
    group: item.group,
    name: item.name,
    reason: item.reason,
    deletedAt: item.deletedAt,
    expiresAt: item.expiresAt,
    dirName: item.dirName,
  };
}

/**
 * 在 `scope` 的回收站里找「`group` / `relation`」这篇。
 *
 * 两级命中：
 *   1. **文档条目**精确命中（`group` + `name` 全等）—— 同一篇被删多次时 `listTrash`
 *      已按 `deletedAt` 倒序，取第一条即最近一次；
 *   2. **组条目**路径前缀命中（`group` 等于被删组，或落在其子树内）。
 *      此时**不**逐篇读 `docs/NNNN/doc.json` 复核：调用点本身是 404（库里确实没有这篇），
 *      而组被删意味着当时整组都进了站 —— 结论已经成立，逐篇读正文快照纯属浪费 IO。
 *      单篇被单独恢复的情形不会走到这里（那时 `doc/get` 会 200）。
 */
export function findDocInTrash(scope: string, group: string, relation: string): DocTrashHit | null {
  let items: TrashItem[];
  try {
    items = listTrash(scope, { probeContent: false }).items;
  } catch {
    /*
     * **空回收站走的就是这里**（`.trash` 目录不存在 → readdir 抛 ENOENT），
     * 因此不能当成异常去 warn：绝大多数库的绝大多数 404 都属于「从没删过东西」。
     * 判不出「被删」就不宣称，维持原来的 404 文案。
     */
    return null;
  }

  const docHit = items.find(
    (item) => (item.kind ?? 'doc') === 'doc' && item.group === group && item.name === relation,
  );
  if (docHit) return toHit(docHit, 'doc');

  const groupHit = items.find(
    (item) => item.kind === 'group' && (item.group === group || group.startsWith(`${item.group}/`)),
  );
  return groupHit ? toHit(groupHit, 'group') : null;
}

/** 404 响应体里与「已删除」相关的字段（与原有 `error` / `hint` 并存，不替换） */
export interface DocTrashHintPayload {
  code: 'DOC_IN_TRASH';
  error: string;
  hint: string;
  trash: DocTrashHit;
}

/**
 * 组装下发给前端的「已被删除」文案。
 *
 * `reason` 必须进文案：手动删除（用户自己删的，去回收站捞）与生命周期到期
 * （本来就该走，可能不必恢复）是完全不同的两件事。
 * 到期时间不在这里格式化 —— 时间戳随 `trash.expiresAt` 下发，由页面按本地时区展示。
 */
export function buildDocTrashHint(hit: DocTrashHit): DocTrashHintPayload {
  const label = REASON_LABEL[hit.reason] ?? hit.reason;
  const where = hit.group && hit.group !== '__root__' ? `「${hit.group}」` : '根目录';
  /*
   * 别把「已被删除」写进 error：前台标题已经是「该文档已被删除」，
   * 两处重复会让整块提示读起来像回声。error 只补标题没有的信息 —— 为什么删、现在在哪。
   */
  return {
    code: 'DOC_IN_TRASH',
    error: hit.kind === 'group'
      ? `文档所在的分组${where}已被整体删除（${label}），文档随之进入回收站`
      : `文档在回收站中（${label}）`,
    hint: '可在「回收站」恢复后重新打开',
    trash: hit,
  };
}