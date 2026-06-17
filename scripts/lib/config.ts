/**
 * ki 配置文件加载模块
 *
 * 配置文件查找优先级：
 *   1. --config <path> 命令行参数
 *   2. $HOME/.ki/config.json
 *   3. 内置默认值
 *
 * 路径展开规则：$HOME / ~ → os.homedir()，相对路径 → 相对于配置文件所在目录
 *
 * 【循环依赖解决】本模块自行计算 KI_ROOT，不 import constants.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── 自行计算 KI_ROOT（与 constants.ts 相同算法，打破循环依赖） ───
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

export interface KiConfig {
  dataDir: string;
  backupDir: string;
  scopes: Record<string, ScopeConfig>;
  _configPath?: string;
}

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
  const file = findConfigFile(configPath);

  if (file) {
    _cached = parseAndExpand(file);
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

  const candidates = [
    path.join(os.homedir(), '.ki', 'config.json'),
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
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch (err) {
    const detail = err instanceof SyntaxError ? err.message : String(err);
    throw new Error(`配置文件解析失败：${configFile}\n${detail}`);
  }

  const configDir = path.dirname(configFile);

  const dataDir = raw.dataDir
    ? expandPath(String(raw.dataDir), configDir)
    : path.join(KI_ROOT, 'kb');

  const backupDir = raw.backupDir
    ? expandPath(String(raw.backupDir), configDir)
    : path.join(KI_ROOT, 'ki-backup');

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

  return { dataDir, backupDir, scopes, _configPath: configFile };
}

// ─── 内置默认值 ───

function buildDefaults(): KiConfig {
  return {
    dataDir: path.join(KI_ROOT, 'kb'),
    backupDir: path.join(KI_ROOT, 'ki-backup'),
    scopes: {},
  };
}

// ─── 辅助函数 ───

/**
 * 获取指定 scope 的数据目录
 * 优先使用 scope 级 kbDir，fallback 到全局 dataDir/{scope}
 */
export function getScopeDataDir(config: KiConfig, scope: string): string {
  const sc = config.scopes[scope];
  if (sc?.kbDir) return sc.kbDir;
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
 * 导出 KI_ROOT 供其他模块使用（避免循环依赖）
 */
export function getKiRoot(): string {
  return KI_ROOT;
}
