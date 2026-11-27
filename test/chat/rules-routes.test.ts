/**
 * AI 规则路由（S-03）HTTP 契约测试
 *
 * 手法与 prompt-config-routes.test.ts 一致：起真实 http server 挂 handleChatRoutes，
 * configSnapshot 指向临时 chatDir / dataDir；断言 HTTP 外壳 + 落盘副作用。
 *
 * 覆盖：列表/用量、创建/更新/删除、视图只读并集、未知库、孤儿库、meta、
 *       配额、只读能力 403。
 *
 * 运行：node scripts/run-tests.mjs test/chat/rules-routes.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 7495;
const BASE = `http://127.0.0.1:${PORT}`;

let root = '';
let chatDir = '';
let kbDir = '';
let server: Server;
let handleChatRoutes: (req: never, res: never, url: URL, ctx: unknown) => Promise<boolean>;
let ctxExtra: Record<string, unknown> = {};

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
    /* 非 JSON 保留原文 */
  }
  return { status: res.status, json, text };
}

function makeScope(name: string): void {
  const dir = path.join(kbDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relations-cache.json'), '{}', 'utf8');
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-routes-'));
  chatDir = path.join(root, 'chat');
  kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  for (const s of ['alpha', 'beta', 'quota', 'ro', 'io']) makeScope(s);

  fs.writeFileSync(path.join(root, 'config.yaml'), JSON.stringify({
    dataDir: kbDir,
    chatDir,
  }), 'utf8');
  process.env.KI_CONFIG_PATH = path.join(root, 'config.yaml');

  fs.writeFileSync(path.join(root, 'views.json'), JSON.stringify({
    version: 2,
    views: { authView: { id: 'v_rules', members: ['alpha', 'beta'], revision: 0 } },
  }), 'utf8');

  const mod = await import('../../src/lib/chat/chat-routes.js');
  handleChatRoutes = mod.handleChatRoutes as typeof handleChatRoutes;

  server = createServer((rq, rs) => {
    void (async () => {
      const url = new URL(rq.url ?? '/', BASE);
      const handled = await handleChatRoutes(rq as never, rs as never, url, {
        authScopes: null,
        configSnapshot: {
          dataDir: kbDir,
          chatDir,
          _configPath: path.join(root, 'config.yaml'),
        },
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
  delete process.env.KI_CONFIG_PATH;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AI 规则路由', () => {
  it('GET 空列表：rules=[]、usage 归零', async () => {
    const r = await api('GET', '/api/chat/rules?scope=alpha');
    assert.equal(r.status, 200);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json?.isView, false);
    assert.deepEqual(r.json?.rules, []);
    assert.deepEqual(r.json?.usage, { humanChars: 0, humanLimit: 2000, aiCount: 0, aiLimit: 20 });
  });

  it('POST → PUT → DELETE 全链路', async () => {
    const created = await api('POST', '/api/chat/rules', {
      scope: 'alpha',
      text: '查部署问题优先「部署运维」组',
      expiresAt: null,
    });
    assert.equal(created.status, 201);
    const rule = created.json?.rule as { id: string };
    assert.ok(rule.id);
    assert.equal((created.json?.rule as { expired: boolean }).expired, false);

    const listed = await api('GET', '/api/chat/rules?scope=alpha');
    assert.equal((listed.json?.rules as unknown[]).length, 1);
    assert.equal(
      (listed.json?.usage as { humanChars: number }).humanChars,
      '查部署问题优先「部署运维」组'.length,
    );

    const updated = await api('PUT', `/api/chat/rules/${rule.id}`, { text: '更新后的规则正文' });
    assert.equal(updated.status, 200);
    assert.equal((updated.json?.rule as { text: string }).text, '更新后的规则正文');

    const promoted = await api('PUT', `/api/chat/rules/${rule.id}/permanent`);
    assert.equal(promoted.status, 400);
    assert.equal(promoted.json?.code, 'RULE_NOT_AI');

    const deleted = await api('DELETE', `/api/chat/rules/${rule.id}`);
    assert.equal(deleted.status, 200);
    const empty = await api('GET', '/api/chat/rules?scope=alpha');
    assert.deepEqual(empty.json?.rules, []);
  });

  it('视图：只读并集；写视图名被拒', async () => {
    await api('POST', '/api/chat/rules', { scope: 'alpha', text: 'alpha 规则', expiresAt: null });
    await api('POST', '/api/chat/rules', { scope: 'beta', text: 'beta 规则', expiresAt: null });

    const view = await api('GET', '/api/chat/rules?scope=authView');
    assert.equal(view.status, 200);
    assert.equal(view.json?.isView, true);
    assert.deepEqual(view.json?.members, ['alpha', 'beta']);
    assert.equal(view.json?.usage, null);
    assert.equal((view.json?.rules as unknown[]).length, 2);

    const writeView = await api('POST', '/api/chat/rules', { scope: 'authView', text: 'x', expiresAt: null });
    assert.equal(writeView.status, 400);
    assert.equal(writeView.json?.code, 'RULE_SCOPE_VIEW');
  });

  it('导入导出：dryRun 预览 → 正式导入 → 幂等', async () => {
    await api('POST', '/api/chat/rules', { scope: 'io', text: '导出规则', expiresAt: null });

    const exported = await api('GET', '/api/chat/rules/export?scope=io&includeAi=1');
    assert.equal(exported.status, 200);
    const pkg = exported.json as { version: number; rules: Array<{ text: string }> };
    assert.equal(pkg.version, 1);
    assert.ok(pkg.rules.some((r) => r.text === '导出规则'));

    const body = {
      mode: 'merge',
      dryRun: true,
      package: {
        version: 1,
        rules: [{
          scope: 'io',
          text: '导入规则',
          source: 'human',
          expiresAt: null,
          createdAt: '2026-11-20T00:00:00.000Z',
        }],
      },
    };

    const dry = await api('POST', '/api/chat/rules/import', body);
    assert.equal(dry.status, 200);
    assert.equal(dry.json?.imported, 1);
    assert.equal(dry.json?.skippedDuplicate, 0);

    const apply = await api('POST', '/api/chat/rules/import', { ...body, dryRun: false });
    assert.equal(apply.status, 200);
    assert.equal(apply.json?.imported, 1);

    const again = await api('POST', '/api/chat/rules/import', { ...body, dryRun: false });
    assert.equal(again.status, 200);
    assert.equal(again.json?.imported, 0);
    assert.equal(again.json?.skippedDuplicate, 1);

    const list = await api('GET', '/api/chat/rules?scope=io');
    assert.equal((list.json?.rules as unknown[]).length, 2);
  });

  it('未知库 / 配额 / 孤儿库', async () => {
    const unknown = await api('POST', '/api/chat/rules', { scope: 'missing', text: 'x', expiresAt: null });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json?.code, 'RULE_SCOPE_UNKNOWN');

    for (let i = 0; i < 10; i += 1) {
      const r = await api('POST', '/api/chat/rules', {
        scope: 'quota',
        text: `${'规'.repeat(196)}${String(i).padStart(4, '0')}`,
        expiresAt: null,
      });
      assert.equal(r.status, 201);
    }
    const over = await api('POST', '/api/chat/rules', { scope: 'quota', text: '再多一条', expiresAt: null });
    assert.equal(over.status, 400);
    assert.equal(over.json?.code, 'RULE_SCOPE_QUOTA');

    // 孤儿：直接落盘一条 legacy 规则（库目录不存在）
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(chatDir, 'scope-rules.json'), JSON.stringify({
      version: 1,
      rules: [{
        id: 'r_orphan1', scope: 'legacy', text: '旧库规则', source: 'human',
        expiresAt: null, createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z', createdBy: 'user:1',
      }],
    }), 'utf8');

    const orphanList = await api('GET', '/api/chat/rules?scope=legacy');
    assert.equal(orphanList.status, 200);
    assert.equal((orphanList.json?.rules as unknown[]).length, 1);

    const orphans = await api('GET', '/api/chat/rules/orphans');
    assert.equal(orphans.status, 200);
    assert.deepEqual(orphans.json?.orphans, [{ scope: 'legacy', count: 1 }]);
  });

  it('GET /meta：库、视图、孤儿分组', async () => {
    const r = await api('GET', '/api/chat/rules/meta');
    assert.equal(r.status, 200);
    assert.ok((r.json?.scopes as string[]).includes('alpha'));
    assert.deepEqual((r.json?.views as Record<string, string[]>).authView, ['alpha', 'beta']);
    assert.deepEqual(r.json?.orphans, [{ scope: 'legacy', count: 1 }]);
  });

  it('只读能力：GET 可用，写 403', async () => {
    ctxExtra = { capabilities: new Set(['knowledge.read']) };
    const read = await api('GET', '/api/chat/rules?scope=ro');
    assert.equal(read.status, 200);
    const write = await api('POST', '/api/chat/rules', { scope: 'ro', text: 'x', expiresAt: null });
    assert.equal(write.status, 403);
    assert.equal(write.json?.code, 'FORBIDDEN');
    ctxExtra = {};
  });

  it('非法 body / 缺 scope', async () => {
    const noScope = await api('GET', '/api/chat/rules');
    assert.equal(noScope.status, 400);
    assert.equal(noScope.json?.code, 'RULE_SCOPE_REQUIRED');

    const badBody = await api('POST', '/api/chat/rules', { text: 'x' });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.json?.code, 'RULE_SCOPE_REQUIRED');
  });
});
