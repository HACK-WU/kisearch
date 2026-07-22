/**
 * scope + doc 管理命令单元测试（REQ-20260722-001）
 *
 * 覆盖三个面：
 *  A. src/lib/config.ts —— removeScopeFromConfigFile：YAML 保注释 / JSON / scope 不存在 / 无配置文件
 *  B. src/scope.ts —— executeScopeList（KB 层并集 + 无 apiKey 时向量层降级）、
 *     executeScopeDelete 护栏（default 拒绝 / 非法 scope）
 *  C. src/doc.ts + 引擎回路 —— executeDocDelete 空 ids 护栏；
 *     dummy apiKey + 临时 vectorDir 下建空 collection：doc list count:0、
 *     scope delete 删 KB 目录、scope clear 保目录清内容、doc delete 无 --yes 需确认
 *
 * 离线约定：
 *  - 不设 SILICONFLOW_API_KEY 时，getEngine 构造 provider 抛错 → 向量操作降级（scope list 仍返回 KB 层）
 *  - 设 dummy key 时，listIds/fetch/delete 不发网络，可在临时目录建空 collection 离线跑
 *
 * 运行：npx jiti test/scope-doc.test.ts
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { resetConfigCache, removeScopeFromConfigFile } from '../src/lib/config.js';
import { executeScopeList, executeScopeDelete, executeScopeClear } from '../src/scope.js';
import { executeDocList, executeDocDelete } from '../src/doc.js';
import { executeTagList } from '../src/tag.js';
import { closeEngine } from '../src/lib/vector-client.js';

// ─── 临时目录 & 环境隔离 ───

let tmpRoot: string;
let savedEnv: Record<string, string | undefined>;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scopedoc-'));
  savedEnv = {
    KI_CONFIG_PATH: process.env.KI_CONFIG_PATH,
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    HOME: process.env.HOME,
  };
});

after(async () => {
  await closeEngine();
  // 还原环境
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 建一个隔离工作区：写 config.yaml（含 dataDir / vectorDir / scopes），
 * 设 KI_CONFIG_PATH 并清缓存。返回各路径。
 */
function makeWorkspace(opts: {
  scopesYaml?: string;      // scopes 块（YAML 片段，含缩进），省略则不写 scopes
  header?: string;          // 顶部注释等
  apiKey?: string;          // 设置 SILICONFLOW_API_KEY；省略则删除（离线降级）
}): { dir: string; configPath: string; dataDir: string; vectorDir: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  const dataDir = path.join(dir, 'data');
  const vectorDir = path.join(dir, 'vector'); // 故意不创建 → 首次视为可 create
  fs.mkdirSync(dataDir, { recursive: true });

  const lines = [
    opts.header ?? '# ki 测试配置',
    `dataDir: ${dataDir}`,
    `vectorDir: ${vectorDir}`,
    'scopeMode: default',
  ];
  if (opts.scopesYaml !== undefined) {
    lines.push('scopes:');
    lines.push(opts.scopesYaml);
  }
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(configPath, lines.join('\n') + '\n', 'utf-8');

  process.env.KI_CONFIG_PATH = configPath;
  if (opts.apiKey === undefined) delete process.env.SILICONFLOW_API_KEY;
  else process.env.SILICONFLOW_API_KEY = opts.apiKey;
  resetConfigCache();

  return { dir, configPath, dataDir, vectorDir };
}

/** 在 dataDir 下建一个 KB scope 目录（含 relations-cache.json，listAllScopes 才认） */
function makeKbScope(dataDir: string, scope: string): string {
  const scopeDir = path.join(dataDir, scope);
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'relations-cache.json'), '{}', 'utf-8');
  fs.writeFileSync(path.join(scopeDir, 'group-index.json'), '{"groups":{}}', 'utf-8');
  return scopeDir;
}

// ─── A. removeScopeFromConfigFile ───

