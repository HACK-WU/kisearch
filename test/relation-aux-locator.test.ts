/**
 * relation-map.ts 辅助通道定位测试 —— `resolveAuxHit` / `getRelationAuxIndex`
 *
 * 背景：`ki-relation` / `ki-path` 向量的 docId **按设计不写入 relations-cache**
 * （rebuild 的 updateMemoryIds、import 的 writeRelations 都只回写内容向量与自定义 tag
 * 向量），所以检索结果落到这两个通道时按 id 反查必然 miss —— 表现为「group 有值、
 * relation 为空」，用户无法定位文件。
 *
 * 本测试覆盖「用向量自带字段反推父文档」的反查层：
 *   A. ki-relation：chunk 名 → 文件级 relation（含最长前缀、后缀合法性）
 *   B. ki-path：路径文本 → group（含段名自带空格的歧义）
 *   C. 不适用范围与缓存语义（与 getRelationMap 同源、身份变化后重建）
 *
 * 运行：npx jiti test/relation-aux-locator.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationMap,
  getRelationAuxIndex,
  resolveAuxHit,
  AUX_RELATION_TAG,
  AUX_PATH_TAG,
} from '../src/lib/relation-map.js';
import { getRelationsCachePath } from '../src/lib/scope.js';
import { resetConfigCache } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relation-aux-'));

function setupConfig(): void {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-'));
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${path.join(dir, 'kb')}`,
      `vectorDir: ${path.join(dir, 'vector')}`,
      'scopeMode: default',
      'scopes:',
      '  default: {}',
      '',
    ].join('\n'),
    'utf-8'
  );
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
}

function writeCache(scope: string, groups: Record<string, unknown>): void {
  const p = getRelationsCachePath(scope);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, scope, groups }, null, 2), 'utf-8');
}

const BASIC_CACHE = {
  'a/b': {
    hot_relations: [
      { id: 'r1', text: '钉钉集成配置', memoryId: 'm1', sourcePath: 'a/b/钉钉集成配置.md' },
      { id: 'r2', text: '钉钉 webhook 地址', memoryId: 'm2' },
    ],
    keywords: [],
  },
};

describe('A. resolveAuxHit —— ki-relation（chunk 名 → 文件级 relation）', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('chunk 名反推出文件级 relation 与 sourcePath', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    const hit = resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'a/b', content: '钉钉集成配置-03' });
    assert.deepEqual(hit, {
      group: 'a/b',
      relation: '钉钉集成配置',
      sourcePath: 'a/b/钉钉集成配置.md',
    });
  });

  it('最长前缀优先：文件级名本身以 -NN 结尾时不能被截短', () => {
    setupConfig();
    writeCache('default', {
      g: {
        hot_relations: [
          { id: 'r1', text: '迁移方案', memoryId: 'm1' },
          { id: 'r2', text: '迁移方案-12', memoryId: 'm2' },
        ],
        keywords: [],
      },
    });
    const aux = getRelationAuxIndex('default');

    // `迁移方案-12-00` 既可读作「迁移方案 的第 12 号 chunk」也可读作「迁移方案-12 的第 0 号 chunk」，
    // 只有最长前缀（迁移方案-12）成立。
    const hit = resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'g', content: '迁移方案-12-00' });
    assert.equal(hit?.relation, '迁移方案-12');
  });

  it('chunk 序号 ≥ 100 时后缀为三位以上数字，仍能解析', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    const hit = resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'a/b', content: '钉钉集成配置-120' });
    assert.equal(hit?.relation, '钉钉集成配置');
  });

  it('后缀不合法（单数字 / 非数字 / 无后缀）不解析', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    for (const content of ['钉钉集成配置-1', '钉钉集成配置-abc', '钉钉集成配置', '钉钉集成配置-']) {
      assert.equal(
        resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'a/b', content }),
        undefined,
        `不应解析：${content}`
      );
    }
  });

  it('group 缺失 / 未知 group / 空 content 不解析（不跨组猜测）', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    assert.equal(resolveAuxHit(aux, { tag: AUX_RELATION_TAG, content: '钉钉集成配置-03' }), undefined);
    assert.equal(resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'other', content: '钉钉集成配置-03' }), undefined);
    assert.equal(resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'a/b', content: '' }), undefined);
  });

  it('旧格式 content（`名称 | Group: … | 关键词`）+ 无结构化 group：安全降级不误配', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    // 老版本写入的 ki-relation 向量：content 带 | Group: … 段，且向量文档可能没有 group 字段
    assert.equal(
      resolveAuxHit(aux, { tag: AUX_RELATION_TAG, content: '钉钉集成配置 | Group: a b | 集成,webhook' }),
      undefined
    );
    // 即便误传了 group，旧格式 content 也匹配不到 `-NN` 后缀规则（不会误配到别的文件）
    assert.equal(
      resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'a/b', content: '钉钉集成配置 | Group: a b | 集成' }),
      undefined
    );
  });

  it('缓存里存在空名字 relation 时不参与反推（startsWith("") 恒真的陷阱）', () => {
    setupConfig();
    writeCache('default', {
      g: {
        hot_relations: [
          { id: 'r0', text: '', memoryId: 'm0' },
          { id: 'r1', text: '正常文档', memoryId: 'm1' },
        ],
        keywords: [],
      },
    });
    const aux = getRelationAuxIndex('default');

    // 空名字若进候选，`-12` 会被当成"某个文件"解析出来
    assert.equal(resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'g', content: '-12' }), undefined);
    assert.equal(resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'g', content: '正常文档-05' })?.relation, '正常文档');
  });
});

describe('B. resolveAuxHit —— ki-path（路径文本 → group）', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('路径文本反推出 group，relation 为空串（无单一文件可指）', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    assert.deepEqual(resolveAuxHit(aux, { tag: AUX_PATH_TAG, content: 'a b' }), {
      group: 'a/b',
      relation: '',
    });
  });

  it('段名自带空格时不误还原成多级路径（精确匹配而非空格转斜杠）', () => {
    setupConfig();
    writeCache('default', {
      'x y/z': { hot_relations: [{ id: 'r1', text: 'r', memoryId: 'm1' }], keywords: [] },
    });
    const aux = getRelationAuxIndex('default');

    // 写入侧 buildGroupPathContent('x y/z') = 'x y z'：按空格转回斜杠会得到 x/y/z（不存在）
    assert.equal(resolveAuxHit(aux, { tag: AUX_PATH_TAG, content: 'x y z' })?.group, 'x y/z');
    assert.equal(resolveAuxHit(aux, { tag: AUX_PATH_TAG, content: 'x/y/z' }), undefined);
  });

  it('未收录的路径不解析', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');
    assert.equal(resolveAuxHit(aux, { tag: AUX_PATH_TAG, content: 'a c' }), undefined);
  });
});

describe('C. 适用边界与缓存语义', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('非辅助通道（ki-search / 自定义 tag / 无 tag）一律不解析', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);
    const aux = getRelationAuxIndex('default');

    for (const tag of ['ki-search', '运维', '', undefined]) {
      assert.equal(
        resolveAuxHit(aux, { tag, group: 'a/b', content: '钉钉集成配置-03' }),
        undefined,
        `不应解析 tag=${String(tag)}`
      );
    }
  });

  it('无 relations 数据时返回空索引，且不抛错', () => {
    setupConfig();
    const aux = getRelationAuxIndex('default');
    assert.equal(aux.byGroup.size, 0);
    assert.equal(aux.byPathContent.size, 0);
    assert.equal(resolveAuxHit(aux, { tag: AUX_RELATION_TAG, group: 'a/b', content: 'x-01' }), undefined);
  });

  it('与 getRelationMap 同源：同一身份只构建一次，写后身份变化即重建', () => {
    setupConfig();
    writeCache('default', BASIC_CACHE);

    // 先取 id 反查表，再取辅助索引：两者必须看到同一份数据
    assert.equal(getRelationMap('default').size, 2);
    const aux1 = getRelationAuxIndex('default');
    assert.equal(resolveAuxHit(aux1, { tag: AUX_RELATION_TAG, group: 'a/b', content: '钉钉集成配置-03' })?.relation, '钉钉集成配置');

    // 写路径落盘（mtime/size 变化）后，辅助索引也要跟着重建
    writeCache('default', {
      'a/b': {
        hot_relations: [{ id: 'r9', text: '新增文档', memoryId: 'm9' }],
        keywords: [],
      },
    });
    const aux2 = getRelationAuxIndex('default');
    assert.equal(resolveAuxHit(aux2, { tag: AUX_RELATION_TAG, group: 'a/b', content: '新增文档-01' })?.relation, '新增文档');
    assert.equal(resolveAuxHit(aux2, { tag: AUX_RELATION_TAG, group: 'a/b', content: '钉钉集成配置-03' }), undefined);
  });
});
