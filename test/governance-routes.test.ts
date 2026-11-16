/**
 * governance-routes.test.ts —— S-06 契约层门禁（B6）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-routes.test.ts
 *
 * 这个文件存在的唯一理由：**30 条路由 + 4 个工具分散在 5 处登记**，漏任何一处都
 * 不会编译报错，只会静默坏掉：
 *
 *   - 漏 `route-permissions.ts`  → matchRoute 判 unknown → 404（前端只看到"接口不存在"）
 *   - 漏 `READ_ONLY_TOOL_NAMES`  → 只读 Token 看不见（方向安全，但功能缺失）
 *   - 漏 `READ_MCP_TOOLS`        → 被导入长任务串行阻塞几十秒
 *   - 漏 `TOOL_CAPABILITIES`     → chat 工具循环越权（403 或静默拒绝）
 *   - 漏 `mcp-server-factory`    → 工具根本不存在
 *
 * 所以这里用**源码 + 常量双读**把它们钉在一起，并断言"不含创建类工具"（A20）。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';

import { matchRoute } from '../src/lib/auth/route-permissions.js';
import { TOOL_CAPABILITIES } from '../src/lib/auth/tool-permissions.js';
import { READ_ONLY_TOOL_NAMES } from '../src/lib/mcp-tools/tool-access.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const ROOT = process.cwd();

/** 39 条治理路由：`[method, path, 期望能力]`。改路由必须同步改这张表（表就是契约） */
const ROUTES: Array<[string, string, 'knowledge.read' | 'knowledge.write']> = [
  ['GET', '/governance/lifecycle/list', 'knowledge.read'],
  ['POST', '/governance/lifecycle/apply', 'knowledge.write'],
  ['POST', '/governance/lifecycle/batch-apply', 'knowledge.write'],
  ['GET', '/governance/lifecycle/presets', 'knowledge.read'],
  ['POST', '/governance/lifecycle/presets', 'knowledge.write'],
  ['DELETE', '/governance/lifecycle/presets/preset_x', 'knowledge.write'],
  ['GET', '/governance/event-types', 'knowledge.read'],
  ['POST', '/governance/event-types', 'knowledge.write'],
  ['PATCH', '/governance/event-types/et_1', 'knowledge.write'],
  ['DELETE', '/governance/event-types/et_4', 'knowledge.write'],
  ['GET', '/governance/events', 'knowledge.read'],
  ['POST', '/governance/events', 'knowledge.write'],
  ['GET', '/governance/events/evt_1', 'knowledge.read'],
  ['PATCH', '/governance/events/evt_1', 'knowledge.write'],
  ['DELETE', '/governance/events/evt_1', 'knowledge.write'],
  ['POST', '/governance/events/evt_1/stage', 'knowledge.write'],
  ['POST', '/governance/events/evt_1/reopen', 'knowledge.write'],
  ['GET', '/governance/events/evt_1/refs', 'knowledge.read'],
  ['POST', '/governance/events/evt_1/refs', 'knowledge.write'],
  ['DELETE', '/governance/events/evt_1/refs', 'knowledge.write'],
  ['POST', '/governance/events/evt_1/refs/search', 'knowledge.read'],
  // REQ-20261116-004：关联文档增删（漏登记会 404，不是 403）
  ['POST', '/governance/events/evt_1/members', 'knowledge.write'],
  ['DELETE', '/governance/events/evt_1/members', 'knowledge.write'],
  ['POST', '/governance/events/evt_1/analyze', 'knowledge.write'],
  ['GET', '/governance/events/evt_1/analysis', 'knowledge.read'],
  ['POST', '/governance/events/evt_1/analysis/confirm', 'knowledge.write'],
  ['DELETE', '/governance/events/evt_1/analysis/draft', 'knowledge.write'],
  ['POST', '/governance/events/evt_1/analysis/cancel', 'knowledge.write'],
  ['DELETE', '/governance/events/evt_1/analysis/confirmed/loc_1', 'knowledge.write'],
  ['GET', '/governance/docs', 'knowledge.read'],
  ['GET', '/governance/docs/search', 'knowledge.read'],
  ['GET', '/governance/trash', 'knowledge.read'],
  ['POST', '/governance/trash/restore', 'knowledge.write'],
  ['POST', '/governance/trash/purge', 'knowledge.write'],
  ['POST', '/governance/trash/sweep', 'knowledge.write'],
  ['GET', '/governance/trash/settings', 'knowledge.read'],
  ['PUT', '/governance/trash/settings', 'knowledge.write'],
  ['GET', '/governance/diagnostics', 'knowledge.read'],
  ['GET', '/governance/counts', 'knowledge.read'],
];

const READ_TOOLS = ['ki_lifecycle_list', 'ki_event_list', 'ki_event_type_list'];
const WRITE_TOOLS = ['ki_event_set_stage'];
const FORBIDDEN_CREATE_TOOLS = ['ki_event_create', 'ki_lifecycle_create', 'ki_event_type_create', 'ki_event_delete', 'ki_event_type_write'];

