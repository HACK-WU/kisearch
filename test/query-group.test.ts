/**
 * query-group.ts 测试
 *
 * 覆盖：hot/warm/cold/emerging 分区展示、
 *       指定 Group 查询 Relations + 词云、空数据、
 *       relations-cache 结构损坏的加载边界 fail-loud（CACHE_SHAPE_INVALID）、
 *       Group 聚合分的均值口径（非求和）、非 full 模式的展示截断提示
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

// ─── 辅助 ───

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'query-group.ts'
);

function runQueryGroup(args: string[]): string {
  try {
    return execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv()
    });
  } catch (err: any) {
    if (err.stdout) return err.stdout;
    return '';
  }
}

// ─── 测试 ───

const scope = `query-test-${Date.now()}`;

before(async () => {
  registerTestScope(scope);
  const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
  const { getGroupIndexPath, getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

  initScope(scope);

  // 构建 Group 树
  const indexPath = getGroupIndexPath(scope);
  const groupIndex = readJson<any>(indexPath)!;
  groupIndex.groups['项目根'] = {
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
    },
  };
  writeJson(cachePath, cache);
});

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

describe('query-group hot 模式（默认）', () => {
  it('展示完整格式（热门索引 + 统计）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--mode', 'hot',
    ]);

    assert.ok(output.includes('知识索引'));
    assert.ok(output.includes(`scope: ${scope}`));
    assert.ok(output.includes('热门索引'));
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
    assert.ok(output.includes('统计信息'));
  });
});

describe('query-group 指定 Group 查询', () => {
  it('展示 Group 的 Relations（词云已移除，REQ-05）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--groups', '项目根/监控/告警中心',
    ]);

    assert.ok(output.includes('项目根/监控/告警中心'));
    assert.ok(output.includes('告警规则CRUD流程'));
    assert.ok(output.includes('通知渠道配置'));
    assert.ok(!output.includes('关键词词云'), '词云展示已移除（REQ-05）');
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
    const { initScope } = await import('../src/lib/store.js');
    const { getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(emptyScope);
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

// ─── subtree 子树视图（结构导航视角）───

describe('query-group subtree 子树视图', () => {
  it('以指定 Group 为根输出子树结构（含直接子 Group）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根/监控',
    ]);

    assert.ok(output.includes('=== 子树: 项目根/监控 ==='));
    // 直接子 Group 均在子树中，且带 score 标注
    assert.ok(output.includes('告警中心'));
    assert.ok(output.includes('日志查询'));
    assert.ok(output.includes('(score:'));
    // 兄弟分支（部署）不在子树内
    assert.ok(!output.includes('部署/'));
  });

  it('根路径子树包含多个一级分支', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根',
    ]);

    assert.ok(output.includes('=== 子树: 项目根 ==='));
    assert.ok(output.includes('监控'));
    assert.ok(output.includes('部署'));
  });

  it('depth 从子树根起算：--depth 2 只展开一级子节点', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根',
      '--depth', '2',
    ]);

    assert.ok(output.includes('监控'));
    // 孙层（告警中心）不应展开（renderTreeChildren 深度守卫 currentDepth >= maxDepth）
    assert.ok(!output.includes('告警中心'));
  });

  it('叶子 Group（无子节点）：提示 + 自身 Relations 概要（REQ-03）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根/监控/告警中心',
    ]);

    assert.ok(output.includes('该 Group 下无子 Group'));
    // 自身 Relations 概要不丢上下文（告警中心有 rel_001/rel_002）
    assert.ok(output.includes('告警规则CRUD流程'));
  });

  it('叶子 Group 且无 Relations：提示无子 Group + 提示暂无 Relations', () => {
    // 部署/后端：树中存在但夹具未写入 Relations
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根/部署/后端',
    ]);

    assert.ok(output.includes('该 Group 下无子 Group'));
    assert.ok(output.includes('也暂无 Relations'));
  });

  it('路径补全：省略顶层时自动补全后展示子树（与 groups 一致的四层解析）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '监控/告警中心',
      '--no-auto-fallback',
    ]);

    // resolveGroupPath 顶层补全：监控/告警中心 → 项目根/监控/告警中心（叶子 → 无子 Group 提示）
    assert.ok(output.includes('项目根/监控/告警中心'));
    assert.ok(output.includes('该 Group 下无子 Group'));
  });

  it('路径不存在：提示不存在 + 兜底引导', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '完全不存在的路径',
      '--no-auto-fallback',
    ]);

    assert.ok(output.includes('(Group 路径不存在)'));
  });

  it('与 --groups 互斥：同时传时 fail-loud', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--groups', '项目根/监控',
      '--subtree', '项目根/部署',
    ]);

    assert.ok(output.includes('互斥'));
  });

  it('subtree 不受 mode 过滤：hot 模式下仍展示全结构', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根/部署',
      '--mode', 'hot',
    ]);

    // 冷区的后端节点也在结构树中（结构视图不受分区过滤）
    assert.ok(output.includes('前端'));
    assert.ok(output.includes('后端'));
  });

  it('叶子概要固定按热区：--mode cold 不滤空热区 Relations（challenger Q2）', () => {
    const output = runQueryGroup([
      '--scope', scope,
      '--subtree', '项目根/监控/告警中心',
      '--mode', 'cold',
    ]);

    // 告警中心的 Relations 属热区：概要固定热区展示，不被 --mode cold 滤空
    assert.ok(output.includes('告警规则CRUD流程'));
  });
});

// ─── relations-cache 结构校验（加载边界 fail-loud）───

/**
 * 在独立 scope 下写入指定 groups 形态的 relations-cache，跑一次 query-group 并返回输出。
 * 用于验证「加载边界统一 fail-loud」而非在各消费点静默降级成「0 分 / 0 条 Relation」。
 * 校验点在 loadRelationsCache，早于任何 group-index / 分区计算，故损坏 Group
 * 即使不在树中也会被报出。
 */
