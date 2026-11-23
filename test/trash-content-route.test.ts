/**
 * trash-content-route.test.ts —— 回收站「点开看原文」的取数端点（2026-11-23）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/trash-content-route.test.ts
 *
 * 守四件事：
 *   ① `GET /governance/trash/content` 读的是**删除时的快照**（`content.md`），不是 KB 当前正文
 *      —— 文档进站时已从 KB 摘除，复用 `/api/doc/get` 只会 404；
 *   ② 组条目没有单篇正文 → 400（不能拿空 content 骗前端，也不能 500）；
 *   ③ 正文缺失的历史条目是**既定事实**，返 200 + `empty:true`，由页面解释，不当错误；
 *   ④ `dirName` 是单段目录名：`../` 一律 400（事件 #80），且 purge 不得删掉目标目录。
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
import { moveToTrash } from '../src/lib/trash-service.js';
import { getTrashRoot } from '../src/lib/trash-store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';
import type { Relation } from '../src/lib/scoring.js';

const DAY = 86_400_000;
const scope = `trash-content-route-${Date.now()}`;
const GROUP = '错误库/回收站正文';

/** 最小请求桩：`readJsonBody` 只监听 data / end / error */
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

function mkRes(): { res: ServerResponse; json: () => Record<string, unknown> } {
  const chunks: string[] = [];
  const res = {
    writeHead: () => res,
    end: (b?: string) => { if (b) chunks.push(b); },
  } as unknown as ServerResponse;
  return { res, json: () => JSON.parse(chunks[chunks.length - 1] ?? '{}') as Record<string, unknown> };
}

async function call(method: string, url: string, payload?: unknown): Promise<Record<string, unknown>> {
  const { res, json } = mkRes();
  const handled = await handleGovernanceRoutes(
    mkReq(method, payload),
    res,
    new URL(url, 'http://localhost'),
    { authScopes: null },
  );
  assert.equal(handled, true, `${method} ${url} 应被治理路由接手（false = 前缀没命中，会落到 404）`);
  return json();
}

const contentUrl = (dirName: string): string =>
  `/api/governance/trash/content?scope=${encodeURIComponent(scope)}&group=${encodeURIComponent(GROUP)}&dirName=${encodeURIComponent(dirName)}`;