describe('① 路由权限登记（漏一条就是 404）', () => {
  it('39 条全部命中 permission 且能力正确', () => {
    const problems: string[] = [];
    for (const [method, p, capability] of ROUTES) {
      const match = matchRoute(method, p);
      if (match.kind !== 'permission') {
        problems.push(`${method} ${p} → kind=${match.kind}（期望 permission）`);
        continue;
      }
      if (match.capability !== capability) {
        problems.push(`${method} ${p} → capability=${String(match.capability)}（期望 ${capability}）`);
      }
    }
    assert.deepEqual(problems, [], `以下路由登记有误：\n${problems.join('\n')}`);
  });

  it('表里正好 39 条（新增/删除路由必须同步这张表）', () => {
    assert.equal(ROUTES.length, 39);
  });

  it('未登记的治理子路径仍被判 unknown（防"多登记"造成越权面扩大）', () => {
    for (const [method, p] of [
      ['GET', '/governance/unknown'],
      ['POST', '/governance/events/evt_1/unknown'],
      ['GET', '/governance/trash/settings/extra'],
    ] as Array<[string, string]>) {
      assert.equal(matchRoute(method, p).kind, 'unknown', `${method} ${p} 不应被登记`);
    }
  });
});

describe('② 非治理路径不抢路由', () => {
  it('/api/search 直接返回 false，交给上层继续匹配', async () => {
    const handled = await handleGovernanceRoutes(
      { method: 'GET' } as never,
      {} as never,
      new URL('http://localhost/api/search'),
      { authScopes: null },
    );
    assert.equal(handled, false);
  });

  it('/api/governancex 不能被前缀误判', async () => {
    const handled = await handleGovernanceRoutes(
      { method: 'GET' } as never,
      {} as never,
      new URL('http://localhost/api/governancex/counts'),
      { authScopes: null },
    );
    assert.equal(handled, false);
  });
});

describe('③ MCP 工具四处登记', () => {
  it('能力表：3 读 + 1 写', () => {
    for (const tool of READ_TOOLS) assert.equal(TOOL_CAPABILITIES[tool], 'knowledge.read', `${tool} 能力缺失或错误`);
    for (const tool of WRITE_TOOLS) assert.equal(TOOL_CAPABILITIES[tool], 'knowledge.write', `${tool} 能力缺失或错误`);
  });

  it('只读白名单：含 3 读、不含写工具', () => {
    for (const tool of READ_TOOLS) assert.ok(READ_ONLY_TOOL_NAMES.includes(tool), `${tool} 漏进 READ_ONLY_TOOL_NAMES`);
    for (const tool of WRITE_TOOLS) assert.equal(READ_ONLY_TOOL_NAMES.includes(tool), false, `${tool} 不得进只读白名单`);
  });

  it('调度口径：3 枚举落 read 车道，状态写落 write 串行', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/operation-coordinator.ts'), 'utf8');
    // 切片到 Set 的结束 `]);` —— 集合内部本身带注释，按 '/**' 切会切掉后半段
    const start = src.indexOf('const READ_MCP_TOOLS');
    const block = src.slice(start, src.indexOf(']);', start));
    for (const tool of READ_TOOLS) assert.ok(block.includes(`'${tool}'`), `${tool} 不在 READ_MCP_TOOLS（会被写串行阻塞）`);
    for (const tool of WRITE_TOOLS) assert.equal(block.includes(`'${tool}'`), false, `${tool} 不得进 READ_MCP_TOOLS`);
  });

  it('工厂里 4 个工具都注册了，且写工具在 readOnly 分支内', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/mcp-server-factory.ts'), 'utf8');
    for (const fn of ['registerLifecycleListTool', 'registerEventListTool', 'registerEventTypeListTool', 'registerEventSetStageTool']) {
      assert.ok(src.includes(`${fn}(server)`), `${fn} 未被调用`);
    }
    // 判"调用"而不是"标识符"：import 行在文件顶部，天然出现在 readOnly 分支之前
    const readBlock = src.slice(0, src.indexOf('if (!readOnly)'));
    const writeBlock = src.slice(src.indexOf('if (!readOnly)'));
    assert.equal(readBlock.includes('registerEventSetStageTool(server)'), false, '写工具注册必须在 readOnly 分支内');
    assert.ok(writeBlock.includes('registerEventSetStageTool(server)'), '写工具注册必须在 readOnly 分支内');
  });

  /**
   * A20 在 REQ-20261116-004 之后调整：**事件**的创建/删除与文档增删已开放（4 个工具），
   * 其余创建/删除类治理工具仍不得存在（`ki_lifecycle_create` / `ki_event_type_create` 等）。
   * 断言仍双向：白名单外的必须不存在，白名单内的必须真的存在（防止只删断言不落实现）。
   */
  const ALLOWED_EVENT_TOOLS = ['ki_event_create', 'ki_event_delete', 'ki_event_docs', 'ki_event_refs'];

  it('A20：只开放 4 个事件工具，其余创建 / 删除类治理工具不存在', () => {
    const toolFiles = fs.readdirSync(path.join(ROOT, 'src/lib/mcp-tools')).map((f) => fs.readFileSync(path.join(ROOT, 'src/lib/mcp-tools', f), 'utf8')).join('\n');
    for (const forbidden of FORBIDDEN_CREATE_TOOLS) {
      if (ALLOWED_EVENT_TOOLS.includes(forbidden)) continue;
      assert.equal(toolFiles.includes(`'${forbidden}'`), false, `不应存在工具 ${forbidden}`);
    }
    for (const allowed of ALLOWED_EVENT_TOOLS) {
      assert.ok(toolFiles.includes(`'${allowed}'`), `应存在工具 ${allowed}`);
    }
  });
});

