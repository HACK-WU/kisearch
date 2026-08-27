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
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';

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

export interface EmbeddingConfig {
  provider: string;      // "siliconflow" | "openai-compatible"（OpenAI 兼容客户端，实际提供商由 baseURL 决定）
  baseURL: string;       // API 端点（决定实际对接的提供商）
  model: string;         // 模型名称
  dimension: number;     // 向量维度（必须 === collection.dimension，kisearch 固定 4096）
  apiKey?: string;       // API 密钥：支持明文（sk-xxx）或环境变量引用（${VAR_NAME}）；
                         // 缺省则不解析（KI 层 fail-loud），不做任何隐式 env 回退
}

export interface KiConfig {
  dataDir: string;                       // KB 源数据目录
  backupDir: string;                     // 备份目录
  vectorDir: string;                     // 【新增】zvec collection 目录
  embedding: EmbeddingConfig;            // 【新增】embedding 配置
  scopeMode: 'default' | 'strict';       // 【新增】scope 护栏模式（默认 'default'）；见 S-01 §3.5
  scopes: Record<string, ScopeConfig>;   // 保留（KB 目录映射；strict 模式下 key 兼作 scope 白名单）
  mcp?: McpConfig;                       // 【新增】MCP 传输配置（仅 http 默认值；token 不入配置）
  _configPath?: string;                  // 配置文件路径（内部）
}

// ─── 内置向量默认值 ───

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'siliconflow',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'Qwen/Qwen3-Embedding-8B',
  dimension: 4096,
};

// ─── 进程内缓存 ───

let _cached: KiConfig | null = null;
let _hintPrinted = false;

/**
 * 加载配置文件（进程内缓存，只读一次）
 * @param explicitPath --config 指定的路径
 */
export function loadConfig(explicitPath?: string): KiConfig {
  if (_cached) return _cached;

  const configPath = explicitPath ?? process.env.KI_CONFIG_PATH ?? undefined;
  const explicit = configPath !== undefined;
  const file = findConfigFile(configPath);

  if (file) {
    _cached = parseAndExpand(file);
    // 旧格式迁移提示：非显式路径下读到 config.json 时，提示一次
    if (!explicit && file.toLowerCase().endsWith('.json') && !_hintPrinted) {
      _hintPrinted = true;
      process.stderr.write(
        '提示：检测到旧版 JSON 配置，建议执行 ki config init 生成 YAML 配置\n'
      );
    }
  } else {
    _cached = buildDefaults();
    if (!_hintPrinted) {
      _hintPrinted = true;
      process.stderr.write(
        '提示：未找到配置文件，使用默认路径。执行 ki config init 创建配置文件\n'
      );
    }
  }

  return _cached;
}

/** 测试用：清除进程内缓存 */
export function resetConfigCache(): void {
  _cached = null;
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

  // 【新增】embedding：与默认合并，允许部分覆盖
  const rawEmbedding = (raw.embedding && typeof raw.embedding === 'object')
    ? raw.embedding as Record<string, unknown>
    : {};
  const embedding: EmbeddingConfig = {
    provider: rawEmbedding.provider ? String(rawEmbedding.provider) : DEFAULT_EMBEDDING.provider,
    baseURL: rawEmbedding.baseURL ? String(rawEmbedding.baseURL) : DEFAULT_EMBEDDING.baseURL,
    model: rawEmbedding.model ? String(rawEmbedding.model) : DEFAULT_EMBEDDING.model,
    dimension: rawEmbedding.dimension !== undefined ? Number(rawEmbedding.dimension) : DEFAULT_EMBEDDING.dimension,
    apiKey: resolveApiKey(rawEmbedding.apiKey),
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

  return { dataDir, backupDir, vectorDir, embedding, scopeMode, scopes, mcp, _configPath: configFile };
}

// ─── 内置默认值 ───

function buildDefaults(): KiConfig {
  const { dataDir, backupDir } = resolveDefaultDataPaths();
  return {
    dataDir,
    backupDir,
    vectorDir: path.join(os.homedir(), '.ki', 'vector'),
    embedding: { ...DEFAULT_EMBEDDING },
    scopeMode: 'default',
    scopes: {},
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
    fs.writeFileSync(configPath, doc.toString(), 'utf-8');
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
  fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  resetConfigCache();
  return { removed: true, configPath };
}
