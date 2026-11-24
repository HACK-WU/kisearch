/**
 * 数据链路（`AnalysisDraft.dataFlow`）的归一 —— 2026-11-24 · REQ-20261124-001。
 *
 * 为什么不复用 `conclusion-chain.ts`：那个模块的核心是 `oneLine()`（把多行压成一行），
 * 与本字段「换行有语义、一个换行都不能丢」的规则**正相反**。混在一起，后来者极易
 * 顺手拿 `oneLine` 处理链路，产出一条被压成散文的「树」。
 *
 * 三种输入的结局（与 `normalizeChain` 同取向：宁可少一段，也不放不可信的内容）：
 *   ① 合法字符串 → 规范化后返回；**值未变时返回与入参等值的字符串**
 *      （调用方按值比较判「无变化」，见 `analysis-store.normalizeAnalysisDocForRead` 的早退）
 *   ② 非字符串 / 空串 / 全空白 → `undefined`，调用方**删除该键**（不是写 null）
 *   ③ 超限 → 截断 + 追加提示行（提示行独立一行，不参与树结构）
 *
 * 模型侧的要求写在 `analysis-runner.buildOutputTail`（3~15 步、每行 ≤100 字、换行必须
 * 写成 `\n` 转义）；本文件的 40 行 / 3000 字是**归一上限**，留了缓冲，正常输出不会触发截断。
 */

/** 归一上限（行数） */
export const DATA_FLOW_MAX_LINES = 40;
/** 归一上限（字符数，按 LF 拼接后的长度算） */
export const DATA_FLOW_MAX_CHARS = 3000;
/** 截断提示行：单独一行、不冒充树的一部分 */
export const DATA_FLOW_TRUNCATED_MARK = '…（链路过长，已截断）';

/**
 * 归一链路文本。幂等：对已归一的输出再调一次，结果不变（除截断提示行会原样保留）。
 *
 * 处理顺序有讲究：
 *   1. CRLF / CR → LF（Windows 粘贴来的内容带 `\r`，`<pre>` 里会渲染成方块）
 *   2. 清**行尾**空白（含全角空格 `\u3000`：中文输入法下粘贴常见）
 *      —— 行首缩进**必须保留**，树形靠它
 *   3. 连续空行压成 1 行（模型常在箭头之间补空行），首尾空行去掉
 *   4. 先按行截断，再按字符截断；字符截断若切在一行中间，回退到上一个换行
 */
export function normalizeDataFlow(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const trimmed = line.replace(/\s+$/, '');
    /*
     * 行首全角空格 → 两个半角：中文输入法下粘贴的内容常带 `\u3000` 缩进，
     * 而等宽字体里 `\u3000` 是 1em、半角空格约 0.6em —— 两种混用时缩进会跳档，
     * 一棵本来就靠空白对齐的树会歪得更厉害。**只动行首**，行内的全角空格是正文。
     */
    return trimmed.replace(/^\u3000+/, (m) => '  '.repeat(m.length));
  });

  const compact: string[] = [];
  for (const line of lines) {
    if (line === '' && compact[compact.length - 1] === '') continue;
    compact.push(line);
  }
  while (compact.length > 0 && compact[0] === '') compact.shift();
  while (compact.length > 0 && compact[compact.length - 1] === '') compact.pop();
  // 全空白 / 全空行：与「没有链路」等价，不能落一个空串（前端会渲染出一个空块）
  if (compact.length === 0) return undefined;

  let kept = compact;
  let truncated = kept.length > DATA_FLOW_MAX_LINES;
  if (truncated) kept = kept.slice(0, DATA_FLOW_MAX_LINES);

  let text = kept.join('\n');
  if (text.length > DATA_FLOW_MAX_CHARS) truncated = true;

  if (!truncated) return text;

  /*
   * 截断时**先把提示行的长度从预算里扣掉**：否则「内容恰好 3000 字 + 提示行」会变成
   * 3012 字，再归一一次又超限 ⇒ 每次读盘都改写一遍（不幂等，且落盘时间戳会抖）。
   */
  const budget = DATA_FLOW_MAX_CHARS - (DATA_FLOW_TRUNCATED_MARK.length + 1);
  if (text.length > budget) {
    let cut = text.slice(0, budget);
    // 只切在行边界：半行文字比少一行更难读（且会破坏树的视觉）
    const lastBreak = cut.lastIndexOf('\n');
    if (lastBreak > 0) cut = cut.slice(0, lastBreak);
    text = cut;
  }
  return `${text}\n${DATA_FLOW_TRUNCATED_MARK}`;
}
