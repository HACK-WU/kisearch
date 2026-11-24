/**
 * trash-broken-content.test.ts —— 回收站「正文缺失」判据与恢复 fail-closed（事件 #81）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/trash-broken-content.test.ts
 *
 * 背景（2026-11-23 运行时复现）：判据原来是 `sizeBytes === 0`，而 sizeBytes 是**入站瞬间**
 * 的目录字节快照（此刻还没写 meta.json）。于是：
 *   ① 入站即无正文的条目 sizeBytes=0，判据凑巧生效；
 *   ② **入站后** content.md 丢失的条目 sizeBytes 停在旧值 >0，判据失效 —— 页面无徽标、
 *      名字可点、恢复可点，diagnostics 同时漏报；
 *   ③ 恢复侧不校验空正文，绕过页面直接调接口就能写出空文档并删掉条目。
 *
 * 守五件事：
 *   ① `listTrash` 按 content.md 真实存在性给 `hasContent`，**不看 sizeBytes**；
 *   ② 正文缺失的条目恢复必须被拒（TRASH_CORRUPTED / 409），且 KB 不被写、条目不被删；
 *   ③ diagnostics 的 emptyContent 用同一判据，能把「sizeBytes 旧值 >0」的坏条目报出来；
 *   ④ 坏条目仍可彻底删除（不能产生「既恢复不了也删不掉」的死锁，对照 #74）；
 *   ⑤ 组条目没有单篇正文 → 不给 hasContent、不进 emptyContent（不产生假告警）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { writeGroupCache, loadGroupCache } from '../src/lib/group-cache.js';
import { moveToTrash, restoreFromTrash } from '../src/lib/trash-service.js';
import { listTrash, writeTrashItem, getTrashRoot, writeGroupTrashItem } from '../src/lib/trash-store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';
import { httpStatusFor } from '../src/lib/governance-errors.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `trash-broken-${Date.now()}`;
const GROUP = '错误库/回收站判据';

function mkReq(method: string, payload?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  const raw = payload === undefined ? '' : JSON.stringify(payload);
  setImmediate(() => {
    if (raw) req.emit('data', raw);
    req.emit('end');
  });
  return req;
}
function mkRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: (code: number) => { status = code; return res; },
    end: (b?: string) => { if (b) chunks.push(b); },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => JSON.parse(chunks[chunks.length - 1] ?? '{}') as Record<string, unknown> };
}
async function call(method: string, url: string, payload?: unknown) {
  const { res, status, json } = mkRes();
  const handled = await handleGovernanceRoutes(mkReq(method, payload), res, new URL(url, 'http://localhost'), { authScopes: null });
  assert.equal(handled, true, `${method} ${url} 应被治理路由接手`);
  return { status: status(), body: json() };
}

function seedDoc(name: string, content: string): Relation {
  const rel: Relation = {
    id: `rel_${name.replace(/\W/g, '')}`, text: name, score: 0, useCount: 0,
    lastUsedTime: null, isImported: false,
  };
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);
  const kbPath = getLocalKbDir(scope, GROUP);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = content;
  writeJson(kbPath, kb);
  return rel;
}

/** 真实链路入站：先快照、再从 KB / 分片摘除 */
function intoTrash(name: string, content: string): { dirName: string; sizeBytes: number } {
  const rel = seedDoc(name, content);
  const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', relationSnapshot: rel });
  assert.equal(moved.ok, true, moved.ok ? '' : `${moved.code} ${moved.error}`);
  if (!moved.ok) throw new Error('入站失败');
  const doc = loadGroupCache(scope, GROUP);
  if (doc) {
    doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
    writeGroupCache(scope, GROUP, doc);
  }
  const kbPath = getLocalKbDir(scope, GROUP);
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  delete kb[name];
  writeJson(kbPath, kb);
  return { dirName: moved.item.dirName, sizeBytes: moved.item.sizeBytes };
}

/** 事件 #81 的现场形态：入站正常，之后 content.md 不见了（sizeBytes 停在旧值 >0） */
function intoTrashThenLoseContent(name: string): { dirName: string; sizeBytes: number } {
  const item = intoTrash(name, `# ${name}\n\n入站时有正文。`);
  fs.rmSync(path.join(getTrashRoot(scope), GROUP, item.dirName, 'content.md'));
  return item;
}