async function runWithCacheGroups(groups: unknown, args: string[] = []): Promise<string> {
  const brokenScope = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
  const { getKbDir, getRelationsCachePath, getGroupIndexPath } = await import('../src/lib/scope.js');

  try {
    registerTestScope(brokenScope);
    initScope(brokenScope);

    const indexPath = getGroupIndexPath(brokenScope);
    const groupIndex = readJson<any>(indexPath)!;
    groupIndex.groups['模块A'] = {};
    writeJson(indexPath, groupIndex);

    const cachePath = getRelationsCachePath(brokenScope);
    const cache = readJson<any>(cachePath)!;
    cache.groups = groups;  // undefined 时 JSON 序列化会丢掉 groups 键
    writeJson(cachePath, cache);

    return runQueryGroup(['--scope', brokenScope, '--mode', 'hot', ...args]);
  } finally {
    const kbDir = getKbDir(brokenScope);
    if (fs.existsSync(kbDir)) {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  }
}

describe('query-group relations-cache 结构校验', () => {
  const BROKEN = { keywords: [] };  // 缺 hot_relations

  it('Group 缺 hot_relations → CACHE_SHAPE_INVALID + 损坏路径 + 可执行出路', async () => {
    const output = await runWithCacheGroups({ '模块A': BROKEN });

    assert.ok(output.includes('CACHE_SHAPE_INVALID'), `应 fail-loud，实际：${output.slice(0, 200)}`);
    assert.ok(output.includes('模块A'), '应指出具体损坏的 Group 路径');
    assert.ok(output.includes('hot_relations'), '应指出损坏字段');
    // 出路必须可执行：ki restore 确实能还原快照；不得指向不校验 cache 的 ki doctor（假出路）
    assert.ok(output.includes('ki restore'), '应给出恢复出路');
    assert.ok(output.includes('--from-snapshot'), '出路应含完整参数');
    assert.ok(!output.includes('ki doctor'), '不得给假出路（doctor 不校验 relations-cache）');
  });

  it('hot_relations 非数组（null / 对象 / 字符串）同样拦截', async () => {
    for (const bad of [null, {}, 'oops']) {
      const output = await runWithCacheGroups({ '模块A': { hot_relations: bad, keywords: [] } });
      assert.ok(output.includes('CACHE_SHAPE_INVALID'), `hot_relations=${JSON.stringify(bad)} 应被拦截`);
    }
  });

  it('缺 groups 对象 → CACHE_SHAPE_INVALID（走独立分支）', async () => {
    const output = await runWithCacheGroups(undefined);

    assert.ok(output.includes('CACHE_SHAPE_INVALID'));
    assert.ok(output.includes('缺少 groups 对象'), '应命中缺 groups 分支而非逐 Group 校验');
    assert.ok(output.includes('ki restore'), '该分支也需给出出路');
  });

  it('部分损坏：精确指出损坏方，不牵连正常 Group', async () => {
    const now = Date.now();
    const output = await runWithCacheGroups({
      '模块A': {
        hot_relations: [{
          id: 'rel_001', text: '正常条目', score: 1, useCount: 1,
          lastUsedTime: now, isImported: false,
        }],
        keywords: [],
      },
      '模块B': BROKEN,
    });

    assert.ok(output.includes('CACHE_SHAPE_INVALID'));
    assert.ok(output.includes('模块B'), '应指出损坏方');
    assert.ok(!output.includes('- 模块A'), '不得把正常 Group 列为损坏');
  });

  it('合法空 groups（{}）不误伤：仍正常输出统计', async () => {
    const output = await runWithCacheGroups({});

    assert.ok(!output.includes('CACHE_SHAPE_INVALID'), `空 groups 是合法状态：${output.slice(0, 200)}`);
    assert.ok(output.includes('知识索引'));
    assert.ok(output.includes('统计信息'));
  });

  it('损坏超过 5 个 Group 时按 MAX_SHOW 截断并给出剩余计数', async () => {
    const broken: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) broken[`域${String(i).padStart(2, '0')}`] = BROKEN;
    const output = await runWithCacheGroups(broken);

    assert.ok(output.includes('共 8 个 Group 损坏'), '应报出总数');
    assert.ok(output.includes('另有 3 个 Group 同样损坏'), '应给出剩余计数');
    assert.strictEqual(
      (output.match(/hot_relations 缺失或不是数组/g) || []).length, 5,
      '明细最多列 5 条'
    );
  });

  it('各展示路径均经边界校验（--groups / --subtree / full 不退化为 TypeError）', async () => {
    for (const args of [['--groups', '模块A'], ['--subtree', '模块A'], ['--mode', 'full']]) {
      const output = await runWithCacheGroups({ '模块A': BROKEN }, args);
      const label = args.join(' ');
      assert.ok(output.includes('CACHE_SHAPE_INVALID'),
        `${label} 应被边界拦截，实际：${output.slice(0, 200)}`);
      assert.ok(!output.includes('Cannot read properties'),
        `${label} 不得退化为 TypeError（即不得绕过边界校验）`);
    }
  });
});

