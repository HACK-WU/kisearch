/**
 * config + doctor 单元测试（REQ-11 / REQ-15 / REQ-16）
 *
 * 覆盖三个面：
 *  A. src/lib/config.ts —— YAML 解析、scope 数据目录语义、sourceDir/wikiSync
 *     可选字段解析与路径展开、resolveScope 护栏、null scope 丢弃（告警不阻断）、
 *     embedding 默认合并、scopeMode 枚举校验
 *  A2. 字段级校验（config-schema.ts）——未知字段名/拼写建议/废弃字段指引/类型错误
 *     一次性报 CONFIG_FIELD_INVALID
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
  getScopeWikiSync,
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
import { validateConfigFields } from '../src/lib/config-schema.js';

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

describe('A. lib/config —— scope 可选字段（wikiSync）', () => {
  it('default scope 未配 kbDir → 数据仍落 dataDir/default（模板 default: {} 的安全默认）', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopes:\n  default: {}');
    assert.strictEqual(getScopeDataDir(cfg, 'default'), path.join('/abs/data', 'default'));
  });

  it('wikiSync：未配置 → null', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopes:\n  proj: {}');
    assert.strictEqual(getScopeWikiSync(cfg, 'proj'), null);
  });

  it('wikiSync.enabled 缺省为 true，sourceDir 展开', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopes:', '  proj:', '    wikiSync:', '      sourceDir: ~/wiki-out'].join('\n')
    );
    const ws = getScopeWikiSync(cfg, 'proj');
    assert.ok(ws, 'wikiSync 应存在');
    assert.strictEqual(ws.enabled, true);
    assert.strictEqual(ws.sourceDir, path.join(os.homedir(), 'wiki-out'));
  });

  it('wikiSync.enabled: false 生效', () => {
    const cfg = writeAndLoad(
      'config.yaml',
      ['dataDir: /abs/data', 'scopes:', '  proj:', '    wikiSync:', '      enabled: false'].join('\n')
    );
    const ws = getScopeWikiSync(cfg, 'proj');
    assert.ok(ws, 'wikiSync 应存在');
    assert.strictEqual(ws.enabled, false);
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

describe('A. lib/config —— scopeMode 枚举校验', () => {
  it('scopeMode: strict → strict', () => {
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopeMode: strict');
    assert.strictEqual(getScopeMode(cfg), 'strict');
  });

  it('缺省 → default', () => {
    assert.strictEqual(getScopeMode(writeAndLoad('a.yaml', 'dataDir: /abs/data')), 'default');
  });

  it('非法枚举值 → 加载报错（不再静默归 default）', () => {
    assert.throws(
      () => writeAndLoad('b.yaml', 'dataDir: /abs/data\nscopeMode: weird'),
      /CONFIG_FIELD_INVALID[\s\S]*scopeMode：取值应为 default \| strict/
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

// ─── A2. 字段级校验（config-schema.ts） ───

describe('A2. 字段校验 —— 未知字段名', () => {
  it('顶层拼写错误 → 报错且附相近字段建议', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'datadir: /abs/data'),
      /CONFIG_FIELD_INVALID[\s\S]*datadir：非预期字段.*您是否想输入 "dataDir"/
    );
  });

  it('scope 内未知字段 → 报错并列出可用字段', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'scopes:\n  proj:\n    kbDirr: /x'),
      /CONFIG_FIELD_INVALID[\s\S]*scopes\.proj\.kbDirr：非预期字段[\s\S]*kbDir \| wikiSync/
    );
  });

  it('废弃的 scope 级 sourceDir → 仅告警不阻断（存量配置仍可加载）', () => {
    // 文档已承诺「旧配置残留该字段会被忽略」，硬报错会打破用户正在使用的 config
    const cfg = writeAndLoad('config.yaml', 'scopes:\n  proj:\n    sourceDir: /x');
    assert.ok(cfg, '应能正常加载');
    const { errors, warns } = validateConfigFields({ scopes: { proj: { sourceDir: '/x' } } });
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0].path, 'scopes.proj.sourceDir');
    assert.match(warns[0].message, /已废弃字段[\s\S]*wikiSync\.sourceDir/);
  });

  it('自由键不误伤：任意 scope 名（如 monitot）合法，与拼写错误字段区分', () => {
    // scope 名是用户自定义的，不参与相近建议，不应因「像拼写错误」被拒
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopes:\n  monitot:\n    kbDir: /x');
    assert.strictEqual(getScopeDataDir(cfg, 'monitot'), path.join('/x', 'kb', 'monitot'));
  });

  it('YAML 锚点 + 整值引用（x-common 模板）→ 不误判为未知字段', () => {
    // 实测：`yaml` 库会展开别名引用（p: *t 拿到真值），根层 x-common 解析器不读，属合法模板写法
    const cfg = writeAndLoad('config.yaml', [
      'x-common: &tpl',
      '  kbDir: /tmpl-kb',
      'scopes:',
      '  p: *tpl',
    ].join('\n'));
    assert.strictEqual(getScopeDataDir(cfg, 'p'), path.join('/tmpl-kb', 'kb', 'p'));
    const { errors } = validateConfigFields({
      'x-common': { kbDir: '/tmpl-kb' },
      scopes: { p: { kbDir: '/tmpl-kb' } },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('YAML 合并键 << 不生效 → 显式报错（不被静默忽略）', () => {
    // 实测：yaml 库的 parse 保留字面量 "<<" 键，合并不会生效；旧行为是静默落默认值
    assert.throws(
      () => writeAndLoad('config.yaml', 'x-common: &tpl\n  kbDir: /t\nscopes:\n  p:\n    <<: *tpl\n    wikiSync:\n      sourceDir: /w'),
      /CONFIG_FIELD_INVALID[\s\S]*scopes\.p\.<<：YAML 合并键[\s\S]*不生效/
    );
    assert.throws(
      () => writeAndLoad('config.yaml', 'scopes:\n  <<: { x: 1 }'),
      /CONFIG_FIELD_INVALID[\s\S]*<<：YAML 合并键/
    );
  });

  it('根层非 x- 前缀的模板键仍报错（豁免面仅限约定前缀）', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'common: &tpl\n  kbDir: /x'),
      /CONFIG_FIELD_INVALID[\s\S]*common：非预期字段/
    );
  });
});

describe('A2. 字段校验 —— 类型与取值', () => {
  it('字符串写进数字字段（dimension: "4096"）→ 报错', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'embedding:\n  dimension: "4096"'),
      /CONFIG_FIELD_INVALID[\s\S]*embedding\.dimension：应为数字，实际为 string/
    );
  });

  it('dimension 非正整数 → 报错', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'embedding:\n  dimension: -1'),
      /CONFIG_FIELD_INVALID[\s\S]*embedding\.dimension：应为正整数/
    );
  });

  it('布尔字段写成字符串 → 报错', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'scopes:\n  p:\n    wikiSync:\n      enabled: "false"'),
      /CONFIG_FIELD_INVALID[\s\S]*wikiSync\.enabled：应为布尔值/
    );
  });

  it('数组字段写成标量 → 报错', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'scopes:\n  p:\n    import:\n      extensions: .md'),
      /CONFIG_FIELD_INVALID[\s\S]*import\.extensions：应为字符串数组/
    );
  });

  it('mcp.http.port 越界 → 报错', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'mcp:\n  http:\n    port: 99999'),
      /CONFIG_FIELD_INVALID[\s\S]*mcp\.http\.port：应为 1-65535/
    );
  });

  it('对象字段写成标量 → 报错', () => {
    assert.throws(
      () => writeAndLoad('config.yaml', 'embedding: oops'),
      /CONFIG_FIELD_INVALID[\s\S]*embedding：应为对象/
    );
  });

  it('只写键名未赋值（YAML 解析为 null）→ 报错并提示可能忘填值', () => {
    // 高频陷阱：把文档的字段概览（`dataDir:  # 注释`）整段复制进配置
    assert.throws(
      () => writeAndLoad('config.yaml', 'dataDir:     # KB 源数据目录\nbackupDir:   # 备份目录'),
      /CONFIG_FIELD_INVALID[\s\S]*dataDir：应为字符串，实际为 null（只写了键名未赋值？）/
    );
  });

  it('多处错误一次性全部列出（不挤牙膏）', () => {
    try {
      writeAndLoad('config.yaml', ['dataDir: 123', 'scopes:', '  p:', '    kbDir: []', '    wikiSync:', '      enabled: yes?'].join('\n'));
      assert.fail('应抛出 CONFIG_FIELD_INVALID');
    } catch (e) {
      const msg = (e as Error).message;
      assert.match(msg, /共 3 处/);
      assert.match(msg, /dataDir：应为字符串/);
      assert.match(msg, /scopes\.p\.kbDir：应为字符串/);
    }
  });
});

describe('A2. 字段校验 —— 告警不阻断 + 直测 validateConfigFields', () => {
  it('YAML 裸写 default:（null）→ 仅告警，loadConfig 不抛错', () => {
    // 现行为保留：null scope 条目被丢弃，但不再是静默陷阱
    const cfg = writeAndLoad('config.yaml', 'dataDir: /abs/data\nscopes:\n  default:\n  alive: {}');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.scopes, 'default'), false);
    const { errors, warns } = validateConfigFields({ scopes: { default: null, alive: {} } });
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0].path, /^scopes\.default$/);
    assert.match(warns[0].message, /将被忽略/);
  });

  it('合法完整配置 → errors/warns 均空', () => {
    const { errors, warns } = validateConfigFields({
      dataDir: '/d',
      backupDir: '/b',
      vectorDir: '/v',
      embedding: { provider: 'siliconflow', baseURL: 'https://api.x.cn/v1', model: 'm', dimension: 4096, apiKey: '${K}' },
      scopeMode: 'strict',
      scopes: {
        s1: {
          kbDir: '/k',
          wikiSync: { enabled: true, sourceDir: '/w', autoBackfill: false },
          clean: { enabled: true, rules: { bom: false }, hooks: ['sh x.sh'] },
          import: { extensions: ['.md'], maxFileSize: 1048576 },
        },
      },
      mcp: { http: { host: '0.0.0.0', port: 7423, allowedHosts: ['localhost'] } },
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(warns, []);
  });

  it('字符串字段写成空值（dataDir: ""）→ 仅告警（会被当未配置）', () => {
    // 解析器用 `raw.dataDir ? ... : 默认值`，空串静默落默认值，与本次要消灭的静默错配同类
    const { errors, warns } = validateConfigFields({ dataDir: '', backupDir: '   ' });
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warns.length, 2);
    assert.strictEqual(warns[0].path, 'dataDir');
    assert.match(warns[0].message, /空字符串[\s\S]*未配置/);
    const cfg = writeAndLoad('config.yaml', 'dataDir: ""\n');
    assert.ok(cfg.dataDir, '空串不阻断加载，落默认值');
  });

  it('空配置（仅注释/空文件）→ 合法（全走默认值）', () => {
    const { errors } = validateConfigFields(undefined);
    assert.strictEqual(errors.length, 0);
  });

  it('根节点非对象（数组）→ 报错', () => {
    const { errors } = validateConfigFields([1, 2]);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /根节点应为对象/);
  });
});

const DOCTOR_SCRIPT = path.resolve(import.meta.dirname, '..', 'src', 'doctor.ts');

describe('D. doctor CLI —— 字段校验失败的退出行为', () => {
  it('字段类型错误 → 非零退出且 stderr 列出字段路径', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'doctor-bad-'));
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, 'dataDir: /abs/data\nembedding:\n  dimension: "4096"\n', 'utf-8');
    let stderr = '';
    let status = 0;
    try {
      // --config 由 bin/ki.mjs 转成 KI_CONFIG_PATH（直调 doctor.ts 时走 env）
      execFileSync(
        process.execPath,
        [path.resolve(import.meta.dirname, '..', 'node_modules/jiti/lib/jiti-cli.mjs'), DOCTOR_SCRIPT],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_NO_WARNINGS: '1', KI_CONFIG_PATH: file },
        }
      );
    } catch (e) {
      stderr = (e as { stderr?: string }).stderr ?? '';
      status = (e as { status?: number }).status ?? 0;
    }
    assert.strictEqual(status, 1, '字段错误应退出码 1');
    assert.match(stderr, /配置加载失败[\s\S]*CONFIG_FIELD_INVALID/);
    assert.match(stderr, /embedding\.dimension：应为数字/);
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
    assert.match(text, /kisearch 配置诊断/);
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

  it('无字段告警 → 配置字段 pass；有告警 → warn 且带字段路径', async () => {
    const clean = await runHealthCheck(baseConfig());
    assert.strictEqual(itemOf(clean, '配置字段')?.status, 'pass');

    const warned = await runHealthCheck(
      baseConfig({ _fieldWarnings: [{ path: 'scopes.proj.sourceDir', message: '已废弃字段（被忽略）' }] })
    );
    const item = itemOf(warned, '配置字段');
    assert.strictEqual(item?.status, 'warn');
    assert.match(item?.detail ?? '', /1 处提示[\s\S]*scopes\.proj\.sourceDir/);
  });

  it('_configPath 缺失 → 配置文件 fail', async () => {
    const report = await runHealthCheck(baseConfig({ _configPath: undefined }));
    assert.strictEqual(itemOf(report, '配置文件')?.status, 'fail');
  });
});
