/**
 * skillSlash.ts —— 输入框 `/` 斜杠点名 skill 的**纯逻辑**（触发判定 / 过滤 / 文本替换 / token 解析）。
 *
 * 为什么单独成文件：
 *   · 四条判定（何时弹、插什么、发什么、删了怎么办）都必须可单测 —— 塞进 2000 行的 `ChatPanel`
 *     就只能靠真机点，回归成本极高；
 *   · 「文本即凭证」是本功能的**核心取舍**：不另存一份"已选 skill"状态，
 *     发送时从草稿文本里解析 token。因此**手删 token = 取消点名**，天然不会有隐藏状态。
 *
 * ⚠️ 与后端 `parseSkillIds`（chat-routes.ts）**刻意分工不同**：
 *   前端按 skill **名称 / id** 把 token 解析成 id（拿得到配置列表），
 *   后端只校验形状与可用性，**不解析文本**（文本可能被用户改成任何样子）。
 */
import { CHAT_SKILLS_MAX, type PromptSkill } from '@/api/chatContract';

/**
 * skill 名 / id 允许的字符（与后端 `SKILL_NAME_RE` 同源：字母开头、字母数字与连字符）。
 * 用它界定 token 的右边界 —— `/ki-uploadx` 整体成词，不会误命中 `/ki-upload`。
 */
const TOKEN_BODY = '[A-Za-z0-9][A-Za-z0-9_-]*';
const NAME_CHAR = /[A-Za-z0-9_-]/;

/** `/` 触发态：`/` 的位置 + 光标之间的过滤词 */
export interface SlashTrigger {
  /** `/` 在文本中的下标 */
  start: number;
  /** `/` 之后到光标之间的过滤词（可为空串 = 显示全部已启用 skill） */
  query: string;
}

/**
 * 光标是否处在 `/` 触发态。
 *
 * 触发条件（三条同时成立，缺一不弹）：
 *   1. 光标左侧最近的 `/` 与光标之间**只有**名称字符（含零个）；
 *   2. 该 `/` 之前是**行首或空白**；
 *   3. 光标在文本范围内。
 *
 * 第 2 条是防误触的关键：`src/lib`、`2026/11/11`、`/api/chat` 里的 `/` 前面都不是空白
 * （`/api` 那个是行首，用户确实打了 `/`，按预期弹出 —— 过滤词 `api` 命中不到就不显示项）。
 */
export function slashTriggerAt(text: string, caret: number): SlashTrigger | null {
  if (caret < 1 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0 && NAME_CHAR.test(text[i]!)) i -= 1;
  if (i < 0 || text[i] !== '/') return null;
  // 行首（i === 0）或 `/` 前一个是空白才成立
  if (i > 0 && !/\s/.test(text[i - 1]!)) return null;
  return { start: i, query: text.slice(i + 1, caret) };
}

/** 候选过滤：名称或描述包含过滤词（大小写不敏感）；空过滤词返回全部（保序） */
export function filterSkills(skills: readonly PromptSkill[], query: string): PromptSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
  );
}

/**
 * 把触发中的 `/过滤词` 替换成 `/名称 `（光标落到名称之后）。
 *
 * 尾部空格：后面已有空白就不补，避免用户看到 `/ki-upload  ` 两个空格。
 */
export function applySkillToken(
  text: string,
  trigger: SlashTrigger,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(caret);
  const inserted = `/${name}`;
  const needSpace = tail.length === 0 || !/\s/.test(tail[0]!);
  return {
    text: `${head}${inserted}${needSpace ? ' ' : ''}${tail}`,
    caret: head.length + inserted.length + (needSpace ? 1 : 0),
  };
}

/**
 * 草稿里是否**可能**含 skill token（用于"发送前要不要先拉配置列表"）。
 *
 * 只是廉价预判：命中不代表一定能解析出 id（名称可能写错 / 已停用）。
 */
export function hasSlashToken(text: string): boolean {
  return new RegExp(`(^|\\s)/${TOKEN_BODY}`).test(text);
}

/**
 * 从草稿解析出本轮 `/` 点名的 skill id（去重保序，上限 `CHAT_SKILLS_MAX`）。
 *
 * 匹配规则：token 必须**独立成词**（前面是行首或空白，后面是名称字符集之外的边界），
 * 名称或 id 命中（大小写不敏感）。解析不到的 token 保持普通文本 —— 不报错、不阻断发送：
 * 用户可能只是写了 `/api/chat` 这样的路径。
 */
export function parseSkillTokenIds(text: string, skills: readonly PromptSkill[]): string[] {
  if (skills.length === 0 || !hasSlashToken(text)) return [];
  const out: string[] = [];
  for (const hit of findSkillTokens(text, skills)) {
    if (out.includes(hit.skill.id)) continue;
    out.push(hit.skill.id);
    if (out.length >= CHAT_SKILLS_MAX) break;
  }
  return out;
}

/** 一处命中：`start`/`end` 是 `/名称` 在文本中的下标区间（含 `/`，不含其后的空白） */
export interface SkillTokenMatch {
  start: number;
  end: number;
  skill: PromptSkill;
}

/**
 * 找出文本里所有**生效的** `/名称` token（`parseSkillTokenIds` 与高亮层共用这一份规则）。
 *
 * 匹配口径与解析完全一致：独立成词（前面行首或空白、后面是名称字符集之外的边界），
 * 名称或 id 命中（大小写不敏感）。**解析不到的 token 不返回** —— 它们会被高亮层当普通文本渲染，
 * 与"发送时不会被当成点名"保持同一口径（否则用户会看到高亮却没生效）。
 */
export function findSkillTokens(text: string, skills: readonly PromptSkill[]): SkillTokenMatch[] {
  if (skills.length === 0 || !hasSlashToken(text)) return [];
  const out: SkillTokenMatch[] = [];
  const re = new RegExp(`(^|\\s)/(${TOKEN_BODY})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[2]!.toLowerCase();
    const skill = skills.find((s) => s.name.toLowerCase() === token || s.id.toLowerCase() === token);
    if (!skill) continue;
    const start = m.index + m[1]!.length;
    out.push({ start, end: start + 1 + m[2]!.length, skill });
  }
  return out;
}

/** 高亮层的分段：普通文本 / skill token 交替 */
export interface ComposerSegment {
  kind: 'text' | 'skill';
  text: string;
  /** `kind='skill'` 时才有 */
  skill?: PromptSkill;
}

/**
 * 把草稿切成「普通文本 / skill token」分段，供输入框高亮层渲染。
 *
 * 无 token 时返回**单个 text 段**（调用方据此不加 `data-tokenized` —— 没有 token 时
 * 输入框完全走原生 textarea 渲染，字体、光标、输入法、选区一个字节都不变）。
 */
export function splitSkillSegments(text: string, skills: readonly PromptSkill[]): ComposerSegment[] {
  const tokens = findSkillTokens(text, skills);
  if (tokens.length === 0) return [{ kind: 'text', text }];
  const out: ComposerSegment[] = [];
  let cur = 0;
  for (const t of tokens) {
    if (t.start > cur) out.push({ kind: 'text', text: text.slice(cur, t.start) });
    out.push({ kind: 'skill', text: text.slice(t.start, t.end), skill: t.skill });
    cur = t.end;
  }
  if (cur < text.length) out.push({ kind: 'text', text: text.slice(cur) });
  return out;
}