describe('A. config —— removeScopeFromConfigFile', () => {
  it('YAML：移除指定 scope，保留其余 scope 与顶部注释', () => {
    const { configPath } = makeWorkspace({
      header: '# 顶部注释：请勿删除',
      scopesYaml: ['  projB: {}', '  keepme: {}'].join('\n'),
    });

    const res = removeScopeFromConfigFile('projB');
    assert.strictEqual(res.removed, true);
    assert.strictEqual(res.configPath, configPath);

    const text = fs.readFileSync(configPath, 'utf-8');
    assert.match(text, /# 顶部注释：请勿删除/, '顶部注释应保留');
    assert.match(text, /keepme:/, 'keepme 应保留');
    assert.doesNotMatch(text, /projB:/, 'projB 应被移除');
  });

  it('JSON：移除指定 scope 后写回，其余保留', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'json-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ dataDir: path.join(dir, 'data'), scopes: { projB: {}, keepme: {} } }, null, 2),
      'utf-8'
    );
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    const res = removeScopeFromConfigFile('projB');
    assert.strictEqual(res.removed, true);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.scopes, 'projB'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.scopes, 'keepme'), true);
  });

  it('scope 不存在于 scopes → removed:false（非错误）', () => {
    makeWorkspace({ scopesYaml: '  keepme: {}' });
    const res = removeScopeFromConfigFile('ghost');
    assert.strictEqual(res.removed, false);
    assert.match(res.reason ?? '', /无/);
  });

  it('无配置文件（默认路径）→ removed:false', () => {
    // 指向一个只有空 .ki 的 HOME，findConfigFile 返回 null → buildDefaults（无 _configPath）
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
    delete process.env.KI_CONFIG_PATH;
    process.env.HOME = emptyHome;
    resetConfigCache();

    const res = removeScopeFromConfigFile('whatever');
    assert.strictEqual(res.removed, false);
    assert.match(res.reason ?? '', /未找到配置文件/);
  });
});

// ─── B. scope list / delete 护栏（离线） ───

describe('B. scope —— list 并集 & 向量层降级（无 apiKey）', () => {
  afterEach(async () => {
    await closeEngine();
  });

  it('KB 层 scope 并集，无 apiKey 时 vectorAvailable:false', async () => {
    const { dataDir } = makeWorkspace({
      scopesYaml: '  projA: {}',
      // 无 apiKey：向量层建 collection 会失败 → 降级
    });
    makeKbScope(dataDir, 'projA');
    makeKbScope(dataDir, 'projB'); // 未注册但 KB 有

    const res = await executeScopeList();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.vectorAvailable, false, '无 apiKey → 向量层不可用/降级');

    const byName = new Map(res.scopes.map((s) => [s.scope, s]));
    assert.ok(byName.has('projA'), '应含 projA');
    assert.ok(byName.has('projB'), '应含 projB');
    assert.strictEqual(byName.get('projA')!.kb, true);
    assert.strictEqual(byName.get('projA')!.registered, true);
    assert.strictEqual(byName.get('projB')!.kb, true);
    assert.strictEqual(byName.get('projB')!.registered, false);
    // 向量层不可用 → 所有 vector 标记为 false
    assert.strictEqual(byName.get('projA')!.vector, false);
  });
});

describe('B. scope —— delete 护栏', () => {
  afterEach(async () => {
    await closeEngine();
  });

  it('default scope 拒绝删除（在向量检测之前短路）', async () => {
    makeWorkspace({ scopesYaml: '  default: {}' });
    const res = await executeScopeDelete({ scope: 'default', yes: true });
    assert.strictEqual(res.ok, false);
    assert.match((res as { error: string }).error, /default scope 不可删除/);
  });

  it('非法 scope 名 → 校验失败', async () => {
    makeWorkspace({ scopesYaml: '  default: {}' });
    const res = await executeScopeDelete({ scope: '../etc', yes: true });
    assert.strictEqual(res.ok, false);
    assert.match((res as { error: string }).error, /不合法/);
  });
});