const kbOf = (): Record<string, unknown> => readJson<Record<string, unknown>>(getLocalKbDir(scope, GROUP)) ?? {};
const trashDirOf = (dirName: string): string => path.join(getTrashRoot(scope), GROUP, dirName);

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① hasContent 按 content.md 真实存在性给出，不依赖 sizeBytes', () => {
  it('正文在 → true；且 sizeBytes>0', () => {
    const item = intoTrash('正常快照', '# 正常\n\n有正文');
    const listed = listTrash(scope).items.find((i) => i.dirName === item.dirName);
    assert.equal(listed?.hasContent, true);
    assert.ok((listed?.sizeBytes ?? 0) > 0);
  });

  it('入站后正文丢失（sizeBytes 旧值 >0）→ false ← 事件 #81 的核心形态', () => {
    const item = intoTrashThenLoseContent('正文丢失');
    const listed = listTrash(scope).items.find((i) => i.dirName === item.dirName);
    assert.ok((listed?.sizeBytes ?? 0) > 0, '前置事实：sizeBytes 必须仍是入站旧值 >0，否则用例失去意义');
    assert.equal(listed?.hasContent, false, '判据必须看正文，不能看 sizeBytes');
    // 旧判据在这里会漏（这条断言是这个 bug 的"证词"）
    assert.equal(listed?.sizeBytes === 0, false, '旧判据 sizeBytes===0 对这条不成立');
  });

  it('入站即无正文（writeTrashItem content=\'\'）→ false，且 sizeBytes 恰为 0', () => {
    const item = writeTrashItem({
      scope, group: GROUP, relation: '空快照', reason: 'manual', now: Date.now(), content: '', keepDays: 7,
    });
    const listed = listTrash(scope).items.find((i) => i.dirName === item.dirName);
    assert.equal(listed?.hasContent, false);
    assert.equal(listed?.sizeBytes, 0, 'sizeBytes 在写 meta.json 之前算 → 空正文条目为 0（原事件判断被此断言钉住）');
  });

  it('content.md 只有空白 → false（口径与入站 `!content.trim()` 一致）', () => {
    const item = writeTrashItem({
      scope, group: GROUP, relation: '空白正文', reason: 'manual', now: Date.now(), content: '   \n\n\t', keepDays: 7,
    });
    const listed = listTrash(scope).items.find((i) => i.dirName === item.dirName);
    assert.equal(listed?.hasContent, false, '纯空白写回 KB 等于空文档，必须与空正文同判');
  });

  it('probeContent:false 时不读 content.md（到期清理 / 体积统计用）', () => {
    const listed = listTrash(scope, { probeContent: false }).items;
    assert.ok(listed.length > 0);
    assert.ok(listed.every((i) => i.hasContent === undefined), '不探正文时不得给 hasContent');
  });

  /**
   * 探测只读头部 4KB（性能），所以必须钉住两条边界：
   * 头部全空白但后面有正文 → true（不能因为只看头部就判坏）
   * 头部与整体都只有空白 → false（回退整篇复查后仍要判坏）
   */
  it('4KB 头部全是空白、后面才有正文 → true（头部截断不能误判）', () => {
    const item = writeTrashItem({
      scope, group: GROUP, relation: '前置空白长文', reason: 'manual', now: Date.now(),
      content: `${' '.repeat(5000)}正文在 4KB 之后`, keepDays: 7,
    });
    const listed = listTrash(scope).items.find((i) => i.dirName === item.dirName);
    assert.equal(listed?.hasContent, true);
  });

  it('整体只有空白且超过 4KB → false（回退整篇复查仍判坏）', () => {
    const item = writeTrashItem({
      scope, group: GROUP, relation: '超长空白', reason: 'manual', now: Date.now(),
      content: ' '.repeat(6000), keepDays: 7,
    });
    const listed = listTrash(scope).items.find((i) => i.dirName === item.dirName);
    assert.equal(listed?.hasContent, false);
  });
});

