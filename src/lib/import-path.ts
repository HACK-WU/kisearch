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
 * 「根散文件」的固定落点键。
 *
 * 为什么需要一个保留键，而不是继续用 scope 名（2026-11-02 实测缺陷）：
 * 缺省 Group 时根下散文件若落到 `scope` 名，就与「源目录里真实存在一个与 scope 同名的
 * 子目录」共用同一个 group 键 —— 两篇不同物理源的 `x.md` 会解析成同一个 `group + relation`，
 * 被 `duplicate-index` 误判成「同一篇文档幂等重导」，**后一篇内容静默丢失**。
 * 实测：`src/root.md` + `src/<scope>/root.md` 导入后组内只剩一篇。
 *
 * 用保留键而不是空 Group（`''`）：空键在分片路径、persistCacheShape、分片枚举、路径向量
 * docId、`/api/doc/list?group=` 语义上都不可表达（详见 `sync-relation.ts` 的 5 条约束）。
 *
 * ★ 该键只用于**存储**。所有面向人的出口（CLI / Web / 日志）都要经
 *   `groupDisplayName()` 映射成「根」，不能把 `__root__` 直接铺给用户。
 */
export const ROOT_GROUP_KEY = '__root__';

/** 是否为根散文件的落点键 */
export function isRootGroup(group: string): boolean {
  return group === ROOT_GROUP_KEY;
}

/**
 * Group → 相对目录（根组 = 空串，即 Wiki 回写落在 wiki 根目录下）。
 * 用于一切「group 拼文件路径」的地方，避免在用户目录里凭空出现 `__root__/` 文件夹。
 */
export function groupToRelDir(group: string): string {
  return isRootGroup(group) ? '' : group;
}

/** Group → 展示名（根组显示为「根」；其余原样） */
export function groupDisplayName(group: string): string {
  return isRootGroup(group) ? '根' : group;
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
 * - 缺省 group：目录导入用文件相对目录（顶层子目录名即根），根下文件归 `ROOT_GROUP_KEY`；
 * - 单文件导入（rel 无目录）且缺省 group：同样归 `ROOT_GROUP_KEY`。
 *
 * ★ 2026-11-02 起不再用 `scope` 名做根：那样会与「源目录里真实存在的同名子目录」共用
 *   同一个 group 键，导致同名 relation 被误判幂等重导且后一篇内容丢失（见 ROOT_GROUP_KEY 注释）。
 */
export function resolveGroupForSource(group: string, rel: string, _scope?: string): string {
  if (group) return deriveGroupPath(group, rel);
  const dir = path.posix.dirname(toPosixPath(rel));
  return dir === '.' ? ROOT_GROUP_KEY : dir;
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
 * 用户可**显式指定**的 Group 路径。
 *
 * 与 `isSafeGroupPath` 的分工（别合并成一个）：
 * - `isSafeGroupPath` = 这个 group 键能否用于内部存储/路径拼接；
 * - 本函数 = 用户能否自己填这个名字。
 *
 * `ROOT_GROUP_KEY` 对前者合法（导入会写到它、Wiki 回写要拼它），对后者非法：
 * 根是「Group 留空」的落点，用户手写 `__root__` 会绕过语义（以为建了个普通目录）。
 * ★ 用户输入侧（`/api/import/preflight`、`/api/import/run`、数据源 group 配置、
 *   `ki sync-relation --group`）必须用本函数；内部生成值只走 `isSafeGroupPath`。
 */
export function isUserAssignableGroup(group: string): boolean {
  return isSafeGroupPath(group) && !isRootGroup(group);
}

/**
 * 关系名 = 文件名去 `.md` 与 markdown 强格式字符。
 * ★ 直接复用 `chunk-entries.deriveRelationText`（导入写 relation 用的就是它）——
 *   自己抄一份会在该实现变化时让「判据里的 relation」与「实际写入的 relation」漂移。
 */
export const relationOfPath = deriveRelationText;
