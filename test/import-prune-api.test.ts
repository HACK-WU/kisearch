/**
 * import-prune-api.test.ts —— `POST /api/import/prune` 的 handler 级契约（REQ-20261019-001）。
 *
 * 与 `import-prune.test.ts`（纯函数）/ `import-prune-e2e.test.ts`（导入链路）的分工：
 * 这里只压**HTTP 层**——鉴权、入参校验、token 失配、以及「重扫口径必须与 run 同源」。
 * 该层此前零覆盖，而 code review 的两个真缺陷（越权通配、扩展名不同源）恰在此层。
 *
 * 契约：
 *   1. 鉴权与全站一致：`['all']` 通配（全权 --token）**不得**被误判成越权；
 *   2. fail-safe：`selected` 缺失 → 400（不允许"缺省 = 全删"）；`dryRun` 是查询语义，不需要 selected；
 *   3. 入参净化与 `/api/import/run` 同口径：非法 `group` / 非 UUID 的 `uploadId` → 400；
 *   4. **同源**：`uploadId` 重扫必须用 scope 配置的 `import.extensions`，否则放宽过扩展名的
 *      scope 会把本地仍在的文件判成「已删除」；
 *   5. token 失配 → 409 `PRUNE_TOKEN_STALE`；token 正确但 `selected: []` → 200 且零删除。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/import-prune-api.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';

// ─── 测试隔离：tmp HOME（`getUploadsRoot()` = $HOME/.ki/import-uploads）──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-prune-api-'));
process.env.HOME = tmpHome;

const { handleApiRequest } = await import('../src/lib/mcp-http-api.js');
const { handleDirectImport } = await import('../src/lib/import.js');

const SCOPE = `prune-api-${Date.now().toString(36)}`;
const OTHER_SCOPE = `prune-api-other-${Date.now().toString(36)}`;
registerTestScope(SCOPE);
registerTestScope(OTHER_SCOPE);
// 模拟用户放宽扩展名白名单（docs/configuration.md:241 公开支持）——Q2 回归的前提
{
  const cfg = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
  cfg.scopes[SCOPE].import = { extensions: ['.md', '.mdx'] };
  fs.writeFileSync(testConfigPath, JSON.stringify(cfg), 'utf-8');
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-prune-api-src-'));
/** 导入源目录（生产上就是暂存目录，同一份 rel 口径） */
const sourceDir = path.join(tmpRoot, 'wiki');
const UPLOAD_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const uploadsRoot = path.join(tmpHome, '.ki', 'import-uploads');
const uploadDir = path.join(uploadsRoot, UPLOAD_ID);

const FILES = { 'a.md': '# a\n正文 A\n', 'b.md': '# b\n正文 B\n', 'x.mdx': '# x\n正文 X\n' };

function writeFiles(base: string, files: Record<string, string>): void {
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(base, rel), body);
}

before(async () => {
  // ① 真实导入：3 篇（含 .mdx）全部入库，sourcePath = a.md / b.md / x.mdx
  writeFiles(sourceDir, FILES);
  const result = await handleDirectImport({ scope: SCOPE, sourceDir, vector: false });
  assert.equal(result.stats.files.completed, 3);
  // ② 暂存目录 + 上传会话快照：group='' / pickMode='dir'（run 时写入的形状）
  writeFiles(uploadDir, FILES);
  fs.writeFileSync(path.join(uploadDir, '.scope'), SCOPE, 'utf8');
  fs.writeFileSync(path.join(uploadDir, '.upload-session.json'), JSON.stringify({
    scope: SCOPE,
    updatedAt: Date.now(),
    state: 'done',
    params: { skipDuplicates: false, pickMode: 'dir', group: '' },
  }), 'utf8');
});

