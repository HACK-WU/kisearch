/**
 * import-path.ts —— 导入落点推导的唯一实现（REQ-20261019-002 修复 · debug）
 *
 * 为什么独立成模块：`import.ts`（真正写入）与 `duplicate-index.ts`（判断"是否同一篇文档"）
 * 必须用**同一套落点规则**——重复判据此前只比 `sourcePath`（相对 sourceDir 的裸路径），
 * 而落点由 `group + rel` 共同决定：当 group 吸收了路径前缀时（如上次 sourceDir 选父目录、
 * 本次选 `<group>` 子目录），裸 rel 不同但落点相同 ⇒ 幂等更新被误判成「疑似重复」。
 *
 * 本模块只依赖 `node:path`，不引入任何 KB/引擎依赖（避免与 `import.ts` 形成循环）。
 */
import path from 'node:path';
// 关系名复用 chunk 命名实现（`chunker` 零依赖，不会把引擎链路拖进来）
import { deriveRelationText } from './chunk-entries.js';

/** 相对路径统一为 posix 风格（跨平台路径分隔符差异不外泄） */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * 显式 group 下的落点：`group` 或 `group/<文件所在子目录>`。
 * 与 `ai-results.deriveGroupPath` 同义（此处不复用其模块，避免拖入 AI 结果链路依赖）。
 */
export function deriveGroupPath(group: string, relPath: string): string {
  const dir = path.posix.dirname(toPosixPath(relPath));
  return dir === '.' ? group : `${group}/${dir}`;
}

/**
 * 推导文件落点的 groupPath（`--group` 语义）：
 * - 显式 group（非空）：group 作为统一根前缀，文件相对子目录挂其下；
 * - 缺省 group：目录导入用文件相对目录（顶层子目录名即根），根下文件归 scope 根；
 * - 单文件导入（rel 无目录）且缺省 group：归 scope 根。
 */
export function resolveGroupForSource(group: string, rel: string, scope: string): string {
  if (group) return deriveGroupPath(group, rel);
  const dir = path.posix.dirname(toPosixPath(rel));
  return dir === '.' ? scope : dir;
}

/**
 * Group 路径合法性（`/api/import/preflight` 与 `/api/import/run` **同口径**）。
 *
 * 拒绝绝对路径 / 反斜杠 / `..` 段；空串表示"未指定"，合法。
 * ★ 两端口径必须一致：否则会出现「预检 400 而 run 放行、真的写出奇怪落点」的分叉。
 */
export function isSafeGroupPath(group: string): boolean {
  if (group === '') return true;
  if (group.startsWith('/') || group.includes('\\')) return false;
  return !group.split('/').includes('..');
}

/**
 * 关系名 = 文件名去 `.md` 与 markdown 强格式字符。
 * ★ 直接复用 `chunk-entries.deriveRelationText`（导入写 relation 用的就是它）——
 *   自己抄一份会在该实现变化时让「判据里的 relation」与「实际写入的 relation」漂移。
 */
export const relationOfPath = deriveRelationText;
