/**
 * dashboardScopeCards.ts —— 总览「当前知识库」六宫格的判定与文案（2026-10-30）
 *
 * ★ 单一来源：本文件**不**重新判定「能不能回写」——`wikiWritebackCard` 直接消费
 *   `describeWikiSync()` 的 `tone`，只把带完整路径的 label 换成卡内放得下的短状态词。
 *   另写一套判定会出现「总览说未开启、资源页说已开启」的同屏矛盾（资源页 2026-10-30
 *   已因同类问题被用户抓过一次，别再犯）。
 *
 * ★ 三处「—」不可退化成猜测：`readonly` / `wikiSync` 都是旧版 daemon 可能不返回的
 *   可选字段。`undefined` 表示「不知道」，绝不能渲染成「可写」「未开启」——那是在
 *   替 daemon 撒谎，用户会据此判断"能写 / 没配"。
 */
import { describeWikiSync, type WikiSyncLike } from './resourcesPage';
import { scopeReadonlyTitle, scopeReadonlyUnlockHint } from './scopeReadonly';

export type CardTone = 'ok' | 'warn' | 'muted';

/** 四类格子共用的展示结构 */
export interface CardValue {
  tone: CardTone;
  /** 卡内可见的短文案（不放路径：用户 2026-10-30 明确要求） */
  label: string;
  /** hover 说明，承载完整路径 / 来源 / 原因 */
  title: string;
}

// ─── 读写权限 ────────────────────────────────────────────────────────────

/**
 * 读写权限三态。
 *
 * ★ `readonly === true` 才只读（与后端 `isScopeReadonly` 一致）；
 *   `readonly === false` 才是「可写」；`undefined` → `—`。
 *   注意**不能**复用 `readonlyBadge()` 的宽松口径（`readonly !== true` 就不渲染）：
 *   徽标"少显示"没损失，状态卡"少显示"会变成 `—`，但错标成「可写」是安全事故。
 */
export function readModeCard(scope: string, readonly: boolean | undefined): CardValue {
  if (readonly === true) {
    return { tone: 'warn', label: '只读', title: scopeReadonlyTitle(scope) };
  }
  if (readonly === false) {
    return {
      tone: 'ok',
      label: '可写',
      title: '人工与 AI 均可逐条写入；导入与数据源同步同样可用',
    };
  }
  return {
    tone: 'muted',
    label: '—',
    title: '当前 daemon 未提供只读状态（旧版本），请以实际写入结果为准',
  };
}

// ─── KB / RAG 两层（合并为一格的两列） ───────────────────────────────────

/**
 * 圆点语义三态（2026-10-30 用户选定的状态点形态）。
 *
 * 用三态而不是 `有/无` 两态：`unknown`（没枚举到）与 `off`（确认没有）是两件事，
 * 混在一起会把"向量服务挂了"读成"这个库没建向量"。
 */
export type LayerTone = 'ok' | 'off' | 'unknown';

export interface LayerCell {
  /** 卡内状态词：可用 / 不可用 / 未知 / — */
  label: string;
  tone: LayerTone;
  /** hover 说明（原因、边界、后续怎么办） */
  title: string;
}

export interface LayerMetaLike {
  kb: boolean;
  vector: boolean;
}

export interface LayerColumns {
  kb: LayerCell;
  rag: LayerCell;
}

/**
 * 合并格「KB ｜ RAG」两列的取值。
 *
 * ★ 两列必须各自可读，**禁止**合并成一个总状态：`kb 可用 / rag 不可用` 是最需要被
 *   看见的坏状态（原文在、语义检索坏了），压成一枚对勾就正好把它藏起来。
 *
 * ★ `vectorDegraded` 必须参与判定：向量服务不可用时后端 `vectorScopes` 是空集
 *   （`src/scope.ts:210-218`），于是**每个** scope 的 `vector` 都是 `false`（`:275`）。
 *   直接渲染「不可用」等于谎报「这个库没建向量」，而事实是"这次没枚举到"。
 *   既有「向量层」格已有此缺陷，本次合并后更容易被误读，故一并纠正为「未知」。
 */
