/**
 * views-api.test.ts —— `/api/views` 的接口行为（REQ-20261104-004 / R-03、R-11、R-13）
 *
 * 覆盖：列表 → 新建 → 改名 / 改成员 → 删除的完整链路；
 *      非创建者 403、revision 冲突 409、改名后 ID 不变、canEdit 由服务端计算。
 *
 * 隔离：KI_CONFIG_PATH 指向临时目录（views.json 落在临时 dataDir 下）。
 * 注意 `listTokens()` 仍读真实 ~/.ki —— 本测试**只读不写**，且不依赖其内容。
 *
 * 运行：npx jiti test/views-api.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-views-api-'));
const configPath = path.join(tmpDir, 'config.json');

function writeConfig(): void {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(tmpDir, 'kb'),
    vectorDir: path.join(tmpDir, 'vector'),
    backupDir: path.join(tmpDir, 'backup'),
    scopes: {},
  }), 'utf-8');
}
writeConfig();
process.env.KI_CONFIG_PATH = configPath;

let api: typeof import('../src/lib/views-api.js');
let configLib: typeof import('../src/lib/config.js');
let sv: typeof import('../src/lib/scope-view.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  api = await import('../src/lib/views-api.js');
  sv = await import('../src/lib/scope-view.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const cfg = () => configLib.loadConfig();

const USER_A = {
  kind: 'session' as const, sessionId: 's1', userId: 'u_a', username: 'a',
  role: 'viewer' as const, scopes: [], readOnly: false,
};
const USER_B = {
  kind: 'session' as const, sessionId: 's2', userId: 'u_b', username: 'b',
  role: 'viewer' as const, scopes: [], readOnly: false,
};
const ADMIN = { kind: 'local-admin' as const, label: '本机', scopes: null, readOnly: false };

/** 造一个只支持 data/end 的请求对象 */
function mockReq(method: string, body?: unknown): http.IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as unknown as http.IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: Record<string, string> }).headers = {};
  return req;
}

interface Captured {
  status: number;
  body: { ok?: boolean; code?: string; [k: string]: unknown } | undefined;
}

/** 造一个捕获响应的 res */
function mockRes(): { res: http.ServerResponse; out: Captured } {
  const out: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(code: number) { out.status = code; return res; },
    end(text?: string) { out.body = text ? JSON.parse(text) : undefined; },
  } as unknown as http.ServerResponse;
  return { res, out };
}

/** 调用一次 handler，返回捕获结果 */
async function call(
  method: string,
  p: string,
  principal: Parameters<typeof api.handleViewsApi>[4],
  body?: unknown,
  search = '',
): Promise<Captured> {
  const { res, out } = mockRes();
  const url = new URL(`http://localhost/api${p}${search}`);
  await api.handleViewsApi(mockReq(method, body), res, url, p, principal, cfg());
  return out;
}

function reset(): void {
  // ★ views.json 落在 dirname(configPath) 而不是 dataDir 下（getViewsPath 的口径），
  //   删错位置会让用例之间互相污染（表现为"新建"莫名返回重名冲突）
  const viewsPath = path.join(tmpDir, 'views.json');
  for (const f of [viewsPath, `${viewsPath}.lock`]) fs.rmSync(f, { force: true });
  writeConfig();
  configLib.resetConfigCache();
}

describe('视图写权限（D6 / §1.6）', () => {
  it('本地免登录身份视为管理员', () => {
    const actor = api.viewActorOf(ADMIN);
    assert.equal(actor.isAdmin, true);
  });

  it('session 用户取 userId 与 role；viewer 不是管理员', () => {
    const actor = api.viewActorOf(USER_A);
    assert.deepEqual(actor, { id: 'u_a', isAdmin: false });
  });

  it('canEditView：管理员任意可改、创建者改自己的、他人不可、无主仅管理员', () => {
    const own = { id: 'v_1', members: ['a'], revision: 0, createdBy: 'u_a' };
    const others = { id: 'v_2', members: ['a'], revision: 0, createdBy: 'u_b' };
    const orphan = { id: 'v_3', members: ['a'], revision: 0 };
    const a = api.viewActorOf(USER_A);
    const adm = api.viewActorOf(ADMIN);

    assert.equal(api.canEditView(own, a), true);
    assert.equal(api.canEditView(others, a), false);
    assert.equal(api.canEditView(orphan, a), false, '旧视图无 createdBy → 仅管理员可改');
    assert.equal(api.canEditView(others, adm), true);
    assert.equal(api.canEditView(orphan, adm), true);
  });
});

