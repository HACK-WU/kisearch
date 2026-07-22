/**
 * config + doctor 单元测试（REQ-11 / REQ-15 / REQ-16）
 *
 * 覆盖三个面：
 *  A. src/lib/config.ts —— YAML 解析、scope 数据目录语义、resolveScope 护栏、
 *     null scope 丢弃、embedding 默认合并、scopeMode 归一化
 *  B. src/config.ts（CLI `ki config init`，子进程黑盒）—— 生成 YAML 模板、
 *     default scope 为 {} 的路径回归（不双层嵌套）、幂等
 *  C. src/lib/health-check.ts —— scopes.default pass/warn、目录检查、
 *     无 apiKey 时 embedding 三项 fail、渲染格式
 *
 * 运行：npx jiti test/config-doctor.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

import {
  loadConfig,
  resetConfigCache,
  getScopeDataDir,
  resolveScope,
  getScopeMode,
  getEmbeddingConfig,
  type KiConfig,
} from '../src/lib/config.js';
import {
  runHealthCheck,
  statusIcon,
  renderHealthReport,
  type HealthReport,
} from '../src/lib/health-check.js';

// ─── 临时目录 ───

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-cfgtest-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写一个临时配置文件并加载（每次清缓存，避免进程内单例串扰） */
function writeAndLoad(fileName: string, content: string): KiConfig {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'cfg-'));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, content, 'utf-8');
  resetConfigCache();
  return loadConfig(file);
}

// ─── A. lib/config.ts：YAML 解析 + scope 语义 ───

describe('A. lib/config —— scope 数据目录语义', () => {
  it('未配置 kbDir 的 scope 落 dataDir/{scope}（含 default: {}）', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopes:', '  default: {}'].join('\n')
    );
    // 回归：default: {} 必须落 /abs/data/default，而非 /abs/data/default/kb/default
    assert.strictEqual(getScopeDataDir(cfg, 'default'), path.join('/abs/data', 'default'));
  });

  it('配置了 kbDir 的 scope 自动嵌套 kb/{scope}', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopes:', '  proj:', '    kbDir: /special/kb'].join('\n')
    );
    assert.strictEqual(getScopeDataDir(cfg, 'proj'), path.join('/special/kb', 'kb', 'proj'));
  });

  it('未注册 scope 回退到 dataDir/{scope}', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopes:\n  default: {}');
    assert.strictEqual(getScopeDataDir(cfg, 'ghost'), path.join('/abs/data', 'ghost'));
  });
});

describe('A. lib/config —— null scope 丢弃', () => {
  it('YAML 中裸写 default:（解析为 null）会被丢弃', () => {
    // 这是 config init 模板必须写成 default: {} 的根因
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopes:', '  default:', '  alive: {}'].join('\n')
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.scopes, 'default'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.scopes, 'alive'), true);
  });

  it('default: {} 空对象会存活', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopes:\n  default: {}');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.scopes, 'default'), true);
  });
});

describe('A. lib/config —— YAML/JSON 双格式与 embedding 默认合并', () => {
  it('读取 .json 亦可解析（向后兼容）', () => {
    const cfg = writeAndLoad(
      'config.json',
      JSON.stringify({ dataDir: '/abs/data', scopes: { default: {} } })
    );
    assert.strictEqual(cfg.dataDir, '/abs/data');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.scopes, 'default'), true);
  });

  it('缺省 embedding 使用内置默认值', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data');
    const emb = getEmbeddingConfig(cfg);
    assert.strictEqual(emb.provider, 'siliconflow');
    assert.strictEqual(emb.model, 'Qwen/Qwen3-Embedding-8B');
    assert.strictEqual(emb.dimension, 4096);
  });

  it('embedding 部分覆盖：仅改 model，其余保持默认', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'embedding:', '  model: custom-model'].join('\n')
    );
    const emb = getEmbeddingConfig(cfg);
    assert.strictEqual(emb.model, 'custom-model');
    assert.strictEqual(emb.provider, 'siliconflow');
    assert.strictEqual(emb.dimension, 4096);
  });
});

describe('A. lib/config —— scopeMode 归一化', () => {
  it('scopeMode: strict → strict', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopeMode: strict');
    assert.strictEqual(getScopeMode(cfg), 'strict');
  });

  it('缺省 / 非法值 → default', () => {
    assert.strictEqual(getScopeMode(writeAndLoad('a.yaml', 'dataDir: /abs/data')), 'default');
    assert.strictEqual(
      getScopeMode(writeAndLoad('b.yaml', 'dataDir: /abs/data\nscopeMode: weird')),
      'default'
    );
  });
});

describe('A. lib/config —— resolveScope 护栏', () => {
  it('default 档：缺省/空白 → default，任意值放行', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopeMode: default\nscopes:\n  default: {}');
    assert.strictEqual(resolveScope(cfg), 'default');
    assert.strictEqual(resolveScope(cfg, '   '), 'default');
    assert.strictEqual(resolveScope(cfg, 'anything'), 'anything');
  });

  it('strict 档：未传 scope → 抛错', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopeMode: strict', 'scopes:', '  proj: {}'].join('\n')
    );
    assert.throws(() => resolveScope(cfg), /必须显式传入/);
  });

  it('strict 档：未注册 scope → 抛错', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopeMode: strict', 'scopes:', '  proj: {}'].join('\n')
    );
    assert.throws(() => resolveScope(cfg, 'nope'), /unknown scope/);
  });

  it('strict 档：已注册 scope → 放行', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopeMode: strict', 'scopes:', '  proj: {}'].join('\n')
    );
    assert.strictEqual(resolveScope(cfg, 'proj'), 'proj');
  });
});