export function layerColumns(
  meta: LayerMetaLike | undefined,
  vectorDegraded: boolean,
): LayerColumns {
  if (!meta) {
    const cell: LayerCell = {
      label: '—',
      tone: 'unknown',
      title: '当前 scope 不在 scope 列表中（新建未枚举或列表未刷新）',
    };
    // 两列各自一个对象：共用同一引用会让未来任何一处就地改字段同时污染另一列
    return { kb: { ...cell }, rag: { ...cell } };
  }
  const kb: LayerCell = meta.kb
    ? { label: '可用', tone: 'ok', title: 'KB 层：原文已写入本地知识库（local / group 索引）' }
    : { label: '不可用', tone: 'off', title: 'KB 层：该 scope 没有本地知识库目录' };

  if (vectorDegraded) {
    return {
      kb,
      rag: {
        label: '未知',
        tone: 'unknown',
        title: '向量服务暂不可用，本次未枚举（不代表没建向量集合）',
      },
    };
  }
  return {
    kb,
    rag: meta.vector
      ? { label: '可用', tone: 'ok', title: 'RAG 层（向量层）：集合已建立，语义检索可用' }
      : {
          label: '不可用',
          tone: 'off',
          title: 'RAG 层（向量层）：该 scope 未建向量集合，只能全文检索',
        },
  };
}

// ─── Wiki 回写 ───────────────────────────────────────────────────────────

/**
 * 只读库下 Wiki 回写的补充说明 —— 必须加，否则新六宫格自相矛盾。
 *
 * 事实链（代码可查，别凭印象改写）：
 *   · 触发回写的三条主路径 `sync-relation` / `bulk-sync-relation` / `edit-relation`
 *     全在 `BLOCKED_OPS`（`src/lib/scope-policy.ts:59-71`）⇒ 只读库下 AI 与人工写入
 *     被 409 拒绝 ⇒ 那三条路径**不会**回写；
 *   · 例外只有 CLI 的 `ki import --wiki-writeback`（`import.ts` 里 `wikiWriteback: true`
 *     仅 CLI 传），它走 `EXEMPT_OPS` 的 import 通道。
 *   ⚠️ 不能写成「ki import 与数据源同步仍会回写」：**数据源同步不回写 wiki**（资源页
 *     的「不会回写」清单已核实），它只写 KB 与向量。写错会让人以为同步一次 wiki 就变了。
 */
export function readonlyWikiNote(scope: string): string {
  return `只读库下逐条写入会被拒绝，因此以上回写不会发生；例外是 CLI 导入带 --wiki-writeback 时仍会回写（数据源同步只写 KB 与向量，不回写 wiki）。解除只读：${scopeReadonlyUnlockHint(scope)}`;
}

/**
 * Wiki 回写卡（四态，卡内只给状态词 + 来源标记，路径全进 title）。
 *
 * 四态顺序即优先级，与 {@link describeWikiSync} 的分支**一一对应**，不可交换：
 *   ① 旧 daemon 无数据 → —                ② 显式配了 wikiSync → 已开启
 *   ③ 开关开着但落点来自导入源 → 已开启 · 导入源（可能落到一次性暂存目录）
 *   ④ 开关开着但无可用目录 → ⚠ 无可用目录   ⑤ 其余 → 未开启
 *
 * ★ 「已开启 · 导入源」这一态**不能省**：它表示"没配 wikiSync，只是若回写会落到
 *   导入源目录"，与真正配过 sourceDir 是两件事（2026-10-28 用户反馈误显示 ✓）。
 *   卡窄放不下完整解释，用弱化后缀 + title 承担。
 */
export function wikiWritebackCard(
  scope: string,
  readonly: boolean | undefined,
  ws: WikiSyncLike | null | undefined,
): CardValue {
  const copy = describeWikiSync(ws); // tone 唯一来源
  const withNote = (title: string): string =>
    readonly === true ? `${title}。${readonlyWikiNote(scope)}` : title;

  // 旧 daemon 也要带只读注脚：「不知道配没配」不改变「只读库下逐条写入被拒」这个事实，
  // 少了它，只读用户看到 `—` 就找不到"为什么 wiki 没变"的解释
  if (!ws) return { tone: copy.tone, label: '—', title: withNote(copy.title) };

  if (ws.writableFrom === 'wiki-sync' && ws.writableDir) {
    return {
      tone: copy.tone,
      label: '已开启',
      title: withNote(`可回写（来源：wikiSync.sourceDir）→ ${ws.writableDir}`),
    };
  }
  if (ws.writableDir && ws.enabled) {
    return {
      tone: copy.tone,
      label: '已开启 · 导入源',
      title: withNote(
        `可回写，但落点来自导入源目录（优先级高于 wikiSync.sourceDir，可能是导入时的一次性暂存目录）：${ws.writableDir}`,
      ),
    };
  }
  if (ws.enabled) {
    return { tone: copy.tone, label: '⚠ 无可用目录', title: withNote(copy.title) };
  }
  return { tone: copy.tone, label: '未开启', title: withNote(copy.title) };
}
