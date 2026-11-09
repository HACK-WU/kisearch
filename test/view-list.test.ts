/**
 * `ki_view_list` 工具测试（MCP 只读枚举工具）
 *
 * 覆盖：
 *   - 默认输出：精简字段（无 memberMeta），但保留可用性 / 缺失成员 / 维度风险
 *   - verbose：展开 memberMeta 与审计字段
 *   - 授权过滤：与 ki_scope_list 共用 D3（视图名 ∧ 全部成员）
 *   - 三种"空"可区分：没建 / 被授权过滤光 / 视图文件损坏
 *   - schema 不含 scope 参数（否则受限 Token 无参调用会被 scope 校验拦成 403）
 *   - 与 ki_scope_list 的 views 同一口径（同一份 buildViews 产出）
 *
 * 运行：npx jiti test/view-list.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { loadConfig, resetConfigCache, type KiConfig } from '../src/lib/config.js';
import { createView, getViewsPath, readViews } from '../src/lib/scope-view.js';
import { buildViews, collectScopeLayers, type ViewInfo, type ViewMemberMeta } from '../src/scope.js';
import { filterAuthorizedViews } from '../src/lib/mcp-tools/view-auth.js';
import { toCompactView, toVerboseView } from '../src/lib/mcp-tools/view-list.js';
import { buildKiMcpServer } from '../src/lib/mcp-server-factory.js';

let tmpRoot: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

function writeConfig(): string {
  const file = path.join(tmpRoot, 'config.yaml');
  fs.writeFileSync(file, [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    `backupDir: ${path.join(tmpRoot, 'backup')}`,
    'scopeMode: default',
    'scopes: {}',
    '',
  ].join('\n'), 'utf-8');
  return file;
}

/**
 * 造一个「KB 层存在」的 scope。
 *
 * ⚠️ 只建空目录不算：`listAllScopes` 要求 `relations-cache.json` 或
 *   `.relations/manifest.json` 存在（区分"初始化过"与"空目录残留"）。
 */
function makeKbScope(scope: string): void {
  const dir = path.join(tmpRoot, 'kb', scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'relations-cache.json'),
    JSON.stringify({ hot_relations: [], warm_relations: [], cold_relations: [] }),
    'utf-8',
  );
}

interface ToolResult {
  ok?: boolean;
  count?: number;
  views?: Array<Record<string, unknown>>;
  warning?: string;
  hint?: string;
  total?: number;
  truncated?: boolean;
}

/** 真实调用任意工具（走 MCP 协议，覆盖 schema 与鉴权过滤） */
async function callTool(
  name: string,
  auth: { scopes: string[]; readOnly: boolean } | null,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const server = buildKiMcpServer(auth as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ki-view-list-test', version: '0.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, undefined, `工具报错：${JSON.stringify(res.content)}`);
    return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as ToolResult & {
      viewsWarning?: string;
      scopes?: unknown[];
    };
  } finally {
    await client.close();
    await server.close();
  }
}