after(async () => {
  try { const { closeFtsEngine } = await import('../src/lib/fts-client.js'); await closeFtsEngine(SCOPE); } catch { /* ignore */ }
  try { const { closeEngine } = await import('../src/lib/vector-client.js'); await closeEngine(); } catch { /* ignore */ }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** 直接驱动 `/api/*` 分发（`ctx` 可注入来源地址与 Token 授权集合） */
async function callPrune(
  body: Record<string, unknown>,
  ctx: { authEnabled: boolean; token?: string; clientAddr?: string; resolveTokenScopes?: () => string[] },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  let status = 0;
  let raw = '';
  const req = Readable.from([Buffer.from(payload)]) as unknown as Record<string, unknown>;
  Object.assign(req, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-bearer' },
    socket: { remoteAddress: ctx.clientAddr ?? '127.0.0.1' },
  });
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { /* noop */ },
    write(chunk: unknown) { raw += String(chunk); return true; },
    end(chunk?: unknown) { if (chunk) raw += String(chunk); },
  };
  await handleApiRequest(
    req as never,
    res as never,
    new URL('http://127.0.0.1/api/import/prune'),
    ctx as never,
  );
  return { status, body: JSON.parse(raw) as Record<string, unknown> };
}

describe('鉴权：与全站 scopeAllowed 同口径', () => {
  it("远程 + 授权 ['all']（全权 --token）→ 200（曾误判 403）", async () => {
    const { status } = await callPrune(
      { scope: SCOPE, uploadId: UPLOAD_ID, dryRun: true },
      { authEnabled: true, token: 'not-matched', clientAddr: '10.1.2.3', resolveTokenScopes: () => ['all'] },
    );
    assert.equal(status, 200);
  });

  it('远程 + 具名 scope 授权 → 200', async () => {
    const { status } = await callPrune(
      { scope: SCOPE, uploadId: UPLOAD_ID, dryRun: true },
      { authEnabled: true, token: 'not-matched', clientAddr: '10.1.2.3', resolveTokenScopes: () => [SCOPE] },
    );
    assert.equal(status, 200);
  });

  it('远程 + 其他 scope 授权 → 403', async () => {
    const { status, body } = await callPrune(
      { scope: SCOPE, uploadId: UPLOAD_ID, dryRun: true },
      { authEnabled: true, token: 'not-matched', clientAddr: '10.1.2.3', resolveTokenScopes: () => [OTHER_SCOPE] },
    );
    assert.equal(status, 403);
    assert.match(String(body.error), /Forbidden/);
  });
});

describe('fail-safe 与入参校验', () => {
  it('缺 scope → 400', async () => {
    const { status, body } = await callPrune({ uploadId: UPLOAD_ID, dryRun: true }, { authEnabled: false });
    assert.equal(status, 400);
    assert.equal(body.code, 'PRUNE_MISSING_PARAM');
  });

  it('非 dryRun 且缺 token → 400', async () => {
    const { status, body } = await callPrune({ scope: SCOPE, uploadId: UPLOAD_ID, selected: [] }, { authEnabled: false });
    assert.equal(status, 400);
    assert.equal(body.code, 'PRUNE_MISSING_PARAM');
    assert.match(String(body.error), /token/);
  });

  it('非 dryRun 且缺 selected → 400（不允许「缺省 = 全删」）', async () => {
    const { status, body } = await callPrune({ scope: SCOPE, uploadId: UPLOAD_ID, token: 'deadbeef' }, { authEnabled: false });
    assert.equal(status, 400);
    assert.match(String(body.error), /selected/);
  });

  it('dryRun 是查询语义：不带 token / selected 也可以', async () => {
    const { status, body } = await callPrune({ scope: SCOPE, uploadId: UPLOAD_ID, dryRun: true }, { authEnabled: false });
    assert.equal(status, 200);
    assert.equal(body.dryRun, true);
    assert.ok(body.plan);
  });

  it('非法 group（含 ..）→ 400（与 run / preflight 同口径）', async () => {
    // 走 scannedRels 降级通道：body.group 才是生效值（带 uploadId 时以会话快照为准，见下一条）
    const { status, body } = await callPrune(
      { scope: SCOPE, scannedRels: ['a.md'], group: '../etc', dryRun: true },
      { authEnabled: false },
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /group/);
  });

  it('group 取 run 时的会话快照：body 里的值不生效（设计 S02 N-2）', async () => {
    // 快照里 group='' —— 即使 body 传了一个合法但不同的 group，也应按快照重算
    const { status, body } = await callPrune(
      { scope: SCOPE, uploadId: UPLOAD_ID, group: 'some/other-group', dryRun: true },
      { authEnabled: false },
    );
    assert.equal(status, 200);
    const plan = (body.plan ?? {}) as { untouchedGroups?: string[] };
    // 快照 group='' → 文件落 scope 根 → 库里的组都被本次覆盖到 → 没有「未触及组」。
    // 若误用 body.group，落点会变成 some/other-group/*，库里的 SCOPE 组会被判成「本次未涉及」。
    assert.deepEqual(plan.untouchedGroups, []);
  });

  it('非 UUID 的 uploadId → 400（与 run 同口径）', async () => {
    const { status, body } = await callPrune(
      { scope: SCOPE, uploadId: '../etc', dryRun: true },
      { authEnabled: false },
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /uploadId/);
  });
});

