/**
 * ki 配置文件加载模块（src 版）
 *
 * 配置文件查找优先级：
 *   1. --config <path> 命令行参数（按扩展名判定 YAML / JSON 解析器）
 *   2. $HOME/.ki/config.yaml → config.yml → config.json
 *   3. 内置默认值
 *
 * 路径展开规则：$HOME / ~ → os.homedir()，相对路径 → 相对于配置文件所在目录
 *
 * 【默认路径】数据/备份目录统一 ~/.ki 用户数据根（resolveDefaultDataPaths）
 *
 * 与旧版 lib/config.ts 的差异（S-01 向量配置独立化，最小增量）：
 *   - KiConfig 新增 vectorDir / embedding 字段（zvec 向量配置）
 *   - 新增 getVectorDir() / getEmbeddingConfig() 解析函数
 *   - 配置格式 YAML 优先（REQ-11），保留 JSON 读取兼容（读到 .json 时提示迁移）
 *
 * 字段级校验（2026-08-28）：语法解析成功后、宽容归一化之前，先由
 *   config-schema.ts 校验字段名/类型/取值，不合法则 fail-loud 抛
 *   CONFIG_FIELD_INVALID（一次性列出全部问题），不再静默落默认值/NaN。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { AsyncLocalStorage } from 'node:async_hooks';

import { validateConfigFields, type ConfigIssue } from './config-schema.js';
import {
  DEFAULT_EMBEDDING_SCHEDULER,
  normalizeEmbeddingScheduler,
  type EmbeddingSchedulerConfig,
} from '../zvec-engine/embedding/batch-scheduler.js';
import { DEFAULT_QUERY_EMBED_TIMEOUT_MS } from './query-timeout.js';

// ─── 默认路径（方案 A：统一 ~/.ki/ 用户数据根，运行时数据不落源码仓库） ───

/** 用户数据根目录（config.yaml / vector / mcp-tokens / lock 均落此） */
function getKiDir(): string {
  return path.join(os.homedir(), '.ki');
}

export interface ResolvedDefaultPaths {
  dataDir: string;
  backupDir: string;
}

/**
 * 解析 dataDir / backupDir 的默认值（未显式配置时的 fallback）。
 * lib 运行时（loadConfig）与 `ki config init` 模板共用，避免两处默认逻辑漂移。
 *
 * dataDir 默认 ~/.ki/kb；includeEnv=true 时（仅 `config init` 模板）允许
 * KI_DATA_DIR 显式覆盖——运行时不做环境变量回退（见 docs/cli.md「KI_DATA_DIR 不作运行时配置来源」）。
 * backupDir 默认 ~/.ki/backup。
 *
 * 原则：不做存量路径继承（旧默认 {项目根}/kb、~/.ki-data 不再自动沿用，
 * 用户需迁移数据或显式配置 dataDir），运行时数据恒落用户目录 ~/.ki/，不随安装位置漂移。
 */
export function resolveDefaultDataPaths(includeEnv = false): ResolvedDefaultPaths {
  const home = os.homedir();

  let dataDir = path.join(home, '.ki', 'kb');
  if (includeEnv) {
    const envDataDir = process.env.KI_DATA_DIR?.trim();
    if (envDataDir) {
      dataDir = path.resolve(envDataDir);
    }
  }

  return { dataDir, backupDir: path.join(home, '.ki', 'backup') };
}

// ─── 类型 ───

export interface WikiSyncConfig {
  enabled: boolean;
  sourceDir?: string;
  /** 写回时检测 wiki 目标目录不存在/为空则自动全量补齐（默认 true；显式 false 关闭） */
  autoBackfill?: boolean;
}

/** scopes.<scope>.clean：数据清洗配置（REQ-06/07/08） */
export interface CleanConfig {
  enabled: boolean;                       // 总开关（false 等效 --no-clean，连 hooks 一起关闭）
  rules?: {
    bom?: boolean;
    frontmatter?: boolean;
    htmlComment?: boolean;
    mermaid?: boolean;
    codePath?: boolean;
    codeBlock?: boolean;
    emptyChunk?: boolean;
    keepShortSamples?: boolean;
  };
  hooks?: string[];                       // 外部清洗钩子（stdin→stdout 管道，按序执行）
}

/** scopes.<scope>.import：导入配置（REQ-08） */
export interface ImportConfig {
  extensions?: string[];                  // 格式白名单（默认 [.md]）
  maxFileSize?: number;                   // 单文件大小上限（字节，默认 1MB）
  /** 附件（本地图片）收集开关（REQ-20260904-001，默认 true；false = 不复制附件，前端显示占位块） */
  assets?: boolean;
  /** 单附件大小上限（字节，REQ-20260904-001，默认 5MB；超限跳过该附件并告警，不阻断导入） */
  maxAssetSize?: number;
}

export interface ScopeConfig {
  kbDir?: string;
  wikiSync?: WikiSyncConfig;
  clean?: CleanConfig;                    // 【新增】数据清洗配置（REQ-06/07）
  import?: ImportConfig;                  // 【新增】导入配置（REQ-08）
}