function seedDoc(name: string, content: string): Relation {
  const rel: Relation = {
    id: `rel_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
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

/** 移一篇进回收站，返回条目目录名（顺序与真实链路一致：先入站、再从 KB / 分片摘除） */
function intoTrash(name: string, content: string): string {
  const rel = seedDoc(name, content);
  const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', relationSnapshot: rel });
  assert.equal(moved.ok, true, moved.ok ? '' : moved.error);
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

  return moved.item.dirName;
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① 正常读取快照正文', () => {
  it('返 200 + 原文；正文来自 content.md（KB 里已经没有这篇）', async () => {
    const body = '# 删掉的文档\n\n正文只存在于回收站';
    const dirName = intoTrash('被删的文档', body);

    // 前置事实：KB 里已无此篇 —— 这正是不能复用 /api/doc/get 的原因
    const kb = readJson<Record<string, string>>(getLocalKbDir(scope, GROUP)) ?? {};
    assert.equal('被删的文档' in kb, false, '进站后 KB 不应再有这篇（否则本测试失去意义）');

    const res = await call('GET', contentUrl(dirName));
    assert.equal(res.ok, true);
    assert.equal(res.content, body);
    assert.equal(res.empty, false);
    assert.equal(res.name, '被删的文档');
    assert.equal(res.reason, 'manual');
    assert.equal(res.dirName, dirName);
  });

  it('正文缺失的历史条目：200 + empty:true（不是错误）', async () => {
    const dirName = '残壳文档';
    const dir = path.join(getTrashRoot(scope), GROUP, dirName);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'meta.json'), {
      scope, group: GROUP, name: '残壳文档', reason: 'manual',
      deletedAt: Date.now(), expiresAt: Date.now() + DAY, ttlDays: 7,
      restoreCount: 0, dirName, hasAssets: false, sizeBytes: 0,
    } as unknown as Record<string, unknown>);

    const res = await call('GET', contentUrl(dirName));
    assert.equal(res.ok, true);
    assert.equal(res.content, '');
    assert.equal(res.empty, true);
  });
});

describe('② 组条目 / 不存在的条目', () => {
  it('组条目 → 400 TRASH_GROUP_NO_CONTENT（没有单篇正文可看）', async () => {
    const dirName = '__group__20261123';
    const dir = path.join(getTrashRoot(scope), '项目', dirName);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'meta.json'), {
      scope, group: '项目', name: '项目', reason: 'manual', kind: 'group',
      deletedAt: Date.now(), expiresAt: Date.now() + DAY, ttlDays: 7,
      restoreCount: 0, dirName, hasAssets: false, sizeBytes: 0,
    } as unknown as Record<string, unknown>);

    const res = await call('GET',
      `/api/governance/trash/content?scope=${encodeURIComponent(scope)}&group=${encodeURIComponent('项目')}&dirName=${encodeURIComponent(dirName)}`);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TRASH_GROUP_NO_CONTENT');
  });

  it('条目不存在 → 404 TRASH_NOT_FOUND', async () => {
    const res = await call('GET', contentUrl('从未存在过'));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TRASH_NOT_FOUND');
  });

  /**
   * 回归（2026-11-23 自查发现）：本函数顶部 `const path = url.pathname…` 遮蔽了 `node:path`，
   * 用 `path.isAbsolute(group)` 判绝对路径会 TypeError → 500（合法 group 也读不出正文）。
   * 这里同时钉住「合法 group 通、非法 group 400」，任何一种都别退化成 500。
   */
  it('非法 group → 400 TRASH_BAD_GROUP（不能变成 500）', async () => {
    for (const bad of ['../etc', '/etc', 'a/../b', 'a//b', 'C:\\\\x']) {
      const res = await call('GET',
        `/api/governance/trash/content?scope=${encodeURIComponent(scope)}&group=${encodeURIComponent(bad)}&dirName=x`);
      assert.equal(res.code, 'TRASH_BAD_GROUP', `group=${JSON.stringify(bad)} 应 400 而非 500`);
    }
  });
});

describe('③ dirName 路径穿越（事件 #80）', () => {
  /** 造一个"回收站外"的目录，作为穿越的受害目标 */
  function mkVictim(name: string): { dir: string; marker: string } {
    const dir = path.join(getKbDir(scope), '..', `${scope}-victim-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, 'keep.txt');
    fs.writeFileSync(marker, 'must survive', 'utf-8');
    return { dir, marker };
  }

  it('GET content：穿越型 dirName → 400，且不读外部文件', async () => {
    const { dir } = mkVictim('content');
    // 目标目录里放一个 content.md：未校验时会被读到（这正是要挡住的）
    fs.writeFileSync(path.join(dir, 'content.md'), 'leaked', 'utf-8');
    const evil = `../${scope}-victim-content`;

    const res = await call('GET', contentUrl(evil));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TRASH_BAD_DIRNAME');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('POST purge：穿越型 dirName → 400，受害目录必须完好（这是 #80 的原始破坏面）', async () => {
    const { dir, marker } = mkVictim('purge');
    const evil = `../${scope}-victim-purge`;

    const res = await call('POST', '/api/governance/trash/purge', { scope, group: GROUP, dirName: evil });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TRASH_BAD_DIRNAME');
    assert.ok(fs.existsSync(dir), '受害目录不能被删除');
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'must survive');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('POST restore：穿越型 dirName → 400，不写 KB', async () => {
    const res = await call('POST', '/api/governance/trash/restore', { scope, group: GROUP, dirName: '../../etc' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TRASH_BAD_DIRNAME');
  });

  it('含分隔符 / 空串 / .. 一律拒绝（白名单式单段判定）', async () => {
    for (const bad of ['a/b', 'a\\b', '', '..', 'x\0y']) {
      const res = await call('POST', '/api/governance/trash/purge', { scope, group: GROUP, dirName: bad });
      assert.equal(res.code, 'TRASH_BAD_DIRNAME', `dirName=${JSON.stringify(bad)} 应被拒`);
    }
  });

  /**
   * `.` 必须放行：relation 名可以是 `.`（`isUnsafeRelationName` 只拦 `/`、`\`、`..`），
   * 那时回收站条目目录名就是 `.`。拦掉它 = 这类历史条目既恢复不了也删不掉。
   * 它不会逃逸（`path.join(root, group, '.')` 只归一到 group 目录），故只返回 404/不存在。
   */
  it('`.` 是合法目录名（不逃逸），不得被判成穿越', async () => {
    // 用不存在的 group：只验「不被判成非法」，不去真删本组目录（`.` 的目录就是 group 目录）
    const res = await call('POST', '/api/governance/trash/purge', { scope, group: '不存在的组', dirName: '.' });
    assert.notEqual(res.code, 'TRASH_BAD_DIRNAME', '`.` 不是穿越，不能一刀切成非法');
    assert.equal(res.code, 'TRASH_NOT_FOUND');
  });

  /**
   * 全空格目录名同理必须放行（relation 名允许空格）：判成非法 = 那条既删不掉也恢复不了。
   * 这里只验不落到 BAD_DIRNAME（目录不存在 → 404）。
   */
  it('全空格目录名不会被判成非法（防同类死锁）', async () => {
    const res = await call('POST', '/api/governance/trash/purge', { scope, group: '不存在的组', dirName: '   ' });
    assert.notEqual(res.code, 'TRASH_BAD_DIRNAME');
    assert.equal(res.code, 'TRASH_NOT_FOUND');
  });
});
