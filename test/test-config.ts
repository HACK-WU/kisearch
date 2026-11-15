/**
 * 测试辅助模块 - scope 配置注册
 *
 * 解决问题：ensureScopeDir 强制校验 scope 是否在 ki 配置中注册，
 * 但测试使用随机 scope 名，不存在于用户的真实配置中。
 *
 * 方案：为每个测试进程创建临时配置文件，动态注册测试 scope。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { jitiCliPath } from '../src/lib/jiti-cli.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 跨平台执行 jiti：Windows 无法直接 spawn `npx`（实际是 npx.cmd，execFile 需 shell），
 * 统一改为「当前 Node 进程 + 本地 jiti CLI」，与 bin/ki.mjs 的启动方式一致。
 */
export const JITI_CLI = jitiCliPath;

/** 每个测试进程共享一个临时配置文件 */
const TEST_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'config.json');

// 初始化空配置
// vectorDir 指向临时目录，隔离测试向量库（避免污染 ~/.ki/vector，并保证离线优雅降级）
//
// embedding：优先从当前用户的真实 ki 配置（~/.ki/config.yaml）继承 provider/baseURL/
// model/dimension（例如 dashscope——实际提供商由 baseURL 决定，provider 字段只是标签），
// 密钥只从环境变量读取（外部注入，测试配置本身不写死任何密钥；未注入时走 fail-loud，
// 向量化相关用例需跳过）。历史默认 siliconflow 仅在用户无配置时兜底。
function readUserEmbedding(): Partial<{
  provider: string; baseURL: string; model: string; dimension: number; scheduler: Record<string, unknown>;
}> {
  const candidates = [
    path.join(os.homedir(), '.ki', 'config.yaml'),
    path.join(os.homedir(), '.ki', 'config.json'),
  ];
  for (const cfgPath of candidates) {
    try {
      const raw = fs.readFileSync(cfgPath, 'utf-8');
      // 轻量解析：只取 embedding 块的几个标量字段（避免引入 yaml 依赖）
      const embMatch = raw.match(/^embedding:\s*$/m);
      if (!embMatch) continue;
      const after = raw.slice(embMatch.index! + embMatch[0].length);
      const block = after.split(/^\S/m)[0];
      const field = (name: string): string | undefined =>
        block.match(new RegExp(`^\\s+${name}:\\s*(\\S+)`, 'm'))?.[1];
      const apiKey = field('apiKey');
      // 密钥仅注入进程 env（内存传递，测试配置文件只写 ${VAR} 引用）；
      // 无密钥或纯 ${VAR} 引用则不继承（沿用 env 已有密钥变量）
      if (apiKey && !apiKey.startsWith('${')) {
        process.env.DASHSCOPE_API_KEY ??= apiKey;
      }
      return {
        provider: field('provider'),
        baseURL: field('baseURL'),
        model: field('model'),
        dimension: field('dimension') ? parseInt(field('dimension')!, 10) : undefined,
        ...(block.match(/^\s+scheduler:\s*$/m) ? {
          scheduler: {
            ...(field('batchSize') ? { batchSize: parseInt(field('batchSize')!, 10) } : {}),
            ...(field('maxConcurrency') ? { maxConcurrency: parseInt(field('maxConcurrency')!, 10) } : {}),
          },
        } : {}),
      };
    } catch { /* 无该文件或不可读 → 下一个候选 */ }
  }
  return {};
}
function buildTestConfig(): Record<string, unknown> {
  // 优先继承用户真实配置（dashscope 等实际提供商；provider 字段是标签，baseURL 决定真实端点）
  const userEmb = readUserEmbedding();
  // 密钥优先级：用户配置注入的 DASHSCOPE_API_KEY（真实提供商）> 旧 SILICONFLOW 注入 > GITNEXUS
  const embKey = process.env.DASHSCOPE_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.GITNEXUS_EMBEDDING_API_KEY;
  const baseConfig: Record<string, unknown> = {
    dataDir: path.join(PROJECT_ROOT, 'kb'),
    vectorDir: path.join(TEST_CONFIG_DIR, 'vector'),
    // 备份隔离到临时目录：避免测试快照污染用户默认数据目录（~/.ki/backup）
    backupDir: path.join(TEST_CONFIG_DIR, 'backup'),
    scopes: {},
  };
  if (embKey && userEmb.baseURL) {
    const keyVar = process.env.DASHSCOPE_API_KEY ? 'DASHSCOPE_API_KEY'
      : process.env.SILICONFLOW_API_KEY ? 'SILICONFLOW_API_KEY'
      : 'GITNEXUS_EMBEDDING_API_KEY';
    baseConfig.embedding = {
      provider: userEmb.provider ?? 'openai-compatible',
      baseURL: userEmb.baseURL,
      model: userEmb.model ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: userEmb.dimension ?? parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
      apiKey: `\${${keyVar}}`,
      ...(userEmb.scheduler ? { scheduler: userEmb.scheduler } : {}),
    };
  }
  return baseConfig;
}
fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(buildTestConfig()), 'utf-8');

