/**
 * 结论因果链（`AnalysisDraft.chain`）的归一与裁剪 —— 2026-11-19。
 *
 * 为什么单独成模块：同一份数据有三处入口，各写一套归一必然漂移 ——
 *   ① 解析模型输出（analysis-runner.parseJsonSummary）
 *   ② 读历史文件（analysis-store.normalizeAnalysisDocForRead）
 *   ③ 拼追问上下文（analysis-ask-runner.buildContext）
 * 其中「非法 kind 丢掉」「ref 格式校验」「节点上限」这几条最容易被漏，
 * 漏一条就会出现「前端渲染出一个没有类型标签的节点」或「引用了一个幻觉位置」。
 *
 * 归一原则：**宁可少一个节点，也不放一条不可信的数据**。
 * 不可信的节点/引用直接丢弃，不抛错 —— 模型输出本来就是不可信输入，
 * 抛错会让整次分析白跑（结论区整块没有），丢掉一个节点只是少一句话。
 */
import type { ConclusionNode, ConclusionNodeKind } from './types.js';

/** 合法节点类型；数组顺序即阅读顺序 */
export const CONCLUSION_KINDS: readonly ConclusionNodeKind[] = ['symptom', 'cause', 'root', 'impact', 'fix'];

/** 节点上限：结论总量有限（conclusion ≤120 字 + 每节点 ≤200 字），再多必然水化 */
export const CHAIN_MAX_NODES = 5;
export const CHAIN_TEXT_MAX = 200;
/** 分支（触发条件 / 反例）只允许挂在根因下 */
export const CHAIN_BRANCH_MAX_ITEMS = 3;
export const CHAIN_BRANCH_TEXT_MAX = 120;

/**
 * `file:line` 形态校验（只校验形状，不校验文件是否存在）。
 *
 * file 允许相对路径里的 `/ . - _ 空格?` —— 空格一律拒绝：模型偶尔会写成
 * 「`src/a.ts: 128`（第 128 行）」这种带说明的串，收进来只会让前端渲染出一个
 * 点开找不到的胶囊。行号必须是正整数。
 */
const REF_PATTERN = /^([^\s:]+):(\d{1,7})$/;

/** 节点类型的中文标签（前端渲染与追问上下文共用同一套，避免两处叫法不一致） */
export const CONCLUSION_KIND_LABELS: Record<ConclusionNodeKind, string> = {
  symptom: '现象',
  cause: '直接原因',
  root: '根本原因',
  impact: '影响面',
  fix: '建议',
};

function isKind(value: string): value is ConclusionNodeKind {
  return (CONCLUSION_KINDS as readonly string[]).includes(value);
}

/** 把多行/多空格压成单个空格：节点是"一句话"，换行会把行高与轨道撑坏 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 归一模型给出的 `chain`。输入完全不可信（可能是字符串 / 嵌套对象 / 带多余字段），
 * 因此逐项校验：类型白名单 → 文本非空 → ref 形状 → 分支（仅 root）。
 */
export function normalizeChain(raw: unknown): ConclusionNode[] {
  if (!Array.isArray(raw)) return [];
  const out: ConclusionNode[] = [];
  for (const item of raw) {
    if (out.length >= CHAIN_MAX_NODES) break;
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind.trim().toLowerCase() : '';
    if (!isKind(kind)) continue;
    const text = typeof obj.text === 'string' ? oneLine(obj.text) : '';
    if (!text) continue;

    const node: ConclusionNode = { kind, text: text.slice(0, CHAIN_TEXT_MAX) };

    if (typeof obj.ref === 'string') {
      const matched = REF_PATTERN.exec(obj.ref.trim());
      const line = matched ? Number(matched[2]) : 0;
      // 行号 0 不算位置（正则只拦形态，`:0` 这种"看起来合法"的值要单独拦）
      if (matched && line >= 1) node.ref = `${matched[1]}:${line}`;
    }

    if (kind === 'root' && Array.isArray(obj.branches)) {
      const branches = obj.branches
        .map((b) => (typeof b === 'string' ? oneLine(b) : ''))
        .filter(Boolean)
        .slice(0, CHAIN_BRANCH_MAX_ITEMS)
        .map((b) => b.slice(0, CHAIN_BRANCH_TEXT_MAX));
      if (branches.length > 0) node.branches = branches;
    }

    out.push(node);
  }
  return out;
}

/**
 * 剪掉指向「不存在的候选位置」的引用。
 *
 * 二次校验（verifyCandidateLocation）会把幻觉路径、越界行号剔除出 candidates，
 * 但 chain 是先解析后校验的 —— 如果不同步剪，结论里就会出现一个
 * 点开什么都没有的胶囊（比不显示更糟：用户会以为界面坏了）。
 * **只剪 ref，保留节点文本**：那句因果判断通常仍然成立。
 */
export function pruneChainRefs(
  chain: ConclusionNode[],
  allowed: ReadonlyArray<{ file: string; line: number }>,
): ConclusionNode[] {
  if (chain.length === 0) return chain;
  const allowedKeys = new Set(allowed.map((item) => `${item.file}:${item.line}`));
  return chain.map((node) => {
    if (!node.ref || allowedKeys.has(node.ref)) return node;
    const { ref: _dropped, ...rest } = node;
    return rest;
  });
}

/** 追问上下文用：把链压成逐行文本（`- 根本原因：…（ref）`） */
export function chainToLines(chain: ConclusionNode[]): string[] {
  return chain.map((node) => {
    const ref = node.ref ? `（${node.ref}）` : '';
    const branches = node.branches?.length ? `；分支：${node.branches.join(' / ')}` : '';
    return `- ${CONCLUSION_KIND_LABELS[node.kind]}：${node.text}${ref}${branches}`;
  });
}
