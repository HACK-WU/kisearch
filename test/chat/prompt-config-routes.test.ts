/**
 * prompt-config 路由级测试（对话配置层 · 批次 1 · 工作项 2）
 *
 * ═══ 为什么单开一个文件（而不是并进 prompt-config.test.ts）═══
 * `prompt-config.test.ts` 测的是**模块函数**（读/写/校验/注入）；
 * 本文件测的是**HTTP 路由契约**：状态码、`{ok,error,code,details}` 外壳、落盘副作用。
 * 两者失败原因完全不同（一个是逻辑错、一个是接线错），分开才能一眼定位。
 *
 * ═══ 手法（与 e2e-sr01-edit.test.ts 同模式）═══
 * 起真实 http server 挂 `handleChatRoutes`，`configSnapshot` 注入**临时 chatDir**
 * → 全程不碰真实 `~/.ki` 配置；断言同时读 HTTP 响应（契约）与磁盘（落盘真的发生）。
 *
 * 运行：`npx jiti test/chat/prompt-config-routes.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 避开本机 daemon(7423) 与既有 e2e 端口（7489 / 7491） */
const PORT = 7493;
const BASE = `http://127.0.0.1:${PORT}`;

let root = '';
let chatDir = '';
let server: Server;
let handleChatRoutes: (req: never, res: never, url: URL, ctx: unknown) => Promise<boolean>;
/** 按请求覆盖 ctx（只读门禁用例）：缺省空对象 = 本地全权 */
let ctxExtra: Record<string, unknown> = {};

/** 配置文件落点（与 prompt-config.ts::promptConfigPath 同口径） */
const configFile = (): string => path.join(chatDir, 'prompt-config.json');