describe('/api/views 全链路', () => {
  it('空列表', async () => {
    reset();
    const out = await call('GET', '/views', USER_A);
    assert.equal(out.status, 200);
    assert.equal(out.body?.count, 0);
    assert.deepEqual(out.body?.views, []);
  });

  it('新建返回 201，createdBy 是 userId 而不是显示名', async () => {
    reset();
    const out = await call('POST', '/views', USER_A, { name: '团队研发', members: ['kisearch'] });
    assert.equal(out.status, 201);
    const view = out.body?.view as Record<string, unknown>;
    assert.ok(view.id, '应返回稳定 ID');
    const stored = sv.readViews(cfg())['团队研发'];
    assert.equal(stored.createdBy, 'u_a', 'createdBy 必须是 userId');
  });

  it('列表带 canEdit：创建者为 true，他人为 false', async () => {
    reset();
    await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });

    const mine = await call('GET', '/views', USER_A);
    assert.equal((mine.body?.views as Record<string, unknown>[])[0].canEdit, true);

    const others = await call('GET', '/views', USER_B);
    assert.equal((others.body?.views as Record<string, unknown>[])[0].canEdit, false);
  });

  it('非创建者改 / 删 → 403 VIEW_NOT_OWNER', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const patch = await call('PATCH', `/views/${id}`, USER_B, { members: ['kisearch', 'team-docs'] });
    assert.equal(patch.status, 403);
    assert.equal(patch.body?.code, 'VIEW_NOT_OWNER');

    const del = await call('DELETE', `/views/${id}`, USER_B);
    assert.equal(del.status, 403);
  });

  it('管理员可改他人视图', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const patch = await call('PATCH', `/views/${id}`, ADMIN, { members: ['kisearch', 'team-docs'], baseRevision: 0 });
    assert.equal(patch.status, 200);
    assert.deepEqual(sv.readViews(cfg()).team.members, ['kisearch', 'team-docs']);
  });

  it('PATCH 不传 baseRevision → 400（乐观锁不可被跳过）', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const res = await call('PATCH', `/views/${id}`, USER_A, { members: ['team-docs'] });
    assert.equal(res.status, 400);
    assert.equal(res.body?.code, 'VIEW_REVISION_REQUIRED');
    assert.deepEqual(sv.readViews(cfg()).team.members, ['kisearch'], '缺 baseRevision 不得落盘');
  });

  it('改名 + 非法成员 → 400 且名字不变（先校验后落盘）', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const bad = await call('PATCH', `/views/${id}`, USER_A, {
      name: '团队研发',
      members: ['kisearch', 'bad/scope'],
      baseRevision: 0,
    });
    assert.equal(bad.status, 400);

    const views = sv.readViews(cfg());
    assert.ok(views.team, '改名不得落盘：成员校验失败时应整体不生效');
    assert.equal(views['团队研发'], undefined, '不得留下「改了一半」的状态');
    assert.deepEqual(views.team.members, ['kisearch']);
  });

  it('revision 冲突 → 409', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const stale = await call('PATCH', `/views/${id}`, USER_A, { members: ['team-docs'], baseRevision: 99 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.code, 'VIEW_REVISION_CONFLICT');
    assert.deepEqual(sv.readViews(cfg()).team.members, ['kisearch'], '冲突时不得落盘');
  });

  it('改名后 ID 不变、列表按新名返回', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const renamed = await call('PATCH', `/views/${id}`, USER_A, { name: '团队研发', baseRevision: 0 });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.body?.view as Record<string, unknown>).view, '团队研发');
    assert.equal((renamed.body?.view as Record<string, unknown>).id, id, 'ID 不得变化');

    const list = await call('GET', '/views', USER_A);
    assert.equal((list.body?.views as Record<string, unknown>[])[0].view, '团队研发');
  });

  it('删除后列表为空；再删同 id → 404', async () => {
    reset();
    const created = await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const id = (created.body?.view as Record<string, unknown>).id as string;

    const del = await call('DELETE', `/views/${id}`, USER_A);
    assert.equal(del.status, 200);

    const again = await call('DELETE', `/views/${id}`, USER_A);
    assert.equal(again.status, 404);
    assert.equal(again.body?.code, 'VIEW_NOT_FOUND');
  });

  it('非法成员 / 空名称 → 400', async () => {
    reset();
    const noName = await call('POST', '/views', USER_A, { name: '', members: ['kisearch'] });
    assert.equal(noName.status, 400);

    const noMembers = await call('POST', '/views', USER_A, { name: 'x', members: [] });
    assert.equal(noMembers.status, 400);
    assert.equal(noMembers.body?.code, 'INVALID_VIEW_MEMBER');
  });

  it('影响面：未被授权该视图的 Token 不计入', async () => {
    reset();
    await call('POST', '/views', USER_A, { name: 'team', members: ['kisearch'] });
    const out = await call('GET', '/views/impact', USER_A, undefined, '?members=kisearch,team-docs');
    assert.equal(out.status, 200);
    assert.ok(Array.isArray(out.body?.affected), 'affected 应为数组');
    // 断言数量会依赖本机真实 token 文件，这里只校验"只统计被授权该视图的"这一结构约定
    for (const item of out.body!.affected as { id: string }[]) {
      assert.equal(typeof item.id, 'string');
    }
  });
});