describe('④ 工具名与路由路径一致（防"改了名没改表"）', () => {
  it('工具名集合 = 3 读 + 1 写', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/mcp-tools/lifecycle-list.ts'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'src/lib/mcp-tools/event-list.ts'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'src/lib/mcp-tools/event-type-list.ts'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'src/lib/mcp-tools/event-set-stage.ts'), 'utf8');
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      assert.ok(src.includes(`'${tool}'`), `工具文件里找不到 ${tool}`);
    }
  });
});

/**
 * 真实 HTTP 冒烟：这一组存在的唯一理由是**首版有个挂死 bug** ——
 * `PUT /trash/settings` 里 `readJsonBody` 被调了两次，第二次监听器永不触发，
 * 请求会一直挂着（既不返回也不报错，测试里表现为超时而非失败）。
 * 纯静态断言抓不到这类问题，必须真的发一次请求。
 */
describe('⑤ 真实 HTTP 冒烟（body 只读一次）', () => {
  const scope = `gov-http-${Date.now()}`;
  const created: string[] = [];

  after(() => {
    for (const s of created) {
      const kbDir = getKbDir(s);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
    cleanupTestConfig();
  });

  async function startServer(authScopes: string[] | null): Promise<{ base: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      void handleGovernanceRoutes(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), { authScopes })
        .then((handled) => {
          if (!handled) { res.writeHead(404); res.end(); }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('PUT /trash/settings 会返回（不挂死）并持久化', { timeout: 10_000 }, async () => {
    registerTestScope(scope);
    created.push(scope);
    initScope(scope);
    const { base, close } = await startServer(null);
    try {
      const res = await fetch(`${base}/api/governance/trash/settings?scope=${scope}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepDays: 14, expireAction: 'notify' }),
      });
      assert.equal(res.status, 200);
      const payload = await res.json() as { ok: boolean; settings: { keepDays: number; expireAction: string } };
      assert.equal(payload.ok, true);
      assert.equal(payload.settings.keepDays, 14);
      assert.equal(payload.settings.expireAction, 'notify');

      // 再 GET 一次确认落盘
      const got = await fetch(`${base}/api/governance/trash/settings?scope=${scope}`);
      const body = await got.json() as { settings: { keepDays: number } };
      assert.equal(body.settings.keepDays, 14);
    } finally {
      await close();
    }
  });

  it('越权 scope → 403 且码为 FORBIDDEN_SCOPE（不是数据源锁）', { timeout: 10_000 }, async () => {
    const other = `gov-http-other-${Date.now()}`;
    registerTestScope(other);
    created.push(other);
    initScope(other);
    const { base, close } = await startServer(['some-other-scope']);
    try {
      const res = await fetch(`${base}/api/governance/counts?scope=${other}`);
      assert.equal(res.status, 403);
      const payload = await res.json() as { code?: string };
      assert.equal(payload.code, 'FORBIDDEN_SCOPE');
    } finally {
      await close();
    }
  });

  it('POST /lifecycle/presets：kind=event 被拒；scope 取请求体而非 query', { timeout: 10_000 }, async () => {
    const presetScope = `gov-http-preset-${Date.now()}`;
    registerTestScope(presetScope);
    created.push(presetScope);
    initScope(presetScope);
    const { base, close } = await startServer(null);
    try {
      // ① 越界档位 → 400 + PRESET_KIND_INVALID（不能把 event 落成预设）
      const bad = await fetch(`${base}/api/governance/lifecycle/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: presetScope, name: '跟随事件', kind: 'event' }),
      });
      assert.equal(bad.status, 400);
      const badBody = await bad.json() as { code?: string };
      assert.equal(badBody.code, 'PRESET_KIND_INVALID');

      // ② 合法档位 → 写入 body 指定的 scope
      const okRes = await fetch(`${base}/api/governance/lifecycle/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: presetScope, name: '七天内清理', kind: 'temp', ttlDays: 7 }),
      });
      assert.equal(okRes.status, 200);
      const okBody = await okRes.json() as { scope?: string; preset?: { kind?: string } };
      assert.equal(okBody.scope, presetScope);
      assert.equal(okBody.preset?.kind, 'temp');

      // ③ 该 scope 读得到它（此前读 query scope → 会写进 default 的 governance.json）
      const got = await fetch(`${base}/api/governance/lifecycle/presets?scope=${presetScope}`);
      const gotBody = await got.json() as { presets: Array<{ name: string }> };
      assert.ok(gotBody.presets.some((p) => p.name === '七天内清理'), '预设必须落在请求体指定的 scope');
    } finally {
      await close();
    }
  });
});