/** MCP HTTP 传输默认值（token 只走 CLI/env，绝不入配置文件） */
export interface McpHttpConfig {
  host?: string;          // 监听地址，缺省 127.0.0.1（回环，免鉴权；对外监听改 0.0.0.0）
  port?: number;          // 监听端口，缺省 DEFAULT_MCP_HTTP_PORT
  allowedHosts?: string[]; // DNS rebinding 保护允许的 Host 头（可选）
}

export interface McpConfig {
  http?: McpHttpConfig;
}

export interface VectorResourceConfig {
  /** daemon 进程最多同时保留的 Collection handle；未配置时使用保守默认值。 */
  maxOpenCollections?: number;
}

/**
 * 模型配置段（REQ-20260924-001 · S01 §3 + §9.1）。
 *
 * ⚠️ **无内置默认模型**（D8）：用户必须自填 baseURL / model / apiKey；
 * 缺任一项即由 `resolveLlmStatus` 判为未就绪（`enabled:false` + `CHAT_DISABLED`），
 * 不落任何默认模型（否则会把第三方服务与计费绑定到项目上）。
 */
export interface LlmConfig {
  /** 必填，OpenAI 兼容地址（如 https://host/compatible-mode/v1） */
  baseURL: string;
  /** 必填，用户自填，不预置默认（D8） */
  model: string;
  /** 必填，**已解析**（支持 ${ENV_VAR} 引用，与 embedding.apiKey 同款解析） */
  apiKey: string;
  /** 默认不传（不下发 max_tokens）：该上游 reasoning token 与 max_tokens 关系不确定，设小值有截断答案风险 */
  maxTokens?: number;
  /** 默认 0.7 */
  temperature?: number;
  /** 默认 300000（D13 后重估，见 S01 §9.2）；旧配置 180000 写法仍可加载 */
  requestTimeoutMs?: number;
  /** 默认 30000，仅约束"建立连接并收到首个 chunk" */
  firstByteTimeoutMs?: number;
  /** 可选，新建会话的初始提示词 */
  defaultSystemPrompt?: string;
  /** 默认 false：模型是否支持图片输入（用户手填，不自动探测 —— D11，本期不实现，字段保留） */
  supportsImages?: boolean;
  /** 默认 4：单条消息最多携带图片数（本期不实现，字段保留） */
  maxImagesPerMessage?: number;
  /** 默认 4MB：单图原始大小上限（本期不实现，字段保留） */
  maxImageBytes?: number;
  // ── v2（D13）────────────────────────────────
  /** 默认 true：模型是否支持 function calling（T10）。false → 走预检索降级（S07 §3.7） */
  supportsTools?: boolean;
  /** 默认 false：用户是否已确认"知识库内容外发"（T12）。false → 面板阻塞发送（S07 §3.8） */
  kbDisclosureAck?: boolean;
}

/** 会话存储目录默认值（S02 §3.1：独立于 kb/ 与 vectorDir，见 D4） */
export const DEFAULT_CHAT_DIR_NAME = 'chat';

export interface EmbeddingConfig {
  provider: string;      // "siliconflow" | "openai-compatible"（OpenAI 兼容客户端，实际提供商由 baseURL 决定）
  baseURL: string;       // API 端点（决定实际对接的提供商）
  model: string;         // 模型名称
  dimension: number;     // 向量维度（必须 === collection.dimension，kisearch 固定 4096）
  apiKey?: string;       // API 密钥：支持明文（sk-xxx）或环境变量引用（${VAR_NAME}）；
                         // 缺省则不解析（KI 层 fail-loud），不做任何隐式 env 回退
  /** 查询 embedding 超时（ms）；CLI/MCP/Web 的 timeout 参数按秒覆盖本值。 */
  queryTimeoutMs: number;
  scheduler?: EmbeddingSchedulerConfig;
}

export interface KiConfig {
  dataDir: string;                       // KB 源数据目录
  backupDir: string;                     // 备份目录
  vectorDir: string;                     // 【新增】zvec collection 目录
  embedding: EmbeddingConfig;            // 【新增】embedding 配置
  scopeMode: 'default' | 'strict';       // 【新增】scope 护栏模式（默认 'default'）；见 S-01 §3.5
  scopes: Record<string, ScopeConfig>;   // 保留（KB 目录映射；strict 模式下 key 兼作 scope 白名单）
  vector?: VectorResourceConfig;         // Collection handle/worker 资源治理
  mcp?: McpConfig;                       // 【新增】MCP 传输配置（仅 http 默认值；token 不入配置）
  llm?: LlmConfig;                       // 【新增】模型配置段（REQ-20260924-001）；缺失 = 未配置（fail-loud）
  chatDir?: string;                      // 【新增】会话存储根目录（默认 ~/.ki/chat，独立于 kb/）
  /** 字段校验告警（废弃字段 / null scope 条目等）：不阻断加载，由 ki doctor 报告 */
  _fieldWarnings?: ConfigIssue[];
  _configPath?: string;                  // 配置文件路径（内部）
}

