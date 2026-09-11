/** 阶段 2：旧单 Collection 迁移规划纯函数测试。 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupLegacyDocuments, migrateLegacyVectorLayout, type LegacyVectorDoc } from '../src/lib/vector-migrate.js';
import { resetConfigCache } from '../src/lib/config.js';

function doc(id: string, scope: string): LegacyVectorDoc {
  return { id, text: `text-${id}`, vector: [0.1, 0.2], fields: { scope } };
}

describe('阶段 2 · vector migration', () => {
  it('按 legacy 文档的 scope 字段分组，保持 doc id/向量', () => {
    const grouped = groupLegacyDocuments([doc('a', 'scope-a'), doc('b', 'scope-b'), doc('c', 'scope-a')]);
    assert.deepEqual([...grouped.keys()], ['scope-a', 'scope-b']);
    assert.deepEqual(grouped.get('scope-a')?.map((x) => x.id), ['a', 'c']);
    assert.deepEqual(grouped.get('scope-a')?.[0].vector, [0.1, 0.2]);
  });

  it('缺少 scope 时 fail-loud，不把文档猜测归入 default', () => {
    assert.throws(
      () => groupLegacyDocuments([{ id: 'orphan', text: 'x', vector: [0.1], fields: {} }]),
      /缺少合法 scope/,
    );
  });

  it('未确认 --yes 时不创建新布局目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vector-migrate-'));
    const configPath = path.join(dir, 'config.json');
    const vectorDir = path.join(dir, 'vector');
    const previous = process.env.KI_CONFIG_PATH;
    fs.writeFileSync(configPath, JSON.stringify({ dataDir: path.join(dir, 'data'), vectorDir }));
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();
    try {
      const result = await migrateLegacyVectorLayout({ yes: false });
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(path.join(vectorDir, 'collections')), false);
    } finally {
      if (previous === undefined) delete process.env.KI_CONFIG_PATH;
      else process.env.KI_CONFIG_PATH = previous;
      resetConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