describe('② 恢复 fail-closed：坏条目拒绝写空文档，且条目不被删', () => {
  it('restoreFromTrash 返回 TRASH_CORRUPTED，KB 不变、条目仍在', () => {
    const item = intoTrashThenLoseContent('拒绝恢复');
    const before = kbOf();

    const out = restoreFromTrash({ scope, group: GROUP, dirName: item.dirName });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.code, 'TRASH_CORRUPTED');
    assert.match(out.error, /没有正文/);

    assert.deepEqual(kbOf(), before, 'KB 一个字节都不能写');
    assert.ok(fs.existsSync(trashDirOf(item.dirName)), '条目必须留在回收站，用户还能彻底删除');
  });

  it('正常条目照旧可恢复（守卫不误伤）', () => {
    const item = intoTrash('可恢复文档', '# 可恢复\n\n正文在');
    const out = restoreFromTrash({ scope, group: GROUP, dirName: item.dirName });
    assert.equal(out.ok, true, out.ok ? '' : out.error);
    assert.match(String(kbOf()['可恢复文档'] ?? ''), /正文在/);
  });

  it('HTTP：正文缺失 → 409 + TRASH_CORRUPTED（不是 400/500）', async () => {
    const item = intoTrashThenLoseContent('HTTP拒绝');
    const res = await call('POST', '/api/governance/trash/restore', { scope, group: GROUP, dirName: item.dirName });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'TRASH_CORRUPTED');
    assert.equal(res.status, 409, '数据状态冲突是 409；未登记码会退化成 400，让用户以为参数错了');
    assert.equal(httpStatusFor('TRASH_CORRUPTED'), 409, '码表必须有该码，否则上一条断言迟早回退');
  });
});

describe('③ diagnostics 用同一判据，能报出 sizeBytes 旧值 >0 的坏条目', () => {
  it('单库：emptyContent 含坏条目、不含组条目', async () => {
    const stale = intoTrashThenLoseContent('诊断漏报');
    // 组条目：组内没有一篇有正文（残壳），但组条目本身不该被当成坏条目
    writeGroupTrashItem({
      scope, group: '验证/空组', reason: 'manual', now: Date.now(),
      groups: ['验证/空组'], docs: [], assets: [], keepDays: 7,
    });

    const res = await call('GET', `/api/governance/diagnostics?scope=${encodeURIComponent(scope)}`);
    assert.equal(res.status, 200);
    const trash = res.body.trash as { emptyContent: Array<{ name: string }>; total: number };
    const names = trash.emptyContent.map((e) => e.name);
    assert.ok(names.includes('诊断漏报'), 'sizeBytes 旧值 >0 的坏条目必须被报出（原判据在这里漏报）');
    assert.ok(!names.includes('验证/空组'), '空组快照本来就没有单篇正文，不得报假告警');
    assert.ok(trash.total >= 1);
  });

  it('列表接口下发 hasContent（前端据此判 broken）', async () => {
    const res = await call('GET', `/api/governance/trash?scope=${encodeURIComponent(scope)}`);
    assert.equal(res.status, 200);
    const items = res.body.items as Array<Record<string, unknown>>;
    const docs = items.filter((i) => i.kind === 'doc');
    assert.ok(docs.length > 0);
    for (const doc of docs) {
      assert.equal(typeof doc.hasContent, 'boolean', `doc 条目必须带 hasContent：${JSON.stringify(doc.name)}`);
    }
    const group = items.find((i) => i.kind === 'group');
    assert.ok(group, '本用例应有一条组条目');
    assert.equal('hasContent' in (group as object), false, '组条目不下发 hasContent');
  });
});

describe('④ 坏条目仍可彻底删除（不留「既恢复不了也删不掉」的死锁）', () => {
  it('purge 成功，目录消失', async () => {
    const item = intoTrashThenLoseContent('待彻底删除');
    const res = await call('POST', '/api/governance/trash/purge', { scope, group: GROUP, dirName: item.dirName });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(fs.existsSync(trashDirOf(item.dirName)), false);
    assert.equal(listTrash(scope).items.some((i) => i.name === '待彻底删除'), false);
  });
});