// ─── 内置向量默认值 ───

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'siliconflow',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'Qwen/Qwen3-Embedding-8B',
  dimension: 4096,
  queryTimeoutMs: DEFAULT_QUERY_EMBED_TIMEOUT_MS,
  scheduler: { ...DEFAULT_EMBEDDING_SCHEDULER },
};

const DEFAULT_VECTOR_RESOURCES: VectorResourceConfig = {
  maxOpenCollections: 8,
};

/** 请求级配置快照，贯穿 daemon/HTTP 请求的排队与执行链。 */
const configSnapshotStorage = new AsyncLocalStorage<KiConfig>();

export function runWithConfigSnapshot<T>(config: KiConfig, fn: () => T): T {
  return configSnapshotStorage.run(config, fn);
}

export function getConfigSnapshot(): KiConfig | undefined {
  return configSnapshotStorage.getStore();
}

// ─── 进程内缓存 ───

let _cached: KiConfig | null = null;
/** 缓存来源文件的绝对路径（null = 未找到配置文件、当前用的是默认值） */
let _cachedFile: string | null = null;
/** 缓存来源文件的 mtimeMs 与 size；两者任一变化即视为配置已更新。 */
let _cachedMtimeMs = 0;
let _cachedSize = -1;
/** 缓存对应的 explicitPath：不同 --config 不得共用同一份缓存。 */
let _cachedExplicitPath: string | undefined;
/** 配置源不可用告警只打一次（恢复后重置），避免热路径上每次调用都刷屏。 */
let _configUnavailableWarned = false;
/**
 * 当前配置源的已知问题（文件不可用或内容解析失败），已沿用 last-known-good。
 * 沿用意味着 loadConfig 不抛错，调用方无从得知“现在用的不是磁盘上的配置”，
 * 故把原因存在这里供 /healthz 上报（否则故障静默、运维无从诊断）。
 */
let _configLoadIssue: string | null = null;
let _hintPrinted = false;

