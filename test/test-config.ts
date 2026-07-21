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

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/** 每个测试进程共享一个临时配置文件 */
const TEST_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'config.json');

// 初始化空配置
// vectorDir 指向临时目录，隔离测试向量库（避免污染 ~/.ki/vector，并保证离线优雅降级）
fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
  dataDir: path.join(PROJECT_ROOT, 'kb'),
  vectorDir: path.join(TEST_CONFIG_DIR, 'vector'),
  scopes: {},
}), 'utf-8');

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
 */
export function getTestEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    KI_CONFIG_PATH: TEST_CONFIG_PATH,
  };
}

/** 测试配置文件路径（供需要直接引用的场景使用） */
export const testConfigPath = TEST_CONFIG_PATH;

/**
 * 清理临时配置文件（在 after() 中调用）
 */
export function cleanupTestConfig(): void {
  try {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}