// ─── C. doc delete 空 ids 护栏（离线，短路在向量检测之前） ───

describe('C. doc —— delete 空 ids 护栏', () => {
  afterEach(async () => {
    await closeEngine();
  });

  it('未提供 docid → ok:false', async () => {
    makeWorkspace({ scopesYaml: '  default: {}' });
    const res = await executeDocDelete({ scope: 'default', ids: [], yes: false });
    assert.strictEqual(res.ok, false);
    assert.match((res as { error: string }).error, /未提供 docid/);
  });
});

// ─── D. 引擎回路（dummy apiKey + 临时 vectorDir，建空 collection 离线跑） ───

describe('D. 引擎回路 —— 空 collection（dummy apiKey）', () => {
  afterEach(async () => {
    await closeEngine();
  });

  it('doc list 空库 → count:0', async () => {
    makeWorkspace({ scopesYaml: '  default: {}', apiKey: 'dummy-offline-key' });
    const res = await executeDocList({ scope: 'default', limit: 10 });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.count, 0);
      assert.deepStrictEqual(res.docs, []);
    }
  });

  it('tag list 空库 → count:0, truncated:false', async () => {
    makeWorkspace({ scopesYaml: '  default: {}', apiKey: 'dummy-offline-key' });
    const res = await executeTagList({ scope: 'default' });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.count, 0);
      assert.strictEqual(res.scanned, 0);
      assert.strictEqual(res.truncated, false);
      assert.deepStrictEqual(res.tags, []);
    }
  });

  it('doc delete 不存在的 id 且无 --yes → requireConfirm + notFound', async () => {
    makeWorkspace({ scopesYaml: '  default: {}', apiKey: 'dummy-offline-key' });
    const res = await executeDocDelete({ scope: 'default', ids: ['nope123'], yes: false });
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.requireConfirm, true);
      assert.deepStrictEqual(res.notFound, ['nope123']);
    }
  });

  it('scope delete 空 scope：删 KB 目录 + 移除配置条目', async () => {
    const { dataDir, configPath } = makeWorkspace({
      scopesYaml: ['  projX: {}', '  keep: {}'].join('\n'),
      apiKey: 'dummy-offline-key',
    });
    makeKbScope(dataDir, 'projX');

    const res = await executeScopeDelete({ scope: 'projX', yes: true });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.deletedVectors, 0);
      assert.strictEqual(res.kbRemoved, true);
      assert.strictEqual(res.configRemoved, true);
    }
    // KB 目录已删
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'projX')), false);
    // 配置条目已移除，keep 保留
    const text = fs.readFileSync(configPath, 'utf-8');
    assert.doesNotMatch(text, /projX:/);
    assert.match(text, /keep:/);
  });

  it('scope clear 空 scope：保留目录，清空内容', async () => {
    const { dataDir } = makeWorkspace({
      scopesYaml: '  projY: {}',
      apiKey: 'dummy-offline-key',
    });
    const scopeDir = makeKbScope(dataDir, 'projY');

    const res = await executeScopeClear({ scope: 'projY', yes: true });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.kbCleared, true);
    }
    // 目录仍在，但内容被清空
    assert.strictEqual(fs.existsSync(scopeDir), true);
    assert.deepStrictEqual(fs.readdirSync(scopeDir), []);
  });

  it('scope delete 无 --yes → requireConfirm + 预览', async () => {
    const { dataDir } = makeWorkspace({
      scopesYaml: '  projZ: {}',
      apiKey: 'dummy-offline-key',
    });
    makeKbScope(dataDir, 'projZ');

    const res = await executeScopeDelete({ scope: 'projZ', yes: false });
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.requireConfirm, true);
      assert.ok(res.willDelete);
      assert.strictEqual(res.willDelete!.kbExists, true);
      assert.strictEqual(res.willDelete!.registered, true);
    }
    // 预览不应真正删除
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'projZ')), true);
  });
});
