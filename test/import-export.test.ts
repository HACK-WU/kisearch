/**
 * import-export.test.ts —— 同名自动后缀 relation 的导出消费回归。
 * 运行：npx jiti test/import-export.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

process.env.KI_DAEMON_OWNER = '1';
const { handleDirectImport } = await import('../src/lib/import.js');
const { handleExport } = await import('../src/export.js');
const { closeFtsEngine } = await import('../src/lib/fts-client.js');

const workspaceTemp = path.resolve(process.cwd(), 'temp');

function mkSource(): string {
  const dir = fs.mkdtempSync(path.join(workspaceTemp, 'import-export-source-'));
  fs.writeFileSync(path.join(dir, 'foo.md'), '# 原文 A\n内容 A');
  fs.writeFileSync(path.join(dir, '*foo*.md'), '# 原文 B\n内容 B');
  return dir;
}

describe('import → export 同名后缀消费链路', () => {
  after(async () => {
    await closeFtsEngine();
    cleanupTestConfig();
  });

  it('导出 foo 与 foo_1，内容和文件名保持逻辑 relation 一致', async () => {
    const scope = `import-export-${Date.now()}`;
    registerTestScope(scope);
    const sourceDir = mkSource();
    const outputDir = fs.mkdtempSync(path.join(workspaceTemp, 'import-export-output-'));

    const imported = await handleDirectImport({
      scope,
      sourceDir,
      group: 'ExportGroup',
      vector: false,
    });
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.conflicts.map((item) => item.relation), ['foo_1']);

    const exported = handleExport({ scope, output: outputDir, group: 'ExportGroup' });
    assert.equal(exported.ok, true);
    assert.equal(exported.stats.total, 2);
    assert.equal(exported.stats.exported, 2);
    const exportedContents = [
      fs.readFileSync(path.join(outputDir, 'ExportGroup', 'foo.md'), 'utf-8'),
      fs.readFileSync(path.join(outputDir, 'ExportGroup', 'foo_1.md'), 'utf-8'),
    ];
    assert.equal(exportedContents.some((content) => content.includes('内容 A')), true);
    assert.equal(exportedContents.some((content) => content.includes('内容 B')), true);
  });
});