// ─── B. src/config.ts CLI：ki config init（子进程黑盒） ───

const CONFIG_SCRIPT = path.resolve(import.meta.dirname, '..', 'src', 'config.ts');

describe('B. config init —— 生成 YAML 模板', () => {
  let projDir: string;
  let configFile: string;

  function runInit(extraArgs: string[] = []): { ok: boolean; [k: string]: unknown } {
    const out = execFileSync(
      'npx',
      ['jiti', CONFIG_SCRIPT, 'init', '--dir', projDir, ...extraArgs],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          HOME: projDir,              // 让 $HOME 展开落到临时目录，避免污染真实 HOME
          KI_DATA_DIR: path.join(projDir, 'data'), // 固定 dataDir，避免探测 repo/kb
        },
      }
    );
    return JSON.parse(out);
  }

  before(() => {
    projDir = fs.mkdtempSync(path.join(tmpDir, 'init-'));
    configFile = path.join(projDir, '.ki', 'config.yaml');
  });

  it('生成 .ki/config.yaml 且包含 default: {} 与 scopeMode: default', () => {
    const res = runInit();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.existed, false);
    assert.ok(fs.existsSync(configFile), 'config.yaml 应存在');

    const text = fs.readFileSync(configFile, 'utf-8');
    assert.match(text, /^\s*default:\s*\{\}\s*$/m, '默认 scope 应为 default: {}');
    assert.match(text, /scopeMode:\s*default/);
    assert.match(text, /provider:\s*siliconflow/);
  });

  it('生成的配置加载后 default scope 不双层嵌套（回归）', () => {
    // 依赖上一个用例已生成 configFile
    resetConfigCache();
    const cfg = loadConfig(configFile);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.scopes, 'default'), true);
    // dataDir 来自 KI_DATA_DIR=projDir/data；default 应落 dataDir/default，无 /kb/default
    assert.strictEqual(getScopeDataDir(cfg, 'default'), path.join(cfg.dataDir, 'default'));
    assert.ok(!getScopeDataDir(cfg, 'default').includes(`${path.sep}kb${path.sep}`));
  });

  it('幂等：已存在时 existed:true，--force 覆盖 existed:false', () => {
    const again = runInit();
    assert.strictEqual(again.existed, true);
    const forced = runInit(['--force']);
    assert.strictEqual(forced.existed, false);
  });
});

// ─── C. lib/health-check.ts ───

describe('C. health-check —— 渲染与图标', () => {
  it('statusIcon 三态', () => {
    assert.strictEqual(statusIcon('pass'), '✅');
    assert.strictEqual(statusIcon('warn'), '⚠️');
    assert.strictEqual(statusIcon('fail'), '❌');
  });

  it('renderHealthReport 含标题与结果统计行', () => {
    const report: HealthReport = {
      items: [{ name: 'x', status: 'pass', detail: 'ok' }],
      pass: 1,
      warn: 0,
      fail: 0,
    };
    const text = renderHealthReport(report);
    assert.match(text, /KiSearch 配置诊断/);
    assert.match(text, /1 通过, 0 警告, 0 失败/);
  });
});

describe('C. health-check —— runHealthCheck', () => {
  let savedKey: string | undefined;
  let goodDir: string;

  before(() => {
    // 无 apiKey 分支：确保离线，不发网络请求
    savedKey = process.env.SILICONFLOW_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    goodDir = fs.mkdtempSync(path.join(tmpDir, 'hc-'));
  });

  after(() => {
    if (savedKey !== undefined) process.env.SILICONFLOW_API_KEY = savedKey;
  });

  function baseConfig(overrides: Partial<KiConfig> = {}): KiConfig {
    return {
      dataDir: goodDir,
      backupDir: goodDir,
      vectorDir: goodDir,
      embedding: {
        provider: 'siliconflow',
        baseURL: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen3-Embedding-8B',
        dimension: 4096,
      },
      scopeMode: 'default',
      scopes: { default: {} },
      _configPath: path.join(goodDir, 'config.yaml'),
      ...overrides,
    };
  }

  function itemOf(report: HealthReport, name: string) {
    return report.items.find((i) => i.name === name);
  }

  it('scopes.default 存在 → pass；无 apiKey → embedding 三项与 apiKey fail', async () => {
    const report = await runHealthCheck(baseConfig());
    assert.strictEqual(itemOf(report, 'scopes.default')?.status, 'pass');
    assert.strictEqual(itemOf(report, 'apiKey')?.status, 'fail');
    assert.strictEqual(itemOf(report, 'URL 连通性')?.status, 'fail');
    assert.strictEqual(itemOf(report, '密钥有效性')?.status, 'fail');
    assert.strictEqual(itemOf(report, '维度匹配')?.status, 'fail');
    assert.strictEqual(itemOf(report, '配置文件')?.status, 'pass');
  });

  it('无 default scope → scopes.default warn', async () => {
    const report = await runHealthCheck(baseConfig({ scopes: {} }));
    assert.strictEqual(itemOf(report, 'scopes.default')?.status, 'warn');
  });

  it('dataDir 不存在 → 该项 fail', async () => {
    const report = await runHealthCheck(baseConfig({ dataDir: path.join(goodDir, 'nope') }));
    assert.strictEqual(itemOf(report, 'dataDir')?.status, 'fail');
  });

  it('_configPath 缺失 → 配置文件 fail', async () => {
    const report = await runHealthCheck(baseConfig({ _configPath: undefined }));
    assert.strictEqual(itemOf(report, '配置文件')?.status, 'fail');
  });
});
