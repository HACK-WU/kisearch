// S-02 单元测试：normalizeAiResults
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { normalizeAiResults } from '../src/lib/ai-results.ts';

function writeTmp(obj) {
  const file = path.join(os.tmpdir(), `ai-results-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

test('S-02: 标准首次导入格式', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp/kb', rootName: 'wiki' },
    entries: [
      { path: '部署运维/备份恢复.md', groupPath: 'wiki/部署运维', summary: 's', keywords: ['a', 'b'], enriched: true },
    ],
  });
  const result = normalizeAiResults(file);
  assert.equal(result.meta.sourceDir, '/tmp/kb');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].action, 'add', '缺失 action 应默认 add');
  assert.equal(result.entries[0].memoryId, null, '缺失 memoryId 应为 null');
  assert.equal(result.entries[0].enriched, true);
  fs.unlinkSync(file);
});

test('S-02: meta 缺失应 throw', () => {
  const file = writeTmp({ entries: [] });
  assert.throws(() => normalizeAiResults(file), /缺少 meta/);
  fs.unlinkSync(file);
});

test('S-02: meta.sourceDir 为空应 throw', () => {
  const file = writeTmp({ meta: { sourceDir: '', rootName: 'wiki' }, entries: [] });
  assert.throws(() => normalizeAiResults(file), /sourceDir 不能为空/);
  fs.unlinkSync(file);
});

test('S-02: groupPath 缺失自动从 path 推导', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [
      { path: '部署/a.md', summary: 's', keywords: [] },
      { path: 'root.md', summary: 's', keywords: [] },
    ],
  });
  const result = normalizeAiResults(file);
  assert.equal(result.entries[0].groupPath, 'wiki/部署');
  assert.equal(result.entries[1].groupPath, 'wiki', '根目录文件应等于 rootName');
  fs.unlinkSync(file);
});

test('S-02: groupPath 首段与 rootName 不一致应 throw', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [
      { path: 'a.md', groupPath: 'docs/a', summary: 's', keywords: [] },
    ],
  });
  assert.throws(() => normalizeAiResults(file), /首段.*不一致/);
  fs.unlinkSync(file);
});

test('S-02: action=delete 必须带 memoryId', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [
      { path: 'a.md', action: 'delete', summary: '', keywords: [] },
    ],
  });
  assert.throws(() => normalizeAiResults(file), /必须携带 memoryId/);
  fs.unlinkSync(file);
});

test('S-02: action=delete 带 memoryId 正常通过', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [
      { path: 'a.md', action: 'delete', memoryId: 'mem_xyz', summary: '', keywords: [] },
    ],
  });
  const result = normalizeAiResults(file);
  assert.equal(result.entries[0].action, 'delete');
  assert.equal(result.entries[0].memoryId, 'mem_xyz');
  fs.unlinkSync(file);
});

test('S-02: 非法 action 应 throw', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [{ path: 'a.md', action: 'noop', summary: '', keywords: [] }],
  });
  assert.throws(() => normalizeAiResults(file), /action 非法/);
  fs.unlinkSync(file);
});

test('S-02: keywords 去重并去空白', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [{ path: 'a.md', summary: 's', keywords: [' a ', 'b', 'a', '', 'b '] }],
  });
  const result = normalizeAiResults(file);
  assert.deepEqual(result.entries[0].keywords, ['a', 'b']);
  fs.unlinkSync(file);
});

test('S-02: 文件不存在应 throw', () => {
  assert.throws(() => normalizeAiResults('/tmp/__never_exist.json'), /不存在/);
});

test('S-02: entries 为空数组正常', () => {
  const file = writeTmp({
    meta: { sourceDir: '/tmp', rootName: 'wiki' },
    entries: [],
  });
  const result = normalizeAiResults(file);
  assert.equal(result.entries.length, 0);
  fs.unlinkSync(file);
});