describe('重扫口径必须与 run 同源', () => {
  it('scope 放宽扩展名（.mdx）→ 仍在本地的那批文件不得进候选', async () => {
    const { status, body } = await callPrune({ scope: SCOPE, uploadId: UPLOAD_ID, dryRun: true }, { authEnabled: false });
    assert.equal(status, 200);
    const plan = (body.plan ?? {}) as { total?: number; judicable?: number; skipReason?: string; items?: unknown[] };
    // 3 篇都在库里、也都在暂存目录 → 差集为空
    assert.equal(plan.skipReason, undefined, `不应被闸门关闭：${plan.skipReason ?? ''}`);
    assert.equal(plan.judicable, 3, '库内可判定文档应为 3 篇（含 .mdx）');
    assert.equal(plan.total, 0, `若重扫漏掉 .mdx，x.mdx 会被误判为已删除（实际 ${plan.total}）`);
    assert.deepEqual(plan.items, []);
  });

  it('删掉一篇源文件后 → 候选恰好 1 篇；token 失配 409；正确 token + selected:[] 零删除', async () => {
    fs.unlinkSync(path.join(uploadDir, 'b.md'));
    const dry = await callPrune({ scope: SCOPE, uploadId: UPLOAD_ID, dryRun: true }, { authEnabled: false });
    assert.equal(dry.status, 200);
    const plan = (dry.body.plan ?? {}) as {
      total?: number; token?: string; skipReason?: string;
      items?: { group: string; relation: string; sourcePath: string }[];
    };
    assert.equal(plan.skipReason, undefined, `不应被闸门关闭：${plan.skipReason ?? ''}`);
    assert.equal(plan.total, 1);
    assert.equal(plan.items?.[0]?.sourcePath, 'b.md');
    assert.ok(plan.token);

    // 旧 token / 错 token → 409
    const stale = await callPrune(
      { scope: SCOPE, uploadId: UPLOAD_ID, token: 'deadbeefdeadbeef', selected: [] },
      { authEnabled: false },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'PRUNE_TOKEN_STALE');

    // 正确 token 但 selected 为空数组 → 200 且零删除（不删任何东西）
    const noop = await callPrune(
      { scope: SCOPE, uploadId: UPLOAD_ID, token: plan.token, selected: [], preserveRels: [] },
      { authEnabled: false },
    );
    assert.equal(noop.status, 200);
    assert.equal(noop.body.deleted, 0);
    assert.equal(noop.body.selected, 0);

    // 原文仍在（没被删）
    assert.equal(fs.existsSync(path.join(sourceDir, 'b.md')), true);
  });
});
