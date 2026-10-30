/**
 * scope-readonly.test.ts —— scope 只读门禁（REQ-20261029-001）
 *
 * 契约：
 *   - 写入通道登记表（EXEMPT_OPS / BLOCKED_OPS）必须覆盖 `withScopeWriteLock` 的全部 op 字面量
 *     —— 新增写通道未登记即测试红（设计 D14 / 验收 18）；
 *   - 只读 scope 上 BLOCKED op 抛 `SCOPE_READONLY`，EXEMPT op（import / 数据源 / 运维）放行；
 *   - 只读名单存顶层 `scopeReadonly`，不影响 `registered`；
 *   - 设置写回后 mtime 必变（等长名单改写的缓存失效保障）。
 *
 * 运行：npx jiti test/scope-readonly.test.ts
 */
import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scope-ro-'));
const cfgPath = path.join(tmpRoot, 'config.yaml');

function writeConfig(readonlyList: string | null): void {
  const lines = [
    `dataDir: ${path.join(tmpRoot, 'data')}`,
    `backupDir: ${path.join(tmpRoot, 'backup')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    'scopeMode: default',
    'scopes:',
    '  demo: {}',
  ];
  if (readonlyList !== null) lines.push('scopeReadonly:', readonlyList);
  fs.writeFileSync(cfgPath, `${lines.join('\n')}\n`, 'utf-8');
}

before(() => {
  process.env.KI_CONFIG_PATH = cfgPath;
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'backup'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'vector'), { recursive: true });
  writeConfig(null);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function loadModules() {
  const policy = await import('../src/lib/scope-policy.js');
  const config = await import('../src/lib/config.js');
  return { policy, config };
}

describe('写入通道登记表', () => {
  it('覆盖 withScopeWriteLock 的全部 op 字面量（新增写通道必须显式表态）', async () => {
    const { policy } = await loadModules();
    const srcRoot = path.resolve(import.meta.dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    const ops = new Set<string>();
    const re = /withScopeWriteLock\([^;]{0,200}?'([a-z0-9-]+)'/g;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const match of text.matchAll(re)) ops.add(match[1]);
    }

    assert.ok(ops.size >= 20, `扫描到的写锁 op 数量异常（${ops.size}）`);
    const unknown = [...ops].filter((op) => policy.describeOperationPolicy(op) === 'unknown');
    assert.deepEqual(unknown, [], `以下写锁 op 未登记到 EXEMPT_OPS / BLOCKED_OPS：${unknown.join(', ')}`);
  });

  it('未登记 op 判为 unknown（默认按拦截处理）', async () => {
    const { policy } = await loadModules();
    assert.equal(policy.describeOperationPolicy('foo-write'), 'unknown');
    assert.equal(policy.describeOperationPolicy('import'), 'exempt');
    assert.equal(policy.describeOperationPolicy('store'), 'block');
  });
});

describe('只读判定与会话门禁', () => {
  it('只读 scope：逐条写入抛 SCOPE_READONLY，批量/运维放行', async () => {
    writeConfig('  - demo');
    const { policy, config } = await loadModules();
    config.resetConfigCache();

    assert.throws(
      () => policy.assertOperationWritable('demo', 'store'),
      (err: unknown) => (err as { code?: string }).code === 'SCOPE_READONLY'
        && (err as Error).message.includes('ki scope readonly demo --off'),
    );
    // 批量更新通道与运维：必须放行（否则无法更新数据）
    policy.assertOperationWritable('demo', 'import');
    policy.assertOperationWritable('demo', 'datasource-sync');
    policy.assertOperationWritable('demo', 'scope-clear');
    policy.assertOperationWritable('demo', 'restore-snapshot');
    // 其他 scope 不受影响
    policy.assertOperationWritable('other', 'store');
  });

  it('只读名单不影响 registered（strict 下不构成反向授权）', async () => {
    writeConfig('  - demo');
    const { config } = await loadModules();
    config.resetConfigCache();
    const cfg = config.loadConfig();
    assert.equal(config.isScopeReadonly(cfg, 'demo'), true);
    // demo 已注册但 ghost 未注册，只读状态与 registered 正交
    assert.deepEqual(config.getScopeReadonlyScopes(cfg), ['demo']);
  });

  it('名单归一化：trim + 去重（保序）；元素类型错误由 schema fail-loud', async () => {
    // 类型错误：与其它字段同口径 fail-loud（schema 严格校验，不静默丢弃）
    fs.writeFileSync(
      cfgPath,
      [
        `dataDir: ${path.join(tmpRoot, 'data')}`,
        `backupDir: ${path.join(tmpRoot, 'backup')}`,
        `vectorDir: ${path.join(tmpRoot, 'vector')}`,
        'scopeMode: default',
        'scopes:',
        '  demo: {}',
        'scopeReadonly:',
        '  - demo',
        '  - 42',
        '',
      ].join('\n'),
      'utf-8',
    );
    const { config } = await loadModules();
    config.resetConfigCache();
    assert.throws(() => config.loadConfig(), /CONFIG_FIELD_INVALID|scopeReadonly/);

    // 合法值：trim + 去重
    fs.writeFileSync(
      cfgPath,
      [
        `dataDir: ${path.join(tmpRoot, 'data')}`,
        `backupDir: ${path.join(tmpRoot, 'backup')}`,
        `vectorDir: ${path.join(tmpRoot, 'vector')}`,
        'scopeMode: default',
        'scopes:',
        '  demo: {}',
        'scopeReadonly:',
        '  - " demo "',
        '  - demo',
        '',
      ].join('\n'),
      'utf-8',
    );
    config.resetConfigCache();
    assert.deepEqual(config.getScopeReadonlyScopes(config.loadConfig()), ['demo']);
  });
});

describe('设置写回', () => {
  it('设置/解除/幂等/等长切换：状态正确且 mtime 必变', async () => {
    writeConfig(null);
    const { config } = await loadModules();
    config.resetConfigCache();

    const mtimeOf = (): number => fs.statSync(cfgPath).mtimeMs;
    const readList = (): string[] => {
      const cfg = config.loadConfig();
      return config.getScopeReadonlyScopes(cfg);
    };

    const m0 = mtimeOf();
    const on = config.setScopeReadonlyInConfigFile('demo', true);
    assert.equal(on.ok, true);
    assert.equal((on as { changed: boolean }).changed, true);
    assert.ok(mtimeOf() !== m0, '设置后 mtime 必须变化（等长改写的缓存失效保障）');
    assert.deepEqual(readList(), ['demo']);

    const again = config.setScopeReadonlyInConfigFile('demo', true);
    assert.equal((again as { changed: boolean }).changed, false);

    // 等长名单切换：demo → demo2（同长度），mtime 仍须变化
    const m1 = mtimeOf();
    config.setScopeReadonlyInConfigFile('demo2', true);
    assert.ok(mtimeOf() !== m1, '等长切换后 mtime 必须变化');
    assert.deepEqual(readList(), ['demo', 'demo2']);

    const off = config.setScopeReadonlyInConfigFile('demo', false);
    assert.equal(off.ok, true);
    assert.deepEqual(readList(), ['demo2']);

    // 清空后不残留空节点
    config.setScopeReadonlyInConfigFile('demo2', false);
    assert.equal(fs.readFileSync(cfgPath, 'utf-8').includes('scopeReadonly'), false);
  });

  it('无配置文件时 fail-loud（不静默成功）', async () => {
    const missing = path.join(tmpRoot, 'nope.yaml');
    const cfg = (await loadModules()).config;
    const prev = process.env.KI_CONFIG_PATH;
    process.env.KI_CONFIG_PATH = missing;
    cfg.resetConfigCache();
    try {
      // 显式路径不存在会抛错（loadConfig fail-loud），这本身即预期行为
      assert.throws(() => cfg.setScopeReadonlyInConfigFile('demo', true));
    } finally {
      process.env.KI_CONFIG_PATH = prev;
      cfg.resetConfigCache();
    }
  });
});
