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
const { getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');
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
    assert.match(loaded.warning ?? '', /未配置 sourceDir/);
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
      resolveTokenScopes: (token: string) => token === 'limited' ? ['another-scope'] : token === 'editor' ? [scope] : undefined,
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
});