interface ApiRes {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

async function api(method: string, p: string, body?: unknown): Promise<ApiRes> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    /* 非 JSON 响应保留 text，供断言看原文 */
  }
  return { status: res.status, json, text };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-prompt-cfg-routes-'));
  chatDir = path.join(root, 'chat');
  const mod = await import('../../src/lib/chat/chat-routes.js');
  handleChatRoutes = mod.handleChatRoutes as typeof handleChatRoutes;
  const cfgSnapshot = { dataDir: path.join(root, 'kb'), chatDir };

  server = createServer((rq, rs) => {
    void (async () => {
      // 注意：**不要**在这里预读 body —— handleChatRoutes 内部会读，预读会把流消费掉
      const url = new URL(rq.url ?? '/', BASE);
      const handled = await handleChatRoutes(rq as never, rs as never, url, {
        authScopes: null,
        configSnapshot: cfgSnapshot,
        // 只读门禁用例按请求覆盖（缺省不传 = 本地全权，与既有用例口径一致）
        ...ctxExtra,
      });
      if (!handled) {
        rs.writeHead(404, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ ok: false, code: 'NOT_HANDLED' }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────

describe('GET /api/chat/prompt-config', () => {
  // ★ 顺序敏感：本用例必须在任何 PUT 之前跑（断言"从未配置过"的状态）
  it('未配置过 → 200，config 等于 defaults，issue 为 null（不是错误）', async () => {
    const r = await api('GET', '/api/chat/prompt-config');
    assert.equal(r.status, 200);
    assert.equal(r.json?.ok, true);
    assert.deepEqual(r.json?.config, r.json?.defaults, '未配置时 config 应等于内置默认');
    const config = r.json?.config as { prompt: { content: string }; skills: Array<{ content: string }> };
    assert.ok(config.prompt.content.trim().length > 0, '基础规则必须在编辑器中可见');
    assert.ok(config.skills[0].content.length > 1000, '返回场景检索 skill，而非旧的简短模板');
    assert.equal(r.json?.issue, null);
    assert.ok(!fs.existsSync(configFile()), '读接口不得创建配置文件');
  });

  it('limits 与 toolGroups 由服务端下发（前端不必硬编码上限，更不该硬编码工具名）', async () => {
    const r = await api('GET', '/api/chat/prompt-config');
    const limits = r.json?.limits as Record<string, number>;
    assert.equal(limits.promptMaxChars, 4000);
    assert.equal(limits.skillMaxChars, 8000);
    assert.equal(limits.maxSkills, 20);
    assert.equal(typeof limits.skillNameMaxChars, 'number');

    // 工具分组（工作项 4 落地时补下发）：顺序固定 + 总数 = 代码里真实注册的工具数
    const groups = r.json?.toolGroups as Array<{ key: string; danger: boolean; names: string[]; descs: Record<string, string> }>;
    assert.deepEqual(groups.map((g) => g.key), ['read', 'write', 'delete']);
    assert.deepEqual(groups.map((g) => g.danger), [false, true, true], '只有只读组不是危险组');
    /*
     * 不硬编码总数（2026-11-19）：工具增减过一次，硬编码 14 让这条用例常红，
     * 与真实契约（"下发必须与代码里注册的一致"）也无关。改为与源码常量对照。
     */
    const { MCP_TOOL_GROUPS } = await import('../../src/lib/chat/prompt-config.js');
    assert.equal(
      groups.reduce((n, g) => n + g.names.length, 0),
      MCP_TOOL_GROUPS.reduce((n, g) => n + g.names.length, 0),
      '下发的工具总数必须与代码里真实注册的工具数一致',
    );

    // 走查 #7：每个工具都要有非空短描述（配置层工具行的说明文案，SSOT 在服务端）
    for (const g of groups) {
      for (const n of g.names) {
        assert.ok(typeof g.descs[n] === 'string' && g.descs[n].length > 0, `工具 ${n} 缺少描述`);
      }
    }
  });

  it('文件损坏 → 200 + config 回退默认 + issue 非 null（fail-loud 不静默）', async () => {
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(configFile(), '{ 这不是 JSON', 'utf-8');
    const r = await api('GET', '/api/chat/prompt-config');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json?.config, r.json?.defaults, '损坏时应回退默认');
    assert.match(String(r.json?.issue), /JSON/, 'issue 要说明原因');
    fs.rmSync(configFile(), { force: true });
  });
});

describe('PUT /api/chat/prompt-config', () => {
  it('合法输入 → 200，落盘，再 GET 能读回同一份', async () => {
    const next = {
      prompt: { content: '你是 kisearch 助手。' },
      skills: [
        { id: 'builtin-retrieval', name: 'knowledge-retrieval', content: '内置默认内容（被改过）', enabled: true },
        // skill 名必须是英文（现行校验规则）：中文名会被 PROMPT_CONFIG_INVALID 拒掉
        { id: 'deploy-search', name: 'deploy-search', content: '先 ki_query_group 看结构。', enabled: true },
      ],
      tools: { ki_search: true, ki_store: true },
    };
    const put = await api('PUT', '/api/chat/prompt-config', next);
    assert.equal(put.status, 200);
    assert.equal(put.json?.ok, true);

    // 落盘副作用（不是只看响应）
    assert.ok(fs.existsSync(configFile()), 'PUT 应把配置写到 chatDir/prompt-config.json');
    const onDisk = JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as { prompt: { content: string } };
    assert.equal(onDisk.prompt.content, '你是 kisearch 助手。');

    // 读回一致
    const got = await api('GET', '/api/chat/prompt-config');
    const cfg = got.json?.config as { prompt: { content: string }; skills: Array<{ id: string }>; tools: Record<string, boolean> };
    assert.equal(cfg.prompt.content, '你是 kisearch 助手。');
    // 提交的两个 skill 必须按原顺序保留在前；其余是服务端自动补齐的内置 skill（数量会随版本增加，不硬编码全表）
    assert.deepEqual(cfg.skills.map((s) => s.id).slice(0, 2), ['builtin-retrieval', 'deploy-search']);
    assert.equal(cfg.tools.ki_store, true);
  });

  it('内置与否由服务端决定：客户端传 builtin:false 也被纠正为 true', async () => {
    const put = await api('PUT', '/api/chat/prompt-config', {
      skills: [{ id: 'builtin-retrieval', name: 'knowledge-retrieval', content: 'x', builtin: false, enabled: true }],
    });
    assert.equal(put.status, 200);
    const saved = put.json?.config as { skills: Array<{ id: string; builtin: boolean }> };
    assert.equal(saved.skills.find((s) => s.id === 'builtin-retrieval')?.builtin, true);
  });

  it('提示词超长 → 400 PROMPT_CONFIG_INVALID，details 指向 prompt.content，且不落盘', async () => {
    const before = fs.existsSync(configFile()) ? fs.readFileSync(configFile(), 'utf-8') : null;
    const r = await api('PUT', '/api/chat/prompt-config', { prompt: { content: 'x'.repeat(4001) } });
    assert.equal(r.status, 400);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.code, 'PROMPT_CONFIG_INVALID');
    const details = r.json?.details as Array<{ field: string; message: string }>;
    assert.ok(details.some((d) => d.field === 'prompt.content'), `details 应指向 prompt.content：${JSON.stringify(details)}`);
    const after_ = fs.existsSync(configFile()) ? fs.readFileSync(configFile(), 'utf-8') : null;
    assert.equal(after_, before, '校验失败不得落盘（半截写入会污染后续生成）');
  });

  it('未知工具名 → 400，details 指向该工具（拼错名字不静默丢弃）', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', { tools: { ki_serach: true } });
    assert.equal(r.status, 400);
    assert.equal(r.json?.code, 'PROMPT_CONFIG_INVALID');
    const details = r.json?.details as Array<{ field: string }>;
    assert.ok(details.some((d) => d.field === 'tools.ki_serach'), JSON.stringify(details));
  });

  it('传空 skills 数组 → 200，内置 skill 自动补齐（内置可禁用不可删除）', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', { skills: [] });
    assert.equal(r.status, 200);
    // 现行规则：空数组按"没传"处理并补回内置 skill，而不是报错
    const saved = r.json?.config as { skills: Array<{ id: string; builtin: boolean }> };
    const builtin = saved.skills.find((s) => s.id === 'builtin-retrieval');
    assert.ok(builtin, `内置 skill 必须被补齐：${JSON.stringify(saved.skills.map((s) => s.id))}`);
    assert.equal(builtin?.builtin, true);
  });

  it('skill 重名 → 400，details 指向 name', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', {
      skills: [
        { id: 'builtin-retrieval', name: '同名', content: 'a', enabled: true },
        { id: 'other', name: '同名', content: 'b', enabled: true },
      ],
    });
    assert.equal(r.status, 400);
    const details = r.json?.details as Array<{ field: string }>;
    assert.ok(details.some((d) => d.field.endsWith('.name')), JSON.stringify(details));
  });

  it('请求体不是合法 JSON → 400（错误外壳与其他接口一致）', async () => {
    const res = await fetch(`${BASE}/api/chat/prompt-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ 坏 JSON',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'API_ERROR');
  });

  it('PUT {} → 200 且内容回到默认（整体替换语义）', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', {});
    assert.equal(r.status, 200);
    const got = await api('GET', '/api/chat/prompt-config');
    const cfg = got.json?.config as {
      prompt: { content: string };
      skills: Array<{ id: string; content: string }>;
      tools: Record<string, boolean>;
    };
    const def = got.json?.defaults as typeof cfg;
    // 注意：不能整体 deepEqual —— `at` 由服务端打本次写入时间（有意区分"改过"与"没改过"），
    // 前端「恢复默认」的判定也应比较内容而不是整对象（口径见 plan.md 决策 #7）。
    assert.equal(cfg.prompt.content, def.prompt.content, '基础提示词应回到当前默认规则');
    assert.deepEqual(cfg.skills.map((s) => [s.id, s.content]), def.skills.map((s) => [s.id, s.content]));
    assert.deepEqual(cfg.tools, def.tools, '工具开关应回到默认（只读开、写删关）');
  });
});

/**
 * 只读门禁（2026-11-15 · AI 设置入口）
 *
 * 此前 PUT 只看「是否持有全 scope」—— viewer 角色若拿到 all-scope token 仍能改全局 AI 配置。
 * 本组锁住能力维度：缺 `knowledge.write` 一律 403，且**不落盘**。
 */
describe('PUT /api/chat/prompt-config · 只读能力门禁', () => {
  it('capabilities 缺 knowledge.write → 403，且请求被拒时不落盘', async () => {
    const before = fs.existsSync(configFile()) ? fs.readFileSync(configFile(), 'utf-8') : null;
    ctxExtra = { capabilities: new Set(['knowledge.read', 'chat.use']) };
    try {
      const r = await api('PUT', '/api/chat/prompt-config', { prompt: { content: '只读不该写进来' } });
      assert.equal(r.status, 403);
      assert.match(String(r.json?.error ?? ''), /knowledge\.write/, '错误文案要点明缺哪个能力');
      const after2 = fs.existsSync(configFile()) ? fs.readFileSync(configFile(), 'utf-8') : null;
      assert.equal(after2, before, '被拒的请求不得改动配置文件');
    } finally {
      ctxExtra = {};
    }
  });

  it('capabilities 含 knowledge.write → 放行（能力与 scope 两道都要过）', async () => {
    ctxExtra = { capabilities: new Set(['knowledge.read', 'knowledge.write']) };
    try {
      const r = await api('PUT', '/api/chat/prompt-config', { prompt: { content: '有写权限应放行' } });
      assert.equal(r.status, 200);
    } finally {
      ctxExtra = {};
    }
  });
});

/**
 * 检索范围的保存期预检（REQ-20261116-005 · A3）
 *
 * 保存期**复用运行期的 `resolveFindTargets`**：它返回的 `skipped` 就是"查找时会被剔除"
 * 的项。能改全局配置的 token 必然是 all-scope（`requireGlobalConfigWrite`），而 all-scope
 * 让授权类判定恒真，因此真正被拦下的是**名字不存在**与**视图无成员**两类。
 */
describe('PUT · 检索范围预检（与运行期同口径）', () => {
  const viewName = 'ops-view';
  let viewsRoot = '';

  before(() => {
    viewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-views-'));
    fs.writeFileSync(
      path.join(viewsRoot, 'views.json'),
      JSON.stringify({
        version: 2,
        views: { [viewName]: { id: 'v_opsview', members: ['ops-a', 'ops-b'], revision: 1 } },
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
  });

  /** `getViewsPath` 以 `_configPath` 的目录为锚；不给它会去读真实 `~/.ki/views.json` */
  const snapshotWithViews = () => ({
    dataDir: path.join(viewsRoot, 'kb'),
    chatDir,
    _configPath: path.join(viewsRoot, 'config.yaml'),
  });

  it('名字既不是库也不是视图 → 400，details 指向该项', async () => {
    ctxExtra = { authScopes: ['all'], configSnapshot: snapshotWithViews() };
    try {
      const r = await api('PUT', '/api/chat/prompt-config', {
        find: { ranges: { extraScopes: ['no-such-scope-xyz'] } },
      });
      assert.equal(r.status, 400, `不存在的名字应拒绝：${r.text}`);
      const details = r.json?.details as Array<{ field: string }>;
      assert.ok(details?.some((d) => d.field.includes('no-such-scope-xyz')), `details 应指向该项：${r.text}`);
      assert.match(String(r.json?.error ?? ''), /不存在/, '文案要说明是"不存在"，不是"无权限"');
    } finally {
      ctxExtra = {};
    }
  });

  it('视图存在（成员齐全）→ 200，且原样落盘', async () => {
    ctxExtra = { authScopes: ['all'], configSnapshot: snapshotWithViews() };
    try {
      const r = await api('PUT', '/api/chat/prompt-config', { find: { ranges: { extraScopes: [viewName] } } });
      assert.equal(r.status, 200, r.text);
      const saved = r.json?.config as { find?: { ranges: { extraScopes: string[] } } };
      assert.deepEqual(saved.find?.ranges.extraScopes, [viewName]);
    } finally {
      ctxExtra = {};
    }
  });
});

describe('护栏自检（可脚本化）', () => {
  it('守 #1：冻结契约未被改动（chat-contract.ts 不含本轮新增错误码）', () => {
    const contract = fs.readFileSync(
      path.join(import.meta.dirname, '..', '..', 'src', 'lib', 'chat', 'chat-contract.ts'),
      'utf-8',
    );
    assert.equal(
      contract.includes('PROMPT_CONFIG_INVALID'),
      false,
      'PROMPT_CONFIG_INVALID 必须仍是 chat-routes.ts 的本地常量（契约冻结期不得并入）',
    );
  });
});