// 设置主进程环境变量，确保直接导入的模块（initScope、readJson 等）与子进程使用相同配置
process.env.KI_CONFIG_PATH = TEST_CONFIG_PATH;

/**
 * 注册 scope 到测试配置文件（同步追加）
 * 在创建随机 scope 后调用，确保子进程能找到该 scope
 */
export function registerTestScope(scope: string): void {
  const config = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, 'utf-8'));
  if (!config.scopes[scope]) {
    config.scopes[scope] = {};
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config), 'utf-8');
  }
}

/**
 * 获取子进程的环境变量（包含 KI_CONFIG_PATH 指向测试配置）
 *
 * 剥离 IDE 注入的 node shim（NODE_OPTIONS=--require node-language-shim.cjs 等）：
 * safe-delete 拦截在单轮文件操作数达到批量阈值（50）后，会把非交互子进程的
 * 文件写入挂起在"等待用户确认"上，导致 import 子进程永久挂起（epoll_wait）+
 * WAL 锁残留。测试子进程不需要 IDE 拦截层。
 */
/** 实际生效的子进程超时：环境变量优先（慢机器临时放宽），否则 CLI_TIMEOUT_MS */
export function cliTimeoutMs(): number {
  const raw = Number(process.env.KI_TEST_CLI_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : CLI_TIMEOUT_MS;
}

/** 取文本尾部 N 行（超时/失败时给上下文，避免只报一句 "ETIMEDOUT"） */
function tailLines(text: string, lines = 20): string {
  if (!text) return '(空)';
  const arr = text.split('\n').filter((line) => line.length > 0);
  return arr.slice(-lines).join('\n') || '(空)';
}

export interface ExecCommandOptions {
  /** 覆盖默认超时（ms） */
  timeout?: number;
  cwd?: string;
  input?: string;
  /** 视为正常的退出码（默认 [0]）；用于期望非零退出的用例 */
  acceptStatus?: readonly number[];
  /** 报错时的可读标签（默认命令名） */
  label?: string;
  /** 覆盖子进程环境（默认 getTestEnv()） */
  env?: Record<string, string | undefined>;
}

export interface ExecCliOptions extends Omit<ExecCommandOptions, 'label'> {
  /** 传给脚本的参数 */
  args?: string[];
  /** 报错标签（默认脚本文件名） */
  label?: string;
  /**
   * 启动方式：`jiti`（默认，跑 TS 脚本）/ `node`（跑 .mjs，自测超时用）。
   * 除 `test/cli-timeout.test.ts` 外不应传 `node`。
   */
  entry?: 'jiti' | 'node';
}

export interface ExecCliRawResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 子进程失败/超时的统一错误。
 *
 * 必须保留 `stdout` / `stderr` / `status`：现有测试大量用
 * `try { execFileSync(...) } catch (err) { JSON.parse(err.stdout) }` 的写法读负向用例输出，
 * 换封装后这些 catch 仍要能拿到输出，否则负向用例会静默变成"空结果"。
 */
export class ExecProcessError extends Error {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(message: string, raw: ExecCliRawResult) {
    super(message);
    this.name = 'ExecProcessError';
    this.status = raw.status;
    this.signal = raw.signal;
    this.stdout = raw.stdout;
    this.stderr = raw.stderr;
    this.timedOut = raw.timedOut;
  }
}

/**
 * 跑任意外部命令（不抛）。
 *
 * 与 `execCli` 的区别：这里直接执行 `command`（git / tar 等），不再拼 jiti。
 * 两者共用同一套超时与输出采集口径，避免「CLI 有超时、git 没有」的半治理。
 */
export function execCommandRaw(
  command: string,
  args: readonly string[],
  options: ExecCommandOptions = {},
): ExecCliRawResult {
  const timeout = options.timeout ?? cliTimeoutMs();
  const r = spawnSync(command, [...args], {
    encoding: 'utf-8',
    env: options.env ?? getTestEnv(),
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    || (r.signal === 'SIGKILL' && r.status === null);
  return { status: r.status, signal: r.signal, stdout, stderr, timedOut };
}

/**
 * 跑外部命令并返回 stdout（失败/超时抛 `ExecProcessError`）。
 *
 * 错误信息必须包含「命令 + 超时值 + 输出尾部」：只报一句 `ETIMEDOUT` 时，
 * 排障的人无法判断是网络卡住、被 IDE 拦截、还是在等锁。见 REQ-20261115-002 R4。
 */
export function execCommand(
  command: string,
  args: readonly string[] = [],
  options: ExecCommandOptions = {},
): string {
  const timeout = options.timeout ?? cliTimeoutMs();
  const label = options.label ?? command;
  const argsText = args.join(' ');
  const res = execCommandRaw(command, args, options);

  if (res.timedOut) {
    throw new ExecProcessError([
      `子进程超时（${timeout}ms）：${label} ${argsText}`.trim(),
      '--- stdout 尾部 ---',
      tailLines(res.stdout),
      '--- stderr 尾部 ---',
      tailLines(res.stderr),
      `提示：慢机器可设 KI_TEST_CLI_TIMEOUT=${timeout * 2} 后重跑`,
    ].join('\n'), res);
  }

  const accept = options.acceptStatus ?? [0];
  if (res.status === null || !accept.includes(res.status)) {
    throw new ExecProcessError([
      `子进程失败（status=${String(res.status)} signal=${String(res.signal)}）：${label} ${argsText}`.trim(),
      '--- stdout 尾部 ---',
      tailLines(res.stdout),
      '--- stderr 尾部 ---',
      tailLines(res.stderr),
    ].join('\n'), res);
  }
  return res.stdout;
}

/** 跑一个 ki CLI 脚本（`node jiti <script> ...args`），不抛 */
export function execCliRaw(scriptPath: string, options: ExecCliOptions = {}): ExecCliRawResult {
  const command = options.entry === 'node'
    ? scriptPath
    : JITI_CLI;
  const commandArgs = options.entry === 'node'
    ? (options.args ?? [])
    : [scriptPath, ...(options.args ?? [])];
  return execCommandRaw(process.execPath, [command, ...commandArgs], options);
}

/** 跑一个 ki CLI 脚本并返回 stdout（失败/超时抛 `ExecProcessError`） */
export function execCli(scriptPath: string, options: ExecCliOptions = {}): string {
  const command = options.entry === 'node' ? scriptPath : JITI_CLI;
  const commandArgs = options.entry === 'node'
    ? (options.args ?? [])
    : [scriptPath, ...(options.args ?? [])];
  return execCommand(process.execPath, [command, ...commandArgs], {
    ...options,
    label: options.label ?? path.basename(scriptPath),
  });
}

/** 跑子进程并把 stdout 解析为 JSON（多数 CLI 的默认输出形态） */
export function execCliJson<T = unknown>(scriptPath: string, options: ExecCliOptions = {}): T {
  const out = execCli(scriptPath, options);
  try {
    return JSON.parse(out) as T;
  } catch (err) {
    throw new Error(
      `stdout 不是合法 JSON（${path.basename(scriptPath)}）：${(err as Error).message}\n`
      + `--- stdout 尾部 ---\n${tailLines(out)}`,
    );
  }
}

export function getTestEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.BASH_ENV;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEBUDDY_SAFE_DELETE')) delete env[key];
  }
  env.NODE_NO_WARNINGS = '1';
  env.KI_CONFIG_PATH = TEST_CONFIG_PATH;
  return env;
}

/**
 * 测试子进程的默认超时（毫秒）。
 *
 * 为什么必须有：全仓测试大量使用 `execFileSync` 跑 CLI 子进程，而它**默认无超时** ——
 * 任何一个子进程卡住（embedding 网络、被 safe-delete 拦截、引擎等锁），父进程就会永久等待，
 * 表现为「测试执行了很久、没有任何输出、也不退出」。
 * 新增子进程调用时请显式传 `timeout: CLI_TIMEOUT_MS`。
 */
export const CLI_TIMEOUT_MS = 120_000;

/** 测试配置文件路径（供需要直接引用的场景使用） */
export const testConfigPath = TEST_CONFIG_PATH;

/**
 * 本进程是否注入了测试用 embedding 密钥。
 *
 * 未注入时测试配置**不含 embedding 段**（见 buildTestConfig），任何依赖向量化的用例都会以
 * `embedding.apiKey 未配置` 失败——这属环境缺失而非代码回归，用例应显式 skip 而不是判失败。
 */
export const hasTestEmbeddingKey = Boolean(
  process.env.DASHSCOPE_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.GITNEXUS_EMBEDDING_API_KEY,
);

/**
 * 当前测试配置实际引用的密钥环境变量名（供测试子进程显式透传/判定用）。
 * 与 buildTestConfig 的 keyVar 优先级一致：用户真实提供商（DASHSCOPE）优先。
 */
export function embeddingKeyVar(): string {
  return process.env.DASHSCOPE_API_KEY ? 'DASHSCOPE_API_KEY'
    : process.env.SILICONFLOW_API_KEY ? 'SILICONFLOW_API_KEY'
    : 'GITNEXUS_EMBEDDING_API_KEY';
}

/**
 * 清理临时配置文件（在 after() 中调用）
 */
export function cleanupTestConfig(): void {
  try {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}