// ─── Group 聚合分口径（均值，非求和）───

/**
 * 在独立 scope 下写入指定树 + groups，跑一次 query-group 并返回输出。
 * args 缺省为 `--mode full`（树视图会渲染 Group 聚合分）；也可传 `--groups`/`--hot-count` 等验证展示口径。
 */
async function runWithTreeAndGroups(tree: unknown, groups: unknown, args: string[] = ['--mode', 'full']): Promise<string> {
  const s = `agg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
  const { getKbDir, getRelationsCachePath, getGroupIndexPath } = await import('../src/lib/scope.js');

  try {
    registerTestScope(s);
    initScope(s);

    const indexPath = getGroupIndexPath(s);
    const groupIndex = readJson<any>(indexPath)!;
    groupIndex.groups = tree;
    writeJson(indexPath, groupIndex);

    const cachePath = getRelationsCachePath(s);
    const cache = readJson<any>(cachePath)!;
    cache.groups = groups;
    writeJson(cachePath, cache);

    return runQueryGroup(['--scope', s, ...args]);
  } finally {
    const kbDir = getKbDir(s);
    if (fs.existsSync(kbDir)) {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  }
}

describe('query-group Group 聚合分口径', () => {
  /**
   * lastUsedTime: null 走 calculateScore 的 hoursSinceLastUse=0 分支 → score 恰等于 useCount，
   * 不依赖 Date.now()，故期望值可写死（无时间漂移 flaky）；且 null 不算新兴，不干扰分区。
   */
  const mk = (id: string, useCount: number) => ({
    id, text: `条目-${id}`, score: 0, useCount, lastUsedTime: null, isImported: false,
  });

  it('取组内 Relation 评分的**均值**：改回求和即刻红（口径回归锁）', async () => {
    // A 组 3 条各 3 分 → 均值 3 / 求和 9；B 组 1 条 5 分 → 均值 = 求和 = 5。
    // 两种口径下渲染值（3 vs 9）与排序结论（B 热 / A 热）均不同，故能唯一锁住均值。
    const output = await runWithTreeAndGroups(
      { '均值A': {}, '均值B': {} },
      {
        '均值A': { hot_relations: [mk('a1', 3), mk('a2', 3), mk('a3', 3)], keywords: [] },
        '均值B': { hot_relations: [mk('b1', 5)], keywords: [] },
      }
    );

    assert.ok(output.includes('均值A/ (score: 3)'),
      `A 组应渲染均值 3（求和口径会是 9），实际：${output.split('\n').filter((l) => l.includes('均值')).join(' | ')}`);
    assert.ok(!output.includes('均值A/ (score: 9)'), 'A 组不得渲染求和值 9');
    assert.ok(output.includes('均值B/ (score: 5)'), 'B 组均值 = 5');
  });

  it('均值口径下「少而活跃」压过「多而冷」（排序结论锁）', async () => {
    // 求和口径：A = 30×1 = 30 压过 B = 2×4 = 8；均值口径：A = 1 < B = 4 → B 进热区、A 落常温区。
    const output = await runWithTreeAndGroups(
      { '多而冷': {}, '少而活跃': {} },
      {
        '多而冷': {
          hot_relations: Array.from({ length: 30 }, (_, i) => mk(`c${i}`, 1)),
          keywords: [],
        },
        '少而活跃': {
          hot_relations: [mk('h0', 4), mk('h1', 4)],
          keywords: [],
        },
      }
    );

    assert.ok(/少而活跃\/ \(score: 4\) \[热\]/.test(output),
      `均值口径下少而活跃组应入热区，实际：${output.split('\n').filter((l) => l.includes('score')).join(' | ')}`);
    assert.ok(/多而冷\/ \(score: 1\) \[常温\]/.test(output),
      '均值口径下多而冷组应为 1 分且不在热区（求和口径会是 30 分 [热]）');
  });

  it('空 Group 记 0 分（不产生 NaN 污染排序）', async () => {
    const output = await runWithTreeAndGroups(
      { '空组': {}, '有分组': {} },
      {
        '空组': { hot_relations: [], keywords: [] },
        '有分组': { hot_relations: [mk('x', 6)], keywords: [] },
      }
    );

    assert.ok(output.includes('空组/ (score: 0)'), `空 Group 应记 0 分，实际：${output.split('\n').filter((l) => l.includes('空组')).join(' | ')}`);
    assert.ok(!output.includes('NaN'), '不得出现 NaN（0/0）');
    assert.ok(output.includes('有分组/ (score: 6) [热]'), '有分组应入热区');
  });
});

// ─── 非 full 模式的展示截断提示（默认路径不得静默丢展示）───

describe('query-group 分区展示截断提示', () => {
  /**
   * 40 条 Relation + 默认配置（maxHotCount=10, hotPercent=0.3, warmPercent=0.5）：
   * totalHotSeats = ceil(40*0.3) = 12 → 截断为 hot=10；pool=30 → warm=15、cold=15。
   * 三区均 > 默认 --hot-count 5，故每个区都应出截断提示与出路命令。
   * score 用 lastUsedTime:null 钉死为 useCount（= 40-i，严格递减），不依赖时间。
   */
  const MANY = Array.from({ length: 40 }, (_, i) => ({
    id: `rel_${String(i + 1).padStart(3, '0')}`,
    text: `条目-${String(i).padStart(2, '0')}`,
    score: 0,
    useCount: 40 - i,
    lastUsedTime: null,
    isImported: false,
  }));
  const GROUPS = { '大组': { hot_relations: MANY, keywords: [] } };
  const TREE = { '大组': {} };

  it('默认 --hot-count 5 下截断可感知：标题带本区总数 + 未展示计数 + 出路命令', async () => {
    const output = await runWithTreeAndGroups(TREE, GROUPS, ['--groups', '大组', '--mode', 'hot,warm,cold']);

    assert.ok(output.includes('热门索引 (Top 5 / 本区共 10)'), `热区标题应带本区总数：${output.split('\n').filter((l) => l.includes('Top')).join(' | ')}`);
    assert.ok(output.includes('还有 5 个未展示；查看本区完整列表：--mode hot --hot-count 10'), '热区应给出未展示计数与出路');
    assert.ok(output.includes('常温索引 (Top 5 / 本区共 15)'), '常温区标题应带本区总数');
    assert.ok(output.includes('冷区索引 (Top 5 / 本区共 15)'), '冷区标题应带本区总数');
    assert.ok(output.includes('--mode cold --hot-count 15'), '冷区出路应可直接执行');
  });

  it('出路是真的出路：按提示放大 --hot-count 能取到本区全量且不再有截断提示', async () => {
    const output = await runWithTreeAndGroups(TREE, GROUPS, ['--groups', '大组', '--mode', 'cold', '--hot-count', '15']);

    const items = output.split('\n').filter((l) => l.includes('条目-'));
    assert.strictEqual(items.length, 15, `冷区应渲染全量 15 条，实际 ${items.length} 条`);
    assert.ok(!output.includes('个未展示'), '取到全量后不得再报截断');
    assert.ok(output.includes('冷区索引 (Top 15)'), '未截断时标题不附加本区总数（保持原格式）');
  });

  it('未截断时输出格式零变化（不误伤存量口径）', async () => {
    // 2 条 Relation → hot=1、warm=1、cold=0，均 ≤ 5 → 无提示、标题不带本区总数
    const few = MANY.slice(0, 2);
    const output = await runWithTreeAndGroups(
      { '小组': {} },
      { '小组': { hot_relations: few, keywords: [] } },
      ['--groups', '小组', '--mode', 'hot,warm']
    );

    assert.ok(output.includes('热门索引 (Top 1):'), `未截断时标题应为原格式：${output.split('\n').filter((l) => l.includes('Top')).join(' | ')}`);
    assert.ok(!output.includes('本区共'), '未截断时不得附加本区总数');
    assert.ok(!output.includes('个未展示'), '未截断时不得出截断提示');
  });
});
