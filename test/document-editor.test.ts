import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// 按项目约定，验证产物仅创建在 workspace/temp，不主动清理。
const fixture = path.join(process.cwd(), 'temp', `document-editor-${Date.now()}`);
fs.mkdirSync(fixture, { recursive: true });
const scope = 'editor-test';
const configPath = path.join(fixture, 'config.json');
const dataDir = path.join(fixture, 'kb');
const vectorDir = path.join(fixture, 'vector');
const sourceDir = path.join(fixture, 'source');
fs.writeFileSync(configPath, JSON.stringify({ dataDir, vectorDir, scopeMode: 'default', scopes: { [scope]: {} } }));
process.env.KI_CONFIG_PATH = configPath;

const { resetConfigCache } = await import('../src/lib/config.js');
const { initScope, readJson, writeJson } = await import('../src/lib/store.js');
const { getRelationsCachePath, getLocalKbDir, getGroupIndexPath } = await import('../src/lib/scope.js');
const { contentRevision } = await import('../src/lib/relation-edit-draft.js');
const { readDocumentForEdit, saveDocumentEdit } = await import('../src/lib/document-editor.js');
const { closeFtsEngine } = await import('../src/lib/fts-client.js');
const { closeEngine } = await import('../src/lib/vector-client.js');
after(async () => { await closeFtsEngine(scope); await closeEngine(scope); });
resetConfigCache();
initScope(scope);

const group = 'guide';
const relation = 'intro';
const identity = { scope, group, relation };
const original = '# Intro\n\n正文';
const cachePath = getRelationsCachePath(scope);
const cache = readJson<any>(cachePath)!;
cache.groups[group] = {
  hot_relations: [{ id: 'rel_editor', text: relation, score: 0, useCount: 0, lastUsedTime: null, sourcePath: 'guide/intro.md' }],
  keywords: [],
};
writeJson(cachePath, cache);
const kbPath = getLocalKbDir(scope, group);
fs.mkdirSync(path.dirname(kbPath), { recursive: true });
writeJson(kbPath, { [relation]: original });