const callListViews = (
  auth: { scopes: string[]; readOnly: boolean } | null,
  args: Record<string, unknown> = {},
): Promise<ToolResult> => callTool('ki_view_list', auth, args);

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-view-list-'));
  savedEnv = {
    KI_CONFIG_PATH: process.env.KI_CONFIG_PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;

  configPath = writeConfig();
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  makeKbScope('va');
  makeKbScope('vb');
  // vc 故意不建：用来验证 missing / availableCount

  const config = loadConfig();
  createView(config, 'view-ok', ['va', 'vb']);
  createView(config, 'view-partial', ['va', 'vc']);
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ki_view_list · 默认输出', () => {
  it('只给可用性字段，不带 memberMeta（控制 token）', async () => {
    const res = await callListViews(null);
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.equal(res.warning, undefined);
    assert.equal(res.hint, undefined);

    const ok = res.views!.find((v) => v.view === 'view-ok')!;
    assert.ok(ok, 'view-ok 应出现');
    assert.equal(typeof ok.id, 'string');
    assert.deepEqual(ok.members, ['va', 'vb']);
    assert.equal(ok.availableCount, 2);
    assert.deepEqual(ok.missing, []);
    assert.equal('memberMeta' in ok, false, '默认不得带 memberMeta');
    assert.equal('revision' in ok, false, '默认不得带审计字段');
    /*
     * 本测试环境只有 KB 目录、没有向量层（未配 embedding），故成员都是"只有 KB"：
     * 健康度必须**如实**报 0 并说明原因 —— 若把"kb 存在"当成可用，
     * 视图成员在语义检索里实际会被全部跳过而工具却说"健康"，就是静默误导。
     */
    assert.equal(ok.usableCount, 0, '无语义层时不得把成员算作可用');
    assert.match(ok.degradedReason ?? '', /只有 KB/);
  });

  it('成员库不存在时进 missing，availableCount 相应减少', async () => {
    const res = await callListViews(null);
    const partial = res.views!.find((v) => v.view === 'view-partial')!;
    assert.deepEqual(partial.missing, ['vc']);
    assert.equal(partial.availableCount, 1);
  });

  it('verbose 展开 memberMeta（与 ki_scope_list 同口径）', async () => {
    const res = await callListViews(null, { verbose: true });
    const ok = res.views!.find((v) => v.view === 'view-ok')!;
    const meta = ok.memberMeta as Array<{ scope: string; kb: boolean }>;
    assert.ok(Array.isArray(meta));
    assert.deepEqual(meta.map((m) => m.scope), ['va', 'vb']);
    assert.equal(meta[0]!.kb, true);
    assert.equal(typeof ok.revision, 'number');
  });
});

describe('ki_view_list · 授权过滤（D3：视图名 ∧ 全部成员）', () => {
  it('缺任一成员授权 → 整个视图不出现', async () => {
    // 只授权 view-ok 的视图名 + va（缺 vb）
    const res = await callListViews({ scopes: ['view-ok', 'va'], readOnly: true });
    assert.equal(res.count, 0, '缺成员授权的视图必须整体隐藏（不做部分可见）');
    assert.match(res.hint ?? '', /授权/, '必须说明是被授权过滤，而非"没建过"');
  });

  it('视图名与全部成员都授权 → 正常出现', async () => {
    const res = await callListViews({ scopes: ['view-ok', 'va', 'vb'], readOnly: true });
    assert.equal(res.count, 1);
    assert.equal(res.views![0]!.view, 'view-ok');
  });

  it('授权全部（all 通配）不过滤', async () => {
    const res = await callListViews({ scopes: ['all'], readOnly: true });
    assert.equal(res.count, 2);
  });
});

describe('ki_view_list · 三种"空"可区分', () => {
  it('视图文件损坏 → warning（不是"没建过"）', async () => {
    const viewsFile = getViewsPath(loadConfig());
    const backup = fs.existsSync(viewsFile) ? fs.readFileSync(viewsFile, 'utf-8') : null;
    try {
      fs.writeFileSync(viewsFile, '{ this is not json', 'utf-8');
      const res = await callListViews(null);
      assert.equal(res.ok, true, '损坏不能整工具失败：一个视图读坏不该让列表不可用');
      assert.equal(res.count, 0);
      assert.match(res.warning ?? '', /读取失败/);
      assert.match(res.hint ?? '', /不代表/);
    } finally {
      if (backup === null) fs.rmSync(viewsFile, { force: true });
      else fs.writeFileSync(viewsFile, backup, 'utf-8');
    }
  });

  it('ki_scope_list 同样透出 viewsWarning（既有工具也修掉静默）', async () => {
    const viewsFile = getViewsPath(loadConfig());
    const backup = fs.readFileSync(viewsFile, 'utf-8');
    try {
      fs.writeFileSync(viewsFile, '{ broken', 'utf-8');
      const res = await callTool('ki_scope_list', null);
      assert.equal(res.ok, true, 'scope 列表本身仍可用');
      assert.equal(res.views, undefined, '读不到视图时不给 views');
      assert.match(res.viewsWarning ?? '', /读取失败/, '必须透出，不能只写 stderr');
      assert.ok(Array.isArray(res.scopes), 'scope 段不受影响');
    } finally {
      fs.writeFileSync(viewsFile, backup, 'utf-8');
    }
  });

  it('确实没有视图 → 给创建命令', async () => {
    const viewsFile = getViewsPath(loadConfig());
    const backup = fs.readFileSync(viewsFile, 'utf-8');
    try {
      fs.rmSync(viewsFile, { force: true });
      const res = await callListViews(null);
      assert.equal(res.count, 0);
      assert.equal(res.warning, undefined, '没有视图不是错误');
      assert.match(res.hint ?? '', /ki view create/);
    } finally {
      fs.writeFileSync(viewsFile, backup, 'utf-8');
    }
  });
});

