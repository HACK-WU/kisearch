/**
 * import-kb.ts 测试
 *
 * 覆盖：约定模式、配置模式、幂等导入、isImported 标记、
 *       非 md 文件跳过、大文件跳过、关键词复用、覆盖更新
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

const SCRIPT_PATH = path.resolve(import.meta.dirname, '..', 'src', 'import-kb.ts');
const REAL_DOCS_DIR = path.resolve(import.meta.dirname, '..', 'docs');
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024;

function runImport(args: string[]): any {
  try {
    const output = execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv(),
    });
    return JSON.parse(output);
  } catch (err: any) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // ignore
      }
    }
    return { ok: false, error: err.message };
  }
}

const createdScopes: string[] = [];
const tempDirs: string[] = [];
let counter = 0;

interface SourceFileMeta {
  relativePath: string;
  isMarkdown: boolean;
  size: number;
}

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function listSourceFiles(dir: string, rootDir: string = dir): SourceFileMeta[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: SourceFileMeta[] = [];

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSourceFiles(absPath, rootDir));
      continue;
    }

    if (!entry.isFile()) continue;

    const stat = fs.statSync(absPath);
    results.push({
      relativePath: toPosix(path.relative(rootDir, absPath)),
      isMarkdown: /\.md$/i.test(entry.name),
      size: stat.size,
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function getGroupPath(rootName: string, relativePath: string): string {
  const dirName = path.posix.dirname(relativePath);
  return dirName === '.' ? rootName : `${rootName}/${dirName}`;
}
function getRelationText(relativePath: string): string {
  return path.posix.basename(relativePath).replace(/\.md$/i, '');
}

function makeScope(prefix: string): string {
  const scope = `${prefix}-${Date.now()}-${++counter}`;
  registerTestScope(scope);
  createdScopes.push(scope);
  return scope;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  for (const scope of createdScopes) {
    const kbDir = getKbDir(scope);
    if (fs.existsSync(kbDir)) {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  }

  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  cleanupTestConfig();
});

describe('import-kb 约定模式', () => {
  it('按目录结构导入 md 文件并跳过非 md 文件', async () => {
    const scope = makeScope('import-convention');
    const sourceDir = makeTempDir('ki-import-src');

    fs.mkdirSync(path.join(sourceDir, '监控', '告警中心'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, '部署'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, '监控', '告警中心', '告警规则CRUD流程.md'),
      '# 告警规则CRUD\n\n支持规则创建、查询、更新、删除。'
    );
    fs.writeFileSync(
      path.join(sourceDir, '部署', '前端部署.md'),
      '# 前端部署\n\n介绍构建与发布流程。'
    );
    fs.writeFileSync(path.join(sourceDir, 'README.txt'), 'not markdown');

    const result = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.root_name, 'wiki');
    assert.strictEqual(result.relations_imported, 2);
    assert.strictEqual(result.files_skipped, 1);
    assert.ok(result.groups_created >= 2);

    const { readJson } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');

    const groupIndex = readJson<any>(getGroupIndexPath(scope))!;
    assert.ok(groupIndex.groups.wiki);
    assert.ok(groupIndex.groups.wiki['监控']);
    assert.ok(groupIndex.groups.wiki['监控']['告警中心']);
    assert.ok(groupIndex.groups.wiki['部署']);

    const cache = readJson<any>(getRelationsCachePath(scope))!;
    assert.ok(cache.groups['wiki/监控/告警中心']);
    assert.ok(cache.groups['wiki/部署']);

    const localKb = readJson<any>(getLocalKbDir(scope, 'wiki/监控/告警中心'))!;
    assert.ok(localKb['告警规则CRUD流程'].includes('规则创建'));
  });

  it('导入 Relation 带 isImported=true 且 score=0', async () => {
    const scope = makeScope('import-flags');
    const sourceDir = makeTempDir('ki-import-flags');

    fs.writeFileSync(
      path.join(sourceDir, '通知渠道.md'),
      '# 通知渠道\n\n支持短信和邮件通知。'
    );

    const result = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);

    assert.strictEqual(result.ok, true);

    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const rel = cache.groups['wiki'].hot_relations.find((item: any) => item.text === '通知渠道');

    assert.ok(rel);
    assert.strictEqual(rel.isImported, true);
    assert.strictEqual(rel.score, 0);
    assert.strictEqual(rel.useCount, 0);
    assert.strictEqual(rel.lastUsedTime, null);
  });

  it('重复导入不产生重复 Relation，且会覆盖模块内容', async () => {
    const scope = makeScope('import-idempotent');
    const sourceDir = makeTempDir('ki-import-repeat');
    const filePath = path.join(sourceDir, '模块说明.md');

    fs.writeFileSync(filePath, '# 模块说明\n\n第一版内容。');
    const first = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(first.ok, true);

    fs.writeFileSync(filePath, '# 模块说明\n\n第二版内容。');
    const second = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(second.ok, true);

    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');

    const cache = readJson<any>(getRelationsCachePath(scope))!;
    assert.strictEqual(cache.groups['wiki'].hot_relations.length, 1);

    const localKb = readJson<any>(getLocalKbDir(scope, 'wiki'))!;
    assert.ok(localKb['模块说明'].includes('第二版内容'));
  });

  it('超大文件会被跳过', async () => {
    const scope = makeScope('import-large');
    const sourceDir = makeTempDir('ki-import-large');

    fs.writeFileSync(path.join(sourceDir, 'small.md'), '# small\n\nsmall file');
    fs.writeFileSync(path.join(sourceDir, 'big.md'), 'A'.repeat(10 * 1024 * 1024 + 1024));

    const result = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.relations_imported, 1);
    assert.strictEqual(result.files_skipped, 1);
    assert.ok(result.errors.some((msg: string) => msg.includes('超大文件')));
  });

  it('提供 scan-index 时会复用关键词', async () => {
    const scope = makeScope('import-keywords');
    const sourceDir = makeTempDir('ki-import-keywords');
    const scanIndexFile = path.join(sourceDir, 'scan-index.json');

    fs.mkdirSync(path.join(sourceDir, '监控', '告警中心'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, '监控', '告警中心', '告警规则CRUD流程.md'),
      '# 告警规则CRUD\n\n支持阈值和静默规则。'
    );

    fs.writeFileSync(scanIndexFile, JSON.stringify({
      version: 1,
      scope,
      rootName: 'wiki',
      sourceDir,
      lastScannedCommit: null,
      scannedAt: new Date().toISOString(),
      entries: [
        {
          path: '监控/告警中心/告警规则CRUD流程.md',
          fullPath: 'wiki/监控/告警中心/告警规则CRUD流程',
          summary: '告警规则摘要\n[路径] docs/监控/告警中心/告警规则CRUD流程.md',
          keywords: ['规则', '阈值', '静默'],
          enriched: false,
          vectorized: false,
          memoryId: null,
        },
      ],
      stats: { total: 1, scanned: 1, enriched: 0, vectorized: 0 },
    }, null, 2));

    const result = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
      '--scan-index', scanIndexFile,
    ]);

    assert.strictEqual(result.ok, true);

    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const groupData = cache.groups['wiki/监控/告警中心'];
    const rel = groupData.hot_relations.find(
      (item: any) => item.text === '告警规则CRUD流程'
    );

    assert.ok(rel);
    assert.strictEqual(rel.keywords, undefined);
    assert.deepStrictEqual(groupData.keywords, ['规则', '阈值', '静默']);
  });
});

describe('import-kb 配置模式', () => {
  it('mapping 可覆盖 root-name 并附加 code_refs', async () => {
    const scope = makeScope('import-mapping');
    const sourceDir = makeTempDir('ki-import-mapping');
    const mappingFile = path.join(sourceDir, 'import-mapping.json');

    fs.mkdirSync(path.join(sourceDir, 'alerts'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'alerts', 'crud-guide.md'),
      '# 告警规则\n\n这是告警规则文档。'
    );
    fs.writeFileSync(mappingFile, JSON.stringify({
      root_name: 'docs-wiki',
      groups: [
        {
          path: '监控/告警中心',
          sources: [
            {
              file: 'alerts/crud-guide.md',
              relation: '告警规则CRUD流程',
              code_refs: ['src/controllers/alert.ts: AlertController'],
            },
          ],
        },
      ],
    }, null, 2));

    const result = runImport([
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'will-be-overridden',
      '--mapping', mappingFile,
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.root_name, 'docs-wiki');
    assert.strictEqual(result.relations_imported, 1);

    const { readJson } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getLocalKbDir } = await import('../src/lib/scope.js');
    const groupIndex = readJson<any>(getGroupIndexPath(scope))!;
    assert.ok(groupIndex.groups['docs-wiki']);
    assert.ok(groupIndex.groups['docs-wiki']['监控']['告警中心']);

    const localKb = readJson<any>(getLocalKbDir(scope, 'docs-wiki/监控/告警中心'))!;
    assert.ok(localKb['告警规则CRUD流程'].includes('AlertController'));
    assert.ok(localKb['告警规则CRUD流程'].includes('## 代码定位'));
  });
});

describe('import-kb 真实 docs 目录', () => {
  it('可导入仓库 docs 目录并复用 scan-index 关键词', async () => {
    const scope = makeScope('import-real-docs');
    const rootName = 'repo-docs';
    const sourceFiles = listSourceFiles(REAL_DOCS_DIR);
    const importableFiles = sourceFiles.filter(
      (item) => item.isMarkdown && item.size > 0 && item.size <= MAX_IMPORT_FILE_SIZE
    );
    const skippedFiles = sourceFiles.length - importableFiles.length;
    const rootLevelFile = importableFiles.find((item) => !item.relativePath.includes('/'));
    const nestedFile = importableFiles.find((item) => item.relativePath.includes('/'));
    const scanIndexDir = makeTempDir('ki-import-real-docs');
    const scanIndexFile = path.join(scanIndexDir, 'scan-index.json');
    const keywordEntries = importableFiles.slice(0, Math.min(3, importableFiles.length));

    assert.ok(importableFiles.length > 0);
    assert.ok(rootLevelFile);
    // nestedFile 可能不存在（docs 目录结构变化时），仅在有子目录文件时验证

    fs.writeFileSync(scanIndexFile, JSON.stringify({
      version: 1,
      scope,
      rootName,
      sourceDir: REAL_DOCS_DIR,
      lastScannedCommit: null,
      scannedAt: new Date().toISOString(),
      entries: keywordEntries.map((item, index) => ({
        path: item.relativePath,
        fullPath: `${getGroupPath(rootName, item.relativePath)}/${getRelationText(item.relativePath)}`,
        summary: `真实 docs 导入测试摘要 ${index + 1}\n[路径] docs/${item.relativePath}`,
        keywords: [`关键词${index + 1}`, getRelationText(item.relativePath)],
        enriched: false,
        vectorized: false,
        memoryId: null,
      })),
      stats: {
        total: keywordEntries.length,
        scanned: keywordEntries.length,
        enriched: 0,
        vectorized: 0,
      },
    }, null, 2));

    const result = runImport([
      '--scope', scope,
      '--source', REAL_DOCS_DIR,
      '--root-name', rootName,
      '--scan-index', scanIndexFile,
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.root_name, rootName);
    assert.strictEqual(result.relations_imported, importableFiles.length);
    assert.strictEqual(result.files_skipped, skippedFiles);

    const { readJson } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');
    const groupIndex = readJson<any>(getGroupIndexPath(scope))!;
    const cache = readJson<any>(getRelationsCachePath(scope))!;

    assert.ok(groupIndex.groups[rootName]);
    assert.ok(cache.groups[rootName]);
    if (nestedFile) {
      assert.ok(cache.groups[getGroupPath(rootName, nestedFile.relativePath)]);
    }

    const rootLocalKb = readJson<any>(getLocalKbDir(scope, rootName))!;
    assert.ok(rootLocalKb[getRelationText(rootLevelFile!.relativePath)].length > 0);

    if (nestedFile) {
      const nestedGroupPath = getGroupPath(rootName, nestedFile.relativePath);
      const nestedLocalKb = readJson<any>(getLocalKbDir(scope, nestedGroupPath))!;
      assert.ok(nestedLocalKb[getRelationText(nestedFile.relativePath)].length > 0);
    }

    for (const [index, item] of keywordEntries.entries()) {
      const groupPath = getGroupPath(rootName, item.relativePath);
      const groupData = cache.groups[groupPath];
      const relation = groupData.hot_relations.find(
        (entry: any) => entry.text === getRelationText(item.relativePath)
      );

      assert.ok(relation);
      assert.strictEqual(relation.keywords, undefined);
      assert.strictEqual(relation.isImported, true);

      // keywords 在 Group 级，应包含 scan-index 中此文件的两个 keywords
      const expectedKw = [`关键词${index + 1}`, getRelationText(item.relativePath)];
      for (const kw of expectedKw) {
        assert.ok(
          groupData.keywords.includes(kw),
          `Group "${groupPath}" 应包含关键词 "${kw}"`
        );
      }
    }
  });
});