describe('document editor', () => {
  it('saves without sourceDir, warns, and writes external link changes to FTS by default', async () => {
    const loaded = readDocumentForEdit(identity);
    assert.equal(loaded.sourceConfigured, false);
    assert.match(loaded.warning ?? '', /未开启 wiki 回写/);
    const next = '# Intro\n\n[正文](https://example.com)';
    const saved = await saveDocumentEdit({ ...identity, content: next, expectedRevision: loaded.revision });
    assert.equal(saved.fullTextUpdated, true);
    assert.equal(saved.indexedAs, 'fts');
    assert.equal(saved.sourceWritten, false);
    assert.equal(readJson<Record<string, string>>(kbPath)?.[relation], next);
    assert.equal(fs.existsSync(path.join(sourceDir, 'guide', 'intro.md')), false);
  });

  it('updates FTS for a normal edit, then writes the configured and matching source file', async () => {
    const loaded = readDocumentForEdit(identity);
    const next = `${loaded.content}\n\n新段落`;
    const first = await saveDocumentEdit({ ...identity, content: next, expectedRevision: loaded.revision });
    assert.equal(first.fullTextUpdated, true);
    const updated = readJson<any>(cachePath)!.groups[group].hot_relations.find((item: any) => item.text === relation);
    assert.equal(updated.ftsIndexComplete, true);

    const sourceFile = path.join(sourceDir, 'guide', 'intro.md');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, next);
    fs.chmodSync(sourceFile, 0o600);
    fs.writeFileSync(configPath, JSON.stringify({ dataDir, vectorDir, scopeMode: 'default', scopes: { [scope]: { wikiSync: { enabled: true, sourceDir } } } }));
    resetConfigCache();
    const withSource = readDocumentForEdit(identity);
    assert.equal(withSource.sourceConfigured, true);
    assert.equal(withSource.sourceError, undefined);
    const external = `${next}\n\n[参考](https://example.org)`;
    const saved = await saveDocumentEdit({ ...identity, content: external, expectedRevision: withSource.revision, expectedSourceRevision: withSource.sourceRevision });
    assert.equal(saved.sourceWritten, true);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), external);
    assert.equal(fs.statSync(sourceFile).mode & 0o777, 0o600);
    assert.equal(readJson<Record<string, string>>(kbPath)?.[relation], external);
  });

  it('rejects stale revisions and a configured source file with a mismatched name', async () => {
    const loaded = readDocumentForEdit(identity);
    await assert.rejects(
      saveDocumentEdit({ ...identity, content: `${loaded.content}\nX`, expectedRevision: contentRevision('old'), expectedSourceRevision: loaded.sourceRevision }),
      (error: any) => error.code === 'DOC_EDIT_CONFLICT',
    );
    const badCache = readJson<any>(cachePath)!;
    badCache.groups[group].hot_relations[0].sourcePath = 'guide/other.md';
    writeJson(cachePath, badCache);
    const bad = readDocumentForEdit(identity);
    assert.match(bad.sourceError ?? '', /文件名.*不一致/);
    await assert.rejects(
      saveDocumentEdit({ ...identity, content: `${loaded.content}\nX`, expectedRevision: loaded.revision, expectedSourceRevision: loaded.sourceRevision }),
      (error: any) => error.code === 'SOURCE_MISMATCH',
    );
  });

  it('checks scope authorization on both read and write HTTP endpoints', async () => {
    const validCache = readJson<any>(cachePath)!;
    validCache.groups[group].hot_relations[0].sourcePath = 'guide/intro.md';
    writeJson(cachePath, validCache);
    const { createMcpHttpServer } = await import('../src/lib/mcp-http.js');
    const { httpServer, closeAllSessions } = createMcpHttpServer({
      authEnabled: true,
      token: 'admin-only',
      resolveClientAddr: () => '192.0.2.10',
      resolveTokenAuth: (token: string) => token === 'limited'
        ? { scopes: ['another-scope'], readOnly: false }
        : token === 'editor' ? { scopes: [scope], readOnly: false } : undefined,
      buildServer: () => new McpServer({ name: 'editor-test', version: '0' }),
      webDir: null,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/doc/edit`;
    try {
      const query = new URLSearchParams(identity);
      assert.equal((await fetch(`${url}?${query}`)).status, 401);
      assert.equal((await fetch(`${url}?${query}`, { headers: { Authorization: 'Bearer limited' } })).status, 403);
      assert.equal((await fetch(`${url}?${query}`, { headers: { Authorization: 'Bearer editor' } })).status, 200);
      const denied = await fetch(url, {
        method: 'POST', headers: { Authorization: 'Bearer limited', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, content: 'bad', expectedRevision: 'x' }),
      });
      assert.equal(denied.status, 403);
      const current = readDocumentForEdit(identity);
      const changed = current.content.replace('https://example.org', 'https://example.net');
      const accepted = await fetch(url, {
        method: 'POST', headers: { Authorization: 'Bearer editor', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, content: changed, expectedRevision: current.revision, expectedSourceRevision: current.sourceRevision }),
      });
      assert.equal(accepted.status, 200, await accepted.text());
      assert.equal((await (await fetch(`${url}?${query}`, { headers: { Authorization: 'Bearer editor' } })).json()).content, changed);
    } finally {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('强制覆盖：分叉时用 KB 正文覆盖源文件，保留权限，覆盖后不再分叉', async () => {
    const sourceFile = path.join(sourceDir, 'guide', 'intro.md');
    // 造分叉：磁盘上的源文件被手工改过
    fs.writeFileSync(sourceFile, '# 磁盘上的旧版本\n\n手工改过');
    fs.chmodSync(sourceFile, 0o640);
    const diverged = readDocumentForEdit(identity);
    assert.equal(diverged.sourceErrorCode, 'CONTENT_DIVERGED');
    assert.equal(diverged.sourceFile, fs.realpathSync(sourceFile));
    assert.match(diverged.sourceError ?? '', /不一致/);

    // 不强制 → 仍是既有的 SOURCE_CONFLICT（默认行为不变）
    await assert.rejects(
      saveDocumentEdit({
        ...identity, content: `${diverged.content}\n\nKB 侧新增`,
        expectedRevision: diverged.revision, expectedSourceRevision: diverged.sourceRevision,
      }),
      (error: any) => error.code === 'SOURCE_CONFLICT',
    );

    // 强制 → 成功，源文件被 KB 正文覆盖
    const next = `${diverged.content}\n\n强制覆盖`;
    const forced = await saveDocumentEdit({
      ...identity, content: next,
      expectedRevision: diverged.revision, expectedSourceRevision: diverged.sourceRevision, force: true,
    });
    assert.equal(forced.forced, true);
    assert.equal(forced.sourceWritten, true);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), next);
    assert.equal(fs.statSync(sourceFile).mode & 0o777, 0o640, '源文件权限必须保留');
    assert.equal(readJson<Record<string, string>>(kbPath)?.[relation], next);
    assert.equal(readDocumentForEdit(identity).sourceError, undefined, '覆盖后应回到一致');
  });

  it('强制覆盖：加载后源文件再次变化也照样覆盖（2026-11-12 用户拍板）', async () => {
    const sourceFile = path.join(sourceDir, 'guide', 'intro.md');
    const current = readDocumentForEdit(identity);
    // 拿到 sourceRevision 之后，源文件又被别人写了一次
    fs.writeFileSync(sourceFile, '# 加载之后别人又写了一次');
    const next = `${current.content}\n\n强制覆盖 2`;
    const forced = await saveDocumentEdit({
      ...identity, content: next,
      expectedRevision: current.revision, expectedSourceRevision: current.sourceRevision, force: true,
    });
    assert.equal(forced.forced, true);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), next);
  });

  it('强制覆盖不能绕过源文件定位错误（SOURCE_MISMATCH）', async () => {
    const badCache = readJson<any>(cachePath)!;
    badCache.groups[group].hot_relations[0].sourcePath = 'guide/other.md';
    writeJson(cachePath, badCache);
    try {
      const bad = readDocumentForEdit(identity);
      assert.equal(bad.sourceErrorCode, 'SOURCE_MISMATCH');
      assert.match(bad.sourceError ?? '', /文件名.*不一致/);
      await assert.rejects(
        saveDocumentEdit({ ...identity, content: `${bad.content}\nX`, expectedRevision: bad.revision, force: true }),
        (error: any) => error.code === 'SOURCE_MISMATCH',
      );
    } finally {
      const restore = readJson<any>(cachePath)!;
      restore.groups[group].hot_relations[0].sourcePath = 'guide/intro.md';
      writeJson(cachePath, restore);
    }
  });

  it('强制覆盖不绕过 KB 侧乐观锁', async () => {
    const current = readDocumentForEdit(identity);
    await assert.rejects(
      saveDocumentEdit({ ...identity, content: `${current.content}\nKB 冲突`, expectedRevision: 'stale-revision', force: true }),
      (error: any) => error.code === 'DOC_EDIT_CONFLICT',
    );
  });

  it('强制覆盖时源文件已不可读仍 fail-loud，且不新建文件', async () => {
    const sourceFile = path.join(sourceDir, 'guide', 'intro.md');
    const current = readDocumentForEdit(identity);
    fs.rmSync(sourceFile);
    try {
      await assert.rejects(
        saveDocumentEdit({ ...identity, content: `${current.content}\nX`, expectedRevision: current.revision, force: true }),
        (error: any) => error.code === 'SOURCE_UNAVAILABLE',
      );
      assert.equal(fs.existsSync(sourceFile), false, '不得因强制保存凭空重建源文件');
    } finally {
      fs.writeFileSync(sourceFile, current.content);
    }
  });

  it('写回目标只认 wikiSync.sourceDir，忽略 group-index 的 source 块（2026-11-12 修）', async () => {
    // 造「source 块指向另一棵目录」的历史数据：上传导入时它是 import-uploads 副本
    const legacyDir = path.join(fixture, 'legacy-uploads');
    fs.mkdirSync(path.join(legacyDir, 'guide'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'guide', 'intro.md'), '# 副本旧内容\n\n不该被改');
    const groupIndexPath = getGroupIndexPath(scope);
    const raw = fs.existsSync(groupIndexPath) ? JSON.parse(fs.readFileSync(groupIndexPath, 'utf8')) : {};
    fs.mkdirSync(path.dirname(groupIndexPath), { recursive: true });
    fs.writeFileSync(groupIndexPath, JSON.stringify({
      ...raw, version: 1, scope, groups: raw.groups ?? {},
      source: { dir: legacyDir, chunkSize: 1000, chunkOverlap: 150 },
    }));

    try {
      const loaded = readDocumentForEdit(identity);
      // 仍以 wikiSync.sourceDir 下的文件为准：一致则无 sourceError
      assert.equal(loaded.sourceConfigured, true);
      assert.equal(loaded.sourceError, undefined, '不得因为 source 块指向别的目录就判定分叉');

      const next = `${loaded.content}\n\n只写 wikiSync 目标`;
      await saveDocumentEdit({
        ...identity, content: next,
        expectedRevision: loaded.revision, expectedSourceRevision: loaded.sourceRevision,
      });
      assert.equal(fs.readFileSync(path.join(sourceDir, 'guide', 'intro.md'), 'utf8'), next, '应写入 wikiSync.sourceDir');
      assert.equal(
        fs.readFileSync(path.join(legacyDir, 'guide', 'intro.md'), 'utf8'),
        '# 副本旧内容\n\n不该被改',
        'source 块指向的目录一个字节都不该动',
      );
    } finally {
      const after = JSON.parse(fs.readFileSync(groupIndexPath, 'utf8'));
      delete after.source;
      fs.writeFileSync(groupIndexPath, JSON.stringify(after));
    }
  });

  it('分叉时回传数据源信息（供「以源为准」提示；未登记则不回传）', async () => {
    const sourceFile = path.join(sourceDir, 'guide', 'intro.md');
    const dsPath = path.join(dataDir, scope, 'datasource.json');
    fs.writeFileSync(sourceFile, '# 分叉版本\n\n手工改过');
    try {
      const without = readDocumentForEdit(identity);
      assert.equal(without.sourceErrorCode, 'CONTENT_DIVERGED');
      assert.equal(without.dataSource, undefined, '未登记数据源时不得回传');

      fs.writeFileSync(dsPath, JSON.stringify({
        version: 3, scope, type: 'git', dir: '/tmp/repo/x',
        git: { remoteUrl: 'https://example.com/wiki.git' },
      }));
      assert.deepEqual(readDocumentForEdit(identity).dataSource,
        { type: 'git', target: 'https://example.com/wiki.git' });
    } finally {
      fs.rmSync(dsPath, { force: true });
      fs.writeFileSync(sourceFile, readJson<Record<string, string>>(kbPath)![relation]);
    }
  });
});