describe('ki_view_list · schema 与口径', () => {
  it('schema 不含 scope 参数（否则受限 Token 会被 scope 校验拦成 403）', async () => {
    const server = buildKiMcpServer(null);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ki-view-list-schema', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === 'ki_view_list');
      assert.ok(tool, 'ki_view_list 必须出现在 tools/list');
      const props = Object.keys((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      assert.deepEqual(props, ['verbose']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('与 ki_scope_list 同源：buildViews 的产出与工具响应逐字段一致', async () => {
    const config = loadConfig();
    const { kbScopes, vectorScopes } = await collectScopeLayers();
    const { views } = buildViews(config, kbScopes, vectorScopes);
    const res = await callListViews(null, { verbose: true });
    assert.deepEqual(
      res.views!.map((v) => v.view).sort(),
      (views ?? []).map((v) => v.view).sort(),
    );
    const fromTool = res.views!.find((v) => v.view === 'view-partial')!;
    const fromBuild = views!.find((v) => v.view === 'view-partial')!;
    assert.deepEqual(fromTool.members, fromBuild.members);
    assert.deepEqual(fromTool.missing, fromBuild.missing);
  });
});

/** 全健康成员 */
const fakeView = (name: string, members: string[]): ViewInfo => ({
  view: name,
  id: `v_${name}`,
  members,
  memberMeta: members.map((m) => ({ scope: m, kb: true, vector: true, readonly: false })),
  availableCount: members.length,
  missing: [],
  revision: 1,
});

/** 自定义成员元信息（覆盖 kb / vector / dimensionState 的各种组合） */
const makeView = (name: string, metas: Array<{ scope: string } & Partial<ViewMemberMeta>>): ViewInfo => ({
  view: name,
  id: `v_${name}`,
  members: metas.map((m) => m.scope),
  memberMeta: metas.map((m) => ({ kb: true, vector: true, readonly: false, ...m })),
  availableCount: metas.filter((m) => !(m.kb === false && m.vector === false)).length,
  missing: metas.filter((m) => m.kb === false && m.vector === false).map((m) => m.scope),
  revision: 1,
});

describe('view-auth / toCompactView 纯函数', () => {
  it('undefined 原样返回（区分「没有视图定义」与「全被过滤」）', () => {
    assert.equal(filterAuthorizedViews(undefined, ['a']), undefined);
    assert.equal(filterAuthorizedViews(undefined, null), undefined);
  });

  it('authScopes=null 不过滤；否则按 视图名 ∧ 全部成员', () => {
    const views = [fakeView('v1', ['a', 'b']), fakeView('v2', ['a'])];
    assert.equal(filterAuthorizedViews(views, null)!.length, 2);
    assert.deepEqual(
      filterAuthorizedViews(views, ['v1', 'a'])!.map((v) => v.view),
      [],
      'v1 缺 b 授权 → 整体隐藏',
    );
    assert.deepEqual(
      filterAuthorizedViews(views, ['v1', 'a', 'b'])!.map((v) => v.view),
      ['v1'],
    );
  });

  it('toCompactView 默认透出维度不一致成员，且不复制 memberMeta', () => {
    const view = fakeView('v1', ['a', 'b']);
    view.memberMeta[1]!.dimensionState = 'mismatch';
    const compact = toCompactView(view);
    assert.deepEqual(compact.dimensionMismatch, ['b']);
    assert.equal('memberMeta' in compact, false);
    assert.equal(compact.view, 'v1');
  });

  it('无维度不一致时不输出该字段（避免空数组噪音）', () => {
    assert.equal('dimensionMismatch' in toCompactView(fakeView('v1', ['a'])), false);
  });

  it('verbose 条目同样带维度汇总（两种详略口径都能看见漏召回风险）', () => {
    const view = fakeView('v1', ['a', 'b']);
    view.memberMeta[0]!.dimensionState = 'mismatch';
    const verbose = toVerboseView(view);
    assert.deepEqual(verbose.dimensionMismatch, ['a']);
    assert.equal(verbose.memberMeta.length, 2, 'verbose 仍保留完整成员元信息');
    assert.equal('dimensionMismatch' in toVerboseView(fakeView('v2', ['a'])), false);
  });
});

describe('视图健康度（usableCount / degradedReason）', () => {
  it('全部健康 → usableCount = 成员数，且不给 degradedReason', () => {
    const compact = toCompactView(fakeView('v1', ['a', 'b']));
    assert.equal(compact.usableCount, 2);
    assert.equal('degradedReason' in compact, false, '正常视图不该带一句"正常"的噪音');
  });

  it('维度不一致 → 该成员不计入 usable，且点名"语义检索会跳过"', () => {
    const view = makeView('v1', [
      { scope: 'a' },
      { scope: 'b', dimensionState: 'mismatch' },
    ]);
    const compact = toCompactView(view);
    assert.equal(compact.usableCount, 1);
    assert.match(compact.degradedReason!, /2 个成员中 1 个不可完整使用/);
    assert.match(compact.degradedReason!, /1 个向量维度不一致（语义检索会跳过）/);
    assert.deepEqual(compact.dimensionMismatch, ['b']);
  });

  it('四类降级互斥分类：维度不一致 / 只有 KB / 只有向量 / 两层都无', () => {
    const view = makeView('v1', [
      { scope: 'ok' },
      { scope: 'dim', dimensionState: 'mismatch' },
      { scope: 'kb-only', vector: false },
      { scope: 'vec-only', kb: false },
      { scope: 'gone', kb: false, vector: false },
    ]);
    const compact = toCompactView(view);
    assert.equal(compact.usableCount, 1, '只有 ok 是可完整使用的');
    assert.match(compact.degradedReason!, /5 个成员中 4 个不可完整使用/);
    assert.match(compact.degradedReason!, /1 个向量维度不一致/);
    assert.match(compact.degradedReason!, /1 个只有 KB/);
    assert.match(compact.degradedReason!, /1 个只有向量层/);
    assert.match(compact.degradedReason!, /1 个两层都不存在/);
  });

  it('全部成员不可用 → usableCount 0（真实数据里 first-view 的形态）', () => {
    const view = makeView('v1', [
      { scope: 'a', dimensionState: 'mismatch' },
      { scope: 'b', vector: false },
      { scope: 'c', kb: false },
    ]);
    assert.equal(toCompactView(view).usableCount, 0);
  });

  it('dimensionState 为 unknown / 缺省 → 按可用计（未确认不等于不可用）', () => {
    const view = makeView('v1', [
      { scope: 'a', dimensionState: 'unknown' },
      { scope: 'b' },
    ]);
    const compact = toCompactView(view);
    assert.equal(compact.usableCount, 2);
    assert.equal('degradedReason' in compact, false);
  });

  it('verbose 条目同样带健康摘要（与默认态同一告警位置）', () => {
    const view = makeView('v1', [
      { scope: 'a' },
      { scope: 'b', dimensionState: 'mismatch' },
    ]);
    const verbose = toVerboseView(view);
    assert.equal(verbose.usableCount, 1);
    assert.match(verbose.degradedReason!, /语义检索会跳过/);
    assert.equal(verbose.memberMeta.length, 2);
  });
});

// 确保 readViews 在本测试的隔离配置下可用（防止 before 写配置失败被静默）
describe('测试环境自检', () => {
  it('视图已落盘到临时配置目录（不污染真实 ~/.ki）', () => {
    const views = readViews(loadConfig() as KiConfig);
    assert.deepEqual(Object.keys(views).sort(), ['view-ok', 'view-partial']);
    assert.equal(getViewsPath(loadConfig()).startsWith(tmpRoot), true);
  });
});
