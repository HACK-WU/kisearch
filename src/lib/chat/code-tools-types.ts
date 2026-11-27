/**
 * code-tools-types.ts —— 对话侧源码只读工具的类型契约（REQ-20261127-001 · S-01）
 *
 * 独立成文件的原因：`mcp-tool-registry.ts` 运行时 import `code-tools.ts`（并入工具面），
 * 而 `code-tools.ts` 只 type-import 注册表 —— 类型放这里，两边都只依赖类型，避免运行期环。
 */

/** 一次对话可读的代码目录 */
export interface ChatCodeRoot {
  /** 默认 = 库名；多根时作为 `root` 入参 */
  readonly label: string;
  /** validateTargetRootDir 后的真实路径 */
  readonly realRoot: string;
  /** 同一 realRoot 的其它库名：仅展示，不作为 `root` 入参 */
  readonly aliases: readonly string[];
}

/** 未参与读取的原因码（UI 按码映射文案） */
export type CodeRootSkipReason =
  | 'unmapped'
  | 'unreadable'
  | 'strict-skipped'
  | 'view-empty'
  | 'view-error'
  | 'forbidden';

export interface ChatCodeRootsResult {
  readonly roots: readonly ChatCodeRoot[];
  readonly skipped: ReadonlyArray<{ label: string; reason: CodeRootSkipReason }>;
}

/**
 * 单次工具调用的运行期上下文。
 *
 * · `codeRoots`：tool-loop 每轮解析一次后传入，避免工具内部重复 stat；
 * · `signal`：会话级中止信号；工具内部再叠加 10s 超时。
 */
export interface ChatToolRunContext {
  readonly codeRoots?: readonly ChatCodeRoot[];
  readonly signal?: AbortSignal;
}
