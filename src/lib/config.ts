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
 * 【循环依赖解决】本模块自行计算 KI_ROOT，不 import constants.ts
 *
 * 与 scripts/lib/config.ts 的差异（S-01 向量配置独立化，最小增量）：
 *   - KiConfig 新增 vectorDir / embedding 字段（zvec 向量配置）
 *   - 新增 getVectorDir() / getEmbeddingConfig() 解析函数
 *   - 配置格式 YAML 优先（REQ-11），保留 JSON 读取兼容（读到 .json 时提示迁移）
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

// ─── 自行计算 KI_ROOT（与 constants.ts 相同算法，打破循环依赖） ───
// src/lib/ 上溯 2 级到项目根（与 scripts/lib/ 同为 2 级，一致）
const __filename_cfg = fileURLToPath(import.meta.url);
const __dirname_cfg = path.dirname(__filename_cfg);
const KI_ROOT = path.resolve(__dirname_cfg, '..', '..');

// ─── 类型 ───

export interface WikiSyncConfig {
  enabled: boolean;
  sourceDir?: string;
}

export interface ScopeConfig {
  kbDir?: string;
  sourceDir?: string;
  rootName?: string;
  wikiSync?: WikiSyncConfig;
}

export interface EmbeddingConfig {
  provider: string;      // "siliconflow" | "openai-compatible"
  baseURL: string;       // API 端点
  model: string;         // 模型名称
  dimension: number;     // 向量维度（必须 === collection.dimension，KiSearch 固定 4096）
  // apiKey 从 env SILICONFLOW_API_KEY 读取，不写入配置文件
}

export interface KiConfig {
  dataDir: string;                       // KB 源数据目录
  backupDir: string;                     // 备份目录
  vectorDir: string;                     // 【新增】zvec collection 目录
  embedding: EmbeddingConfig;            // 【新增】embedding 配置
  scopeMode: 'default' | 'strict';       // 【新增】scope 护栏模式（默认 'default'）；见 S-01 §3.5
  scopes: Record<string, ScopeConfig>;   // 保留（KB 目录映射；strict 模式下 key 兼作 scope 白名单）
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

  const kiDir = path.join(os.homedir(), '.ki');
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

  const dataDir = raw.dataDir
    ? expandPath(String(raw.dataDir), configDir)
    : path.join(KI_ROOT, 'kb');

  const backupDir = raw.backupDir
    ? expandPath(String(raw.backupDir), configDir)
    : path.join(KI_ROOT, 'ki-backup');

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
  };

  // 【新增】scopeMode：仅接受 'strict'，其余（含缺省/非法值）一律归为 'default'
  const scopeMode: 'default' | 'strict' = raw.scopeMode === 'strict' ? 'strict' : 'default';

  const scopes: Record<string, ScopeConfig> = {};
  if (raw.scopes && typeof raw.scopes === 'object') {
    for (const [name, sc] of Object.entries(raw.scopes as Record<string, unknown>)) {
      if (sc && typeof sc === 'object') {
        const s = sc as Record<string, unknown>;
        const ws = s.wikiSync as Record<string, unknown> | undefined;
        scopes[name] = {
          kbDir: s.kbDir ? expandPath(String(s.kbDir), configDir) : undefined,
          sourceDir: s.sourceDir ? expandPath(String(s.sourceDir), configDir) : undefined,
          rootName: s.rootName ? String(s.rootName) : undefined,
          wikiSync: ws ? {
            enabled: ws.enabled !== false,  // 默认 true
            sourceDir: ws.sourceDir ? expandPath(String(ws.sourceDir), configDir) : undefined,
          } : undefined,
        };
      }
    }
  }

  return { dataDir, backupDir, vectorDir, embedding, scopeMode, scopes, _configPath: configFile };
}

// ─── 内置默认值 ───

function buildDefaults(): KiConfig {
  return {
    dataDir: path.join(KI_ROOT, 'kb'),
    backupDir: path.join(KI_ROOT, 'ki-backup'),
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
 * 获取指定 scope 的 sourceDir（如果配置了）
 */
export function getScopeSourceDir(config: KiConfig, scope: string): string | null {
  return config.scopes[scope]?.sourceDir ?? null;
}

/**
 * 获取指定 scope 的 rootName（如果配置了）
 */
export function getScopeRootName(config: KiConfig, scope: string): string | null {
  return config.scopes[scope]?.rootName ?? null;
}

/**
 * 获取指定 scope 的 wikiSync 配置
 */
export function getScopeWikiSync(config: KiConfig, scope: string): WikiSyncConfig | null {
  return config.scopes[scope]?.wikiSync ?? null;
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

/**
 * 导出 KI_ROOT 供其他模块使用（避免循环依赖）
 */
export function getKiRoot(): string {
  return KI_ROOT;
}