function statFingerprint(file: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(file);
    // mtime 在部分文件系统上只有秒级精度，同秒内的改写会漏检；叠加 size 降低漏检率。
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * 加载配置文件（进程内缓存 + mtime/size 失效）
 *
 * daemon 是常驻进程，缓存若永不失效就会永久持有启动那一刻的配置快照：
 *  - 用户改配置后 CLI 算出的指纹与 daemon 不同 → 全线报“配置指纹不匹配”，
 *    而旧文案把原因指向用户的 --config，排查方向被带偏；
 *  - 更严重：从配置里移除某个 scope（撤销授权）后 daemon 的白名单仍是旧的 →
 *    HTTP MCP 继续为已撤权 scope 提供服务，属 fail-open。
 * 因此每次调用用一次同步 statSync 校验来源文件（约 0.05ms；相对于配置漂移
 * 造成的授权与一致性风险，该开销可接受）。
 *
 * 注意：热失效只适用于授权/scope/token 类变更。vectorDir/dataDir 变更会使
 * daemon 内存中的 engine 与已打开句柄指向旧路径，由 assertDaemonIdentityCurrent
 * 单独 fail-loud（见 lib/scope-collection.ts），不得静默热生效。
 *
 * @param explicitPath --config 指定的路径
 */
export function loadConfig(explicitPath?: string): KiConfig {
  const snapshot = configSnapshotStorage.getStore();
  if (snapshot && (explicitPath === undefined || path.resolve(explicitPath) === snapshot._configPath)) {
    return snapshot;
  }
  const requestedPath = explicitPath ?? process.env.KI_CONFIG_PATH ?? undefined;
  if (_cached && _cachedExplicitPath === explicitPath) {
    if (_cachedFile === null) {
      // 当前用的是默认值（启动时未找到配置文件）：配置文件可能在进程启动后
      // 才被创建（ki config init），所以仍需重新查找一次。
      if (!findConfigFile(requestedPath)) return _cached;
    } else {
      const st = statFingerprint(_cachedFile);
      // _configLoadIssue 非 null 说明上一份缓存来自 last-known-good（磁盘当时不可用或
      // 内容损坏）。此时即使 stat 指纹一致也必须重读：文件可能是被 rename 回来的
      //（rename 不改 mtime，指纹与缓存完全相同），不重读会让故障状态永久残留、
      // /healthz 一直报已经不存在的配置问题。
      if (st && _configLoadIssue === null && st.mtimeMs === _cachedMtimeMs && st.size === _cachedSize) {
        return _cached;
      }
      // 已变更，或存在未解除的配置问题 → 落到下方重新加载
    }
  }

  const explicit = requestedPath !== undefined;
  let file: string | null;
  try {
    file = findConfigFile(requestedPath);
  } catch (err) {
    // 显式路径（--config / KI_CONFIG_PATH）失效：对一次性 CLI 进程应 fail-loud；
    // 但对已用该配置成功启动的常驻 daemon，运行中路径消失不应让所有请求都报错，
    // 故有 last-known-good 时沿用并告警，没有则原样抛出。
    if (canReuseLastKnownGood(explicitPath)) {
      warnConfigUnavailable(`${(err as Error).message}`);
      return _cached!;
    }
    throw err;
  }

  if (file) {
    // TOCTOU 防护：读前采一次指纹、读完再采一次，两者一致才允许入缓存。
    // 缓存指纹若在解析之后才采集，而写者恰好落在 readFileSync 与 statSync 之间，
    // 就会把「旧内容 + 新指纹」一起写进缓存 → 此后 mtime/size 恒等、热失效永远
    // 命中缓存，该次变更在本进程生命周期内**永久不可见**（实测可复现），
    // 直接抵消撤权实时生效的目标。窗口不是纳秒级：它覆盖整个 YAML.parse +
    // 字段校验 + 路径展开。不稳定时本次结果仍返回，但不入缓存（下次重读）。
    const before = statFingerprint(file);
    let parsed: KiConfig;
    try {
      parsed = parseAndExpand(file);
    } catch (err) {
      // 配置内容损坏（YAML 语法错、字段非法）：沿用 last-known-good，而不是让
      // daemon 全面不可用 —— daemon 是共享故障域（需求 §5：崩溃会同时影响 CLI 与
      // MCP），且授权口径不应因读取问题而降级或中断。问题经 stderr 告警 +
      // getConfigLoadIssue()（由 /healthz 上报）暴露，仍属 fail-loud + 给出路。
      if (canReuseLastKnownGood(explicitPath)) {
        warnConfigUnavailable(`内容解析失败：${(err as Error).message}`);
        return _cached!;
      }
      throw err;
    }
    const after = statFingerprint(file);
    const stable = before !== null && after !== null
      && before.mtimeMs === after.mtimeMs && before.size === after.size;
    _cached = parsed;
    _cachedFile = stable ? file : null;
    _cachedMtimeMs = stable ? after!.mtimeMs : 0;
    _cachedSize = stable ? after!.size : -1;
    _cachedExplicitPath = explicitPath;
    _configUnavailableWarned = false;
    _configLoadIssue = null;
    if (!stable) {
      process.stderr.write(
        `提示：配置文件 ${file} 在读取期间发生变更，本次结果不入缓存，下次调用将重新读取。\n`
      );
    }
    // 旧格式迁移提示：非显式路径下读到 config.json 时，提示一次
    if (!explicit && file.toLowerCase().endsWith('.json') && !_hintPrinted) {
      _hintPrinted = true;
      process.stderr.write(
        '提示：检测到旧版 JSON 配置，建议执行 ki config init 生成 YAML 配置\n'
      );
    }
    return _cached;
  }

  // 配置源不可用（被删/改名/全部候选缺失）。**绝对不能降级为 buildDefaults()**：
  // 那会把 scopeMode 从 strict 静默变成 default、scopes 清空 → resolveScope 从白名单
  // 校验退化为任意放行（越权 fail-open）；且 getScopeDataDir 丢掉 scope 级 kbDir →
  // KB 写入目录静默迁移、新数据与存量分裂。而身份指纹只含 vectorDir/dataDir，
  // **检测不到这类降级**，守卫会直接放行。旧实现（永久缓存）对此免疫，是热失效
  // 把它暴露了出来，因此必须保留 last-known-good。
  if (canReuseLastKnownGood(explicitPath)) {
    warnConfigUnavailable(_cachedFile ?? requestedPath ?? '默认候选路径');
    return _cached!;
  }

  _cached = buildDefaults();
  _cachedFile = null;
  _cachedMtimeMs = 0;
  _cachedSize = -1;
  _cachedExplicitPath = explicitPath;
  if (!_hintPrinted) {
    _hintPrinted = true;
    process.stderr.write(
      '提示：未找到配置文件，使用默认路径。执行 ki config init 创建配置文件\n'
    );
  }

  return _cached;
}

/** 是否具备可沿用的 last-known-good：必须是同一 explicitPath 且曾从真实文件加载过。 */
function canReuseLastKnownGood(explicitPath?: string): boolean {
  return _cached !== null && _cachedExplicitPath === explicitPath && _cachedFile !== null;
}

function warnConfigUnavailable(detail: string): void {
  _configLoadIssue = detail;
  if (_configUnavailableWarned) return;
  _configUnavailableWarned = true;
  process.stderr.write(
    `警告：配置文件不可用（${detail}），已沿用上次成功加载的配置。`
    + '授权与路径口径**不降级**；请恢复该文件，或 ki mcp stop && ki mcp --http --daemon 以新配置重启。\n'
  );
}

/**
 * 当前配置源是否有已知问题（已沿用 last-known-good）；无问题返回 null。
 * 供 /healthz 上报：沿用意味着 loadConfig 不抛错，不主动暴露就会静默。
 */
export function getConfigLoadIssue(): string | null {
  return _configLoadIssue;
}

/**
 * 仅失效缓存的「新鲜度标记」，**保留 last-known-good 内容**（区别于 resetConfigCache 的全清）。
 *
 * 供 SIGHUP 使用：下一次 loadConfig 必然重读文件（绕过 statSync 无法检测的
 * “同字节数 + 同毫秒”边界）；若重读失败，loadConfig 的 last-known-good 分支会沿用
 * 旧配置并告警。若改用「先 resetConfigCache 再 loadConfig」，则坏配置下会先销毁
 * 可用状态、再加载失败，信号回调内抛异常又无 uncaughtException 兜底 → daemon 当场崩溃。
 */
export function invalidateConfigFreshness(): void {
  _cachedMtimeMs = -1;
  _cachedSize = -1;
}

/** 测试用：清除进程内缓存 */
export function resetConfigCache(): void {
  _cached = null;
  _cachedFile = null;
  _cachedMtimeMs = 0;
  _cachedSize = -1;
  _cachedExplicitPath = undefined;
  _configUnavailableWarned = false;
  _configLoadIssue = null;
  _hintPrinted = false;
}

// ─── 配置文件查找 ───

function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`配置文件不存在：${resolved}，请检查 --config 路径`);
    }
    return resolved;
  }

  const kiDir = getKiDir();
  const candidates = [
    path.join(kiDir, 'config.yaml'),
    path.join(kiDir, 'config.yml'),
    path.join(kiDir, 'config.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ─── 路径展开 ───

function expandPath(input: string, baseDir: string): string {
  let result = input;
  const home = os.homedir();
  result = result.replace(/^\$HOME\b/, home);
  result = result.replace(/^~/, home);
  if (!path.isAbsolute(result)) {
    result = path.resolve(baseDir, result);
  }
  return result;
}

// ─── apiKey 解析（明文 / ${ENV_VAR} 引用） ───

/**
 * 解析 embedding.apiKey 配置值，支持两种写法：
 *   - 明文密钥：`apiKey: sk-xxxx` → 原样返回
 *   - 环境变量引用：`apiKey: ${MY_API_KEY}` → 从 process.env.MY_API_KEY 读取（变量名自定义）
 * 返回 undefined 的情形（由 KI 层 fail-loud，不做隐式 env 回退）：
 *   - 未配置 / 空字符串
 *   - `${VAR}` 引用但对应环境变量未设置
 */
function resolveApiKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (m) {
    const envVal = process.env[m[1]];
    return envVal && envVal.trim() ? envVal : undefined;
  }
  return trimmed;
}

// ─── 解析 + 展开 ───

function parseAndExpand(configFile: string): KiConfig {
  const ext = path.extname(configFile).toLowerCase();
  let raw: Record<string, unknown>;
  try {
    const text = fs.readFileSync(configFile, 'utf-8');
    const parsed = (ext === '.yaml' || ext === '.yml')
      ? YAML.parse(text)
      : JSON.parse(text);
    raw = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件解析失败：${configFile}\n${detail}`);
  }

  // 字段级校验：语法正确 ≠ 内容合法。字段名拼错/类型错/非法枚举值一律 fail-loud，
  // 避免过去「静默落默认值 / NaN」导致的隐性错配（null 的 scope 条目等仅告警不阻断）。
  const { errors: fieldErrors, warns: fieldWarns } = validateConfigFields(raw);
  if (fieldErrors.length > 0) {
    const MAX_SHOW = 10;
    const lines = fieldErrors.slice(0, MAX_SHOW).map((e) => `  - ${e.path}：${e.message}`);
    if (fieldErrors.length > MAX_SHOW) {
      lines.push(`  ...（另有 ${fieldErrors.length - MAX_SHOW} 处，修正以上问题后继续检查）`);
    }
    throw new Error(
      `CONFIG_FIELD_INVALID: 配置文件字段校验失败：${configFile}（共 ${fieldErrors.length} 处）\n${lines.join('\n')}`
    );
  }

  const configDir = path.dirname(configFile);

  // 未显式配置时使用统一默认路径（~/.ki/kb、~/.ki/backup，见 resolveDefaultDataPaths）
  const { dataDir: defaultDataDir, backupDir: defaultBackupDir } = resolveDefaultDataPaths();

  const dataDir = raw.dataDir
    ? expandPath(String(raw.dataDir), configDir)
    : defaultDataDir;

  const backupDir = raw.backupDir
    ? expandPath(String(raw.backupDir), configDir)
    : defaultBackupDir;

  // 【新增】vectorDir：默认 ~/.ki/vector（zvec collection 目录）
  const vectorDir = raw.vectorDir
    ? expandPath(String(raw.vectorDir), configDir)
    : path.join(os.homedir(), '.ki', 'vector');

  // 【新增】chatDir：会话存储根目录（REQ-20260924-001 · S02 §3.1），默认 ~/.ki/chat。
  // 独立于 kb/ 与 vectorDir：快照恢复/删除 Group 只操作 kb/，会话因此天然免疫（D4）。
  const chatDir = raw.chatDir
    ? expandPath(String(raw.chatDir), configDir)
    : path.join(os.homedir(), '.ki', DEFAULT_CHAT_DIR_NAME);

  // 【新增】llm：模型配置段（REQ-20260924-001 · S01 §3 + §9.1）。
  // ⚠️ 不给默认模型（D8）：缺失时留 undefined，由 resolveLlmStatus 判「未就绪」返回
  // enabled:false + CHAT_DISABLED（GET /api/chat/config 仍返回 200 + ok:true）。
  // apiKey 复用 resolveApiKey 预解析（与 embedding.apiKey 同款）：支持 ${ENV} 且集中一处解析规则。
  let llm: LlmConfig | undefined;
  if (raw.llm && typeof raw.llm === 'object' && !Array.isArray(raw.llm)) {
    const rl = raw.llm as Record<string, unknown>;
    llm = {
      baseURL: rl.baseURL ? String(rl.baseURL) : '',
      model: rl.model ? String(rl.model) : '',
      apiKey: resolveApiKey(rl.apiKey) ?? '',
      maxTokens: rl.maxTokens !== undefined ? Number(rl.maxTokens) : undefined,
      temperature: rl.temperature !== undefined ? Number(rl.temperature) : undefined,
      requestTimeoutMs: rl.requestTimeoutMs !== undefined ? Number(rl.requestTimeoutMs) : undefined,
      firstByteTimeoutMs: rl.firstByteTimeoutMs !== undefined ? Number(rl.firstByteTimeoutMs) : undefined,
      defaultSystemPrompt: rl.defaultSystemPrompt !== undefined ? String(rl.defaultSystemPrompt) : undefined,
      supportsImages: rl.supportsImages !== undefined ? Boolean(rl.supportsImages) : undefined,
      maxImagesPerMessage: rl.maxImagesPerMessage !== undefined ? Number(rl.maxImagesPerMessage) : undefined,
      maxImageBytes: rl.maxImageBytes !== undefined ? Number(rl.maxImageBytes) : undefined,
      supportsTools: rl.supportsTools !== undefined ? Boolean(rl.supportsTools) : undefined,
      kbDisclosureAck: rl.kbDisclosureAck !== undefined ? Boolean(rl.kbDisclosureAck) : undefined,
    };
  }

  // 【新增】embedding：与默认合并，允许部分覆盖
  const rawEmbedding = (raw.embedding && typeof raw.embedding === 'object')
    ? raw.embedding as Record<string, unknown>
    : {};
  // scheduler 关系约束失败时必须能定位到文件：报错带上配置文件路径，
  // 否则用户只看到"某字段不能大于某字段"，不知道该改哪个文件（甚至不知道是配置问题）。
  let scheduler: EmbeddingSchedulerConfig;
  try {
    scheduler = normalizeEmbeddingScheduler(
      rawEmbedding.scheduler && typeof rawEmbedding.scheduler === 'object'
        ? rawEmbedding.scheduler as Partial<EmbeddingSchedulerConfig>
        : undefined,
    );
  } catch (err) {
    throw new Error(`配置文件 ${configFile} 的 embedding.scheduler 非法：${(err as Error).message}`);
  }
  const embedding: EmbeddingConfig = {
    provider: rawEmbedding.provider ? String(rawEmbedding.provider) : DEFAULT_EMBEDDING.provider,
    baseURL: rawEmbedding.baseURL ? String(rawEmbedding.baseURL) : DEFAULT_EMBEDDING.baseURL,
    model: rawEmbedding.model ? String(rawEmbedding.model) : DEFAULT_EMBEDDING.model,
    dimension: rawEmbedding.dimension !== undefined ? Number(rawEmbedding.dimension) : DEFAULT_EMBEDDING.dimension,
    apiKey: resolveApiKey(rawEmbedding.apiKey),
    queryTimeoutMs: rawEmbedding.queryTimeoutMs !== undefined
      ? Number(rawEmbedding.queryTimeoutMs)
      : DEFAULT_EMBEDDING.queryTimeoutMs,
    scheduler,
  };

  const rawVector = raw.vector && typeof raw.vector === 'object'
    ? raw.vector as Record<string, unknown>
    : {};
  const vector: VectorResourceConfig = {
    maxOpenCollections: rawVector.maxOpenCollections !== undefined
      ? Number(rawVector.maxOpenCollections)
      : DEFAULT_VECTOR_RESOURCES.maxOpenCollections,
  };

  // 【新增】scopeMode：仅接受 'strict'，其余（含缺省/非法值）一律归为 'default'
  const scopeMode: 'default' | 'strict' = raw.scopeMode === 'strict' ? 'strict' : 'default';

  // 【新增】mcp.http：仅解析默认监听地址/端口/allowedHosts（token 不从配置读取）
  let mcp: McpConfig | undefined;
  if (raw.mcp && typeof raw.mcp === 'object') {
    const rawMcp = raw.mcp as Record<string, unknown>;
    if (rawMcp.http && typeof rawMcp.http === 'object') {
      const h = rawMcp.http as Record<string, unknown>;
      mcp = {
        http: {
          host: h.host ? String(h.host) : undefined,
          port: h.port !== undefined ? Number(h.port) : undefined,
          allowedHosts: Array.isArray(h.allowedHosts)
            ? (h.allowedHosts as unknown[]).map(String)
            : undefined,
        },
      };
    }
  }

  const scopes: Record<string, ScopeConfig> = {};
  if (raw.scopes && typeof raw.scopes === 'object') {
    for (const [name, sc] of Object.entries(raw.scopes as Record<string, unknown>)) {
      if (sc && typeof sc === 'object') {
        const s = sc as Record<string, unknown>;
        const ws = s.wikiSync as Record<string, unknown> | undefined;
        // 【新增】clean 配置（REQ-06/07）
        let clean: CleanConfig | undefined;
        if (s.clean && typeof s.clean === 'object') {
          const c = s.clean as Record<string, unknown>;
          const cRules = c.rules && typeof c.rules === 'object' ? c.rules as Record<string, unknown> : undefined;
          clean = {
            enabled: c.enabled !== false,  // 默认 true
            rules: cRules ? {
              bom: cRules.bom !== false,
              frontmatter: cRules.frontmatter !== false,
              htmlComment: cRules.htmlComment !== false,
              mermaid: cRules.mermaid !== false,
              codePath: cRules.codePath !== false,
              codeBlock: cRules.codeBlock !== false,
              emptyChunk: cRules.emptyChunk !== false,
              keepShortSamples: cRules.keepShortSamples !== false,
            } : undefined,
            hooks: Array.isArray(c.hooks) ? (c.hooks as unknown[]).map(String) : undefined,
          };
        }
        // 【新增】import 配置（REQ-08）
        let imp: ImportConfig | undefined;
        if (s.import && typeof s.import === 'object') {
          const im = s.import as Record<string, unknown>;
          imp = {
            extensions: Array.isArray(im.extensions) ? (im.extensions as unknown[]).map(String) : undefined,
            maxFileSize: im.maxFileSize !== undefined ? Number(im.maxFileSize) : undefined,
          };
        }
        scopes[name] = {
          kbDir: s.kbDir ? expandPath(String(s.kbDir), configDir) : undefined,
          wikiSync: ws ? {
            enabled: ws.enabled !== false,  // 默认 true
            sourceDir: ws.sourceDir ? expandPath(String(ws.sourceDir), configDir) : undefined,
            autoBackfill: ws.autoBackfill !== false,  // 默认 true
          } : undefined,
          clean,
          import: imp,
        };
      }
    }
  }

  return {
    dataDir, backupDir, vectorDir, embedding, scopeMode, scopes, vector, mcp, llm, chatDir,
    _fieldWarnings: fieldWarns,
    _configPath: configFile,
  };
}

// ─── 内置默认值 ───

function buildDefaults(): KiConfig {
  const { dataDir, backupDir } = resolveDefaultDataPaths();
  return {
    dataDir,
    backupDir,
    vectorDir: path.join(os.homedir(), '.ki', 'vector'),
    embedding: { ...DEFAULT_EMBEDDING, scheduler: { ...DEFAULT_EMBEDDING_SCHEDULER } },
    vector: { ...DEFAULT_VECTOR_RESOURCES },
    scopeMode: 'default',
    scopes: {},
    // llm 刻意不给默认值（D8）：无配置即"未配置"，由 resolveLlmStatus 判 CHAT_DISABLED。
    // chatDir 给默认值（会话目录是纯本地路径，无需用户配置即可工作）。
    chatDir: path.join(os.homedir(), '.ki', DEFAULT_CHAT_DIR_NAME),
  };
}

// ─── 辅助函数 ───

/**
 * 获取指定 scope 的数据目录
 * 优先使用 scope 级 kbDir（自动拼接 kb/{scope} 子目录，避免污染源码目录），
 * fallback 到全局 dataDir/{scope}
 */
export function getScopeDataDir(config: KiConfig, scope: string): string {
  const sc = config.scopes[scope];
  if (sc?.kbDir) return path.join(sc.kbDir, 'kb', scope);
  return path.join(config.dataDir, scope);
}

/**
 * 获取备份根目录
 */
export function getBackupDir(config: KiConfig): string {
  return config.backupDir;
}

/**
 * 获取指定 scope 的 wikiSync 配置
 */
export function getScopeWikiSync(config: KiConfig, scope: string): WikiSyncConfig | null {
  return config.scopes[scope]?.wikiSync ?? null;
}

/**
 * 【新增】获取指定 scope 的 clean 配置（无配置返回 null，调用方用默认值）
 */
export function getScopeCleanConfig(config: KiConfig, scope: string): CleanConfig | null {
  return config.scopes[scope]?.clean ?? null;
}

/**
 * 【新增】获取指定 scope 的 import 配置（无配置返回 null，调用方用默认值）
 */
export function getScopeImportConfig(config: KiConfig, scope: string): ImportConfig | null {
  return config.scopes[scope]?.import ?? null;
}

/**
 * 【新增】获取 zvec collection 目录
 */
export function getVectorDir(config: KiConfig): string {
  return config.vectorDir;
}

/**
 * 【新增】获取 embedding 配置
 */
export function getEmbeddingConfig(config: KiConfig): EmbeddingConfig {
  return config.embedding;
}

/**
 * 【新增】获取 scope 护栏模式（默认 'default'）
 */
export function getScopeMode(config: KiConfig): 'default' | 'strict' {
  return config.scopeMode;
}

/**
 * 【新增】scope 护栏解析（S-01 §3.5 / S-06 §3.5 N19）
 *   - default 档：scope 缺省/空 → 'default'，任意值放行（zvec 自动建）
 *   - strict 档：必须显式传非空 scope，且必须在 config.scopes 白名单内，否则抛错（fail-loud）
 * 注：字符集合法性由 scope.ts::validateScope 负责，本函数只管模式策略，不做字符校验。
 * @throws Error strict 档下未传或未注册 scope 时
 */
export function resolveScope(config: KiConfig, scope?: string): string {
  const trimmed = scope?.trim();
  if (getScopeMode(config) === 'strict') {
    if (!trimmed) {
      throw new Error('scopeMode=strict：必须显式传入 scope 参数');
    }
    if (!Object.prototype.hasOwnProperty.call(config.scopes, trimmed)) {
      const known = Object.keys(config.scopes);
      throw new Error(
        `unknown scope: "${trimmed}"（scopeMode=strict）。已注册 scope：${known.length ? known.join(', ') : '（无，请先在配置 scopes 中注册）'}`
      );
    }
    return trimmed;
  }
  return trimmed || 'default';
}

// ─── 配置写回（scope delete 用：移除 scopes 条目） ───

export interface RemoveScopeResult {
  removed: boolean;
  configPath?: string;
  reason?: string;
}

/**
 * 从配置文件的 scopes 中移除指定 scope 条目（尽力而为）。
 * - 无配置文件 / scope 不在 scopes 中 → removed:false（非错误，default 档下 scopes 常为空）
 * - YAML：用 Document API 保留注释与格式
 * - JSON：解析后删除并写回
 * 写回后清除配置缓存（resetConfigCache）。
 */
export function removeScopeFromConfigFile(scope: string): RemoveScopeResult {
  const config = loadConfig();
  const configPath = config._configPath;
  if (!configPath || !fs.existsSync(configPath)) {
    return { removed: false, reason: '未找到配置文件，无 scopes 条目可移除' };
  }
  const ext = path.extname(configPath).toLowerCase();
  const text = fs.readFileSync(configPath, 'utf-8');

  if (ext === '.yaml' || ext === '.yml') {
    const doc = YAML.parseDocument(text);
    if (!doc.hasIn(['scopes', scope])) {
      return { removed: false, configPath, reason: `配置 scopes 中无 "${scope}"` };
    }
    doc.deleteIn(['scopes', scope]);
    atomicWriteConfig(configPath, doc.toString());
    resetConfigCache();
    return { removed: true, configPath };
  }

  // JSON
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const scopes = (parsed.scopes && typeof parsed.scopes === 'object')
    ? parsed.scopes as Record<string, unknown>
    : null;
  if (!scopes || !(scope in scopes)) {
    return { removed: false, configPath, reason: `配置 scopes 中无 "${scope}"` };
  }
  delete scopes[scope];
  atomicWriteConfig(configPath, JSON.stringify(parsed, null, 2) + '\n');
  resetConfigCache();
  return { removed: true, configPath };
}

/**
 * 原子写配置文件（临时文件 + rename），并保留原文件权限。
 *
 * 两个理由：
 *  1. 直接 writeFileSync 会让并发的 daemon（loadConfig 现在每次 statSync + 按需重读）
 *     有机会读到**半截文件** → YAML 解析失败 → 沿用 last-known-good 并告警，
 *     看起来像“配置坏了”，实际只是写入未完成。同目录 rename 是原子的，消除该窗口。
 *  2. rename 会用临时文件的权限覆盖目标，而配置可能含 apiKey 明文；
 *     原本 0600 的文件被改成默认 0644 就是密钥泄露，故必须显式沿用原 mode。
 */
function atomicWriteConfig(configPath: string, content: string): void {
  const tmp = `${configPath}.tmp-${process.pid}`;
  let mode: number | undefined;
  try {
    mode = fs.statSync(configPath).mode & 0o777;
  } catch {
    /* 目标不存在（首次创建）：用 writeFileSync 默认权限 */
  }
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8');
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件残留无害 */ }
    throw err;
  }
}
