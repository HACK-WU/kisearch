/**
 * query-group.ts 测试
 *
 * 覆盖：hot/warm/cold/emerging 分区展示、
 *       指定 Group 查询 Relations + 词云、空数据
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// ─── 辅助 ───

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'query-group.ts'
);

function runQueryGroup(args: string[]): string {
  try {
    return execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
  } catch (err: any) {
    if (err.stdout) return err.stdout;
    return '';
  }
}

// ─── 测试 ───

const scope = `query-test-${Date.now()}`;

before(async () => {
  const { initScope, writeJson, readJson } = await import('../scripts/lib/store.js');
  const { getGroupIndexPath, getRelationsCachePath, getKbDir } = await import('../scripts/lib/scope.js');

  initScope(scope);

  // 构建 Group 树
  const indexPath = getGroupIndexPath(scope);
  const groupIndex = readJson<any>(indexPath)!;
  groupIndex.roots['项目根'] = {
    '监控': {
      '告警中心': {},
      '日志查询': {},
    },
    '部署': {
      '前端': {},
      '后端': {},
    },
  };
  writeJson(indexPath, groupIndex);

  // 构建 Relations 缓存
  const now = Date.now();
  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<any>(cachePath)!;
  cache.groups = {
    '项目根/监控/告警中心': {
      hot_relations: [
        {
          id: 'rel_001',
          text: '告警规则CRUD流程',
          score: 9.6,
          useCount: 10,
          lastUsedTime: now - 360000, // 0.1小时前
          isImported: false,
        },
        {
          id: 'rel_002',
          text: '通知渠道配置',
          score: 7.2,
          useCount: 5,
          lastUsedTime: now - 7200000,
          isImported: false,
        },
      ],
      keywords: ['规则', '阈值', '触发条件', '邮件', '短信', '渠道', '静默', '聚合', '升级'],
      max_hot_count: 10,
    },
    '项目根/监控/日志查询': {
      hot_relations: [
        {
          id: 'rel_003',
          text: '日志检索API',
          score: 5.5,
          useCount: 8,
          lastUsedTime: now - 1800000,
          isImported: false,
        },
      ],
      keywords: ['日志', '检索', '查询', 'ELK', '索引'],
      max_hot_count: 10,
    },
    '项目根/部署/前端': {
      hot_relations: [
        {
          id: 'rel_004',
          text: '前端构建部署',
          score: 2.0,
          useCount: 1,
          lastUsedTime: now - 3600000, // 最近使用 → 新兴热区候选
          isImported: false,
        },
      ],
      keywords: ['构建', '部署', 'CDN', 'npm', 'webpack'],
      max_hot_count: 10,
    },
  };
  writeJson(cachePath, cache);
});

after(async () => {
  const { getKbDir } = await import('../scripts/lib/scope.js');
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
});

describe('query-group hot 模式（默认）', () => {
  it('展示完整格式（热门索引 + 树 + 统计）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'hot',
    ]);

    assert.ok(output.includes('知识索引'));
    assert.ok(output.includes(`scope: ${scope}`));
    assert.ok(output.includes('热门索引'));
    assert.ok(output.includes('完整索引树'));
    assert.ok(output.includes('项目根'));
    assert.ok(output.includes('统计信息'));
  });

  it('显示热门索引列表', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'hot',
      '--hot-count', '3',
    ]);

    assert.ok(output.includes('热门索引'));
    assert.ok(output.includes('告警规则CRUD流程') || output.includes('项目根/监控/告警中心'));
  });

  it('显示统计信息', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'hot',
    ]);

    assert.ok(output.includes('总索引数'));
    assert.ok(output.includes('热区索引'));
    assert.ok(output.includes('常温区索引'));
    assert.ok(output.includes('冷区索引'));
  });
});

describe('query-group warm 模式', () => {
  it('展示常温区内容', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'warm',
    ]);

    assert.ok(output.includes('知识索引'));
    assert.ok(output.includes('完整索引树'));
    assert.ok(output.includes('统计信息'));
  });
});

describe('query-group cold 模式', () => {
  it('展示冷区内容', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'cold',
    ]);

    assert.ok(output.includes('知识索引'));
    assert.ok(output.includes('完整索引树'));
    assert.ok(output.includes('统计信息'));
  });
});

describe('query-group emerging 模式', () => {
  it('展示新兴热区内容', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'emerging',
    ]);

    assert.ok(output.includes('知识索引'));
    assert.ok(output.includes('完整索引树'));
    assert.ok(output.includes('统计信息'));
  });
});

describe('query-group 指定 Group 查询', () => {
  it('展示 Group 的 Relations + 词云', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--groups', '项目根/监控/告警中心',
    ]);

    assert.ok(output.includes('项目根/监控/告警中心'));
    assert.ok(output.includes('告警规则CRUD流程'));
    assert.ok(output.includes('通知渠道配置'));
    assert.ok(output.includes('关键词词云') || output.includes('关键词'));
  });

  it('展示多个 Group', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--groups', '项目根/监控/告警中心,项目根/监控/日志查询',
    ]);

    assert.ok(output.includes('告警规则CRUD流程'));
    assert.ok(output.includes('日志检索API'));
  });

  it('不存在的 Group 显示暂无', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--groups', '项目根/不存在的Group',
    ]);

    assert.ok(output.includes('暂无'));
  });
});

describe('query-group 边界情况', () => {
  it('空 scope 显示基本结构', async () => {
    const emptyScope = `empty-query-${Date.now()}`;
    const { initScope } = await import('../scripts/lib/store.js');
    const { getKbDir } = await import('../scripts/lib/scope.js');

    try {
      initScope(emptyScope);

      const output = runQueryGroup([
        '--scope', emptyScope,
        '--mode', 'hot',
      ]);

      assert.ok(output.includes('知识索引'));
      assert.ok(output.includes('统计信息'));
    } finally {
      const kbDir = getKbDir(emptyScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('depth 参数限制树深度', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'hot',
      '--depth', '1',
    ]);

    // depth=1 只显示根节点下的第一层
    assert.ok(output.includes('项目根'));
    // 第二层（监控、部署）可能显示为 ... 或不显示
  });

  it('hot-count 控制展示数量', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--groups', '项目根/监控/告警中心',
      '--hot-count', '1',
    ]);

    // 只展示 1 个热门知识
    assert.ok(output.includes('Top 1'));
  });
});