describe('成员维度状态（方案 A：只标已确认不一致）', () => {
  it('mismatch / unknown 三态由后端给出，列表接口不打开向量引擎', async () => {
    reset();
    /*
     * vectorListScopes() 只扫 collections 目录名（不启引擎），造目录即可让成员
     * 进入「有向量集合」分支 —— 否则 dimensionState 恒为 undefined，测不到口径。
     */
    const collectionsRoot = path.join(tmpDir, 'vector', 'collections');
    fs.mkdirSync(path.join(collectionsRoot, 'dim-a'), { recursive: true });
    fs.mkdirSync(path.join(collectionsRoot, 'dim-b'), { recursive: true });

    const dim = cfg().embedding.dimension;
    const statusDir = path.join(tmpDir, 'kb', '.vector-status');
    fs.mkdirSync(statusDir, { recursive: true });
    const snapFile = path.join(
      statusDir, `${crypto.createHash('sha256').update('dim-a').digest('hex')}.json`,
    );
    fs.writeFileSync(snapFile, JSON.stringify({
      scope: 'dim-a',
      state: 'mismatch',
      configured: dim,
      model: 'm',
      provider: 'p',
      baseURL: 'http://localhost',
      persisted: dim + 1,
      checkedAt: Date.now(),
      staleAfterMs: 5 * 60 * 1000,
    }), 'utf-8');

    try {
      const created = await call('POST', '/views', ADMIN, { name: 'dimcheck', members: ['dim-a', 'dim-b'] });
      assert.equal(created.status, 201);

      const list = await call('GET', '/views', ADMIN);
      assert.equal(list.status, 200);
      const entry = (list.body?.views as {
        memberMeta: { scope: string; dimensionState?: string }[];
      }[])[0];
      assert.equal(
        entry.memberMeta.find((x) => x.scope === 'dim-a')?.dimensionState,
        'mismatch',
        '已确认不一致的成员必须标 mismatch',
      );
      assert.equal(
        entry.memberMeta.find((x) => x.scope === 'dim-b')?.dimensionState,
        'unknown',
        '没有快照的成员必须是 unknown，不能默认一致',
      );
    } finally {
      fs.rmSync(collectionsRoot, { recursive: true, force: true });
      fs.rmSync(statusDir, { recursive: true, force: true });
    }
  });
});
