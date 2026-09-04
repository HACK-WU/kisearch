/**
 * lib 模块单元测试
 * 
 * 覆盖：WAL 读写一致性、tmp 清理、scope 校验、评分公式、recordUse 防刷、
 *       partitionByScore 冷热分区（守恒不变量 / 上限截断回流 / 新兴席位 / 纯函数）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { walWrite, cleanupTmpFiles } from '../src/lib/wal.js';
import { validateScope, getKbDir, getGroupIndexPath } from '../src/lib/scope.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import {
  calculateScore,
  recordUse,
  partitionByScore,
  type Relation,
} from '../src/lib/scoring.js';
import { DEFAULT_PARTITION_CONFIG } from '../src/lib/constants.js';

// ─── 临时目录 ───

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));

  // 隔离配置：创建测试专用 config.json，确保不依赖全局配置
  const testConfigDir = path.join(tmpDir, '.ki');
  fs.mkdirSync(testConfigDir, { recursive: true });
  const testConfig = { dataDir: path.join(tmpDir, 'kb'), backupDir: path.join(tmpDir, 'backup'), scopes: {} };
  fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify(testConfig));
  resetConfigCache();
  loadConfig(path.join(testConfigDir, 'config.json'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── WAL 测试 ───

describe('WAL 写入', () => {
  it('写入后读取数据一致', () => {
    const filePath = path.join(tmpDir, 'test.json');
    const data = { version: 1, name: 'test', items: [1, 2, 3] };
    walWrite(filePath, data);

    const read = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.deepStrictEqual(read, data);
  });

  it('写入后无 .tmp 残留', () => {
    const filePath = path.join(tmpDir, 'test2.json');
    walWrite(filePath, { ok: true });

    const files = fs.readdirSync(tmpDir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
  });

  it('覆盖写入保留数据完整性', () => {
    const filePath = path.join(tmpDir, 'test3.json');
    walWrite(filePath, { v: 1 });
    walWrite(filePath, { v: 2 });

    const read = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.strictEqual(read.v, 2);
  });
});

describe('WAL 残留清理', () => {
  it('清理目录中的 .tmp 文件', () => {
    const cleanDir = path.join(tmpDir, 'clean-test');
    fs.mkdirSync(cleanDir, { recursive: true });
    fs.writeFileSync(path.join(cleanDir, 'a.tmp'), 'x');
    fs.writeFileSync(path.join(cleanDir, 'b.tmp'), 'y');
    fs.writeFileSync(path.join(cleanDir, 'c.json'), 'z');

    const count = cleanupTmpFiles(cleanDir);
    assert.strictEqual(count, 2);

    const remaining = fs.readdirSync(cleanDir);
    assert.deepStrictEqual(remaining, ['c.json']);
  });

  it('空目录返回 0', () => {
    const emptyDir = path.join(tmpDir, 'empty-test');
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.strictEqual(cleanupTmpFiles(emptyDir), 0);
  });
});

// ─── Scope 校验测试 ───

describe('Scope 校验', () => {
  it('合法 scope 通过', () => {
    assert.doesNotThrow(() => validateScope('project-a'));
    assert.doesNotThrow(() => validateScope('my_project'));
    assert.doesNotThrow(() => validateScope('test123'));
  });

  it('非法 scope 拒绝', () => {
    assert.throws(() => validateScope(''), /不能为空/);
    assert.throws(() => validateScope('../etc'), /不合法/);
    assert.throws(() => validateScope('a/b'), /不合法/);
    assert.throws(() => validateScope('a b'), /不合法/);
    assert.throws(() => validateScope('a..b'), /不合法/);
  });

  it('路径构造函数使用合法 scope', () => {
    const kbDir = getKbDir('project-a');
    assert.ok(kbDir.endsWith('/project-a'), `kbDir should end with /project-a, got: ${kbDir}`);

    const indexPath = getGroupIndexPath('project-a');
    assert.ok(indexPath.endsWith('/project-a/group-index.json'));
  });
});

// ─── 评分公式测试 ───

describe('评分公式 calculateScore', () => {
  const now = Date.now();

  it('useCount=0 返回 0', () => {
    assert.strictEqual(calculateScore(0, null, now), 0);
  });

  it('高频使用（刚用过）≈ useCount', () => {
    const score = calculateScore(10, now - 6000, now); // 0.1 小时前
    assert.ok(score > 9.5);
  });

  it('中频使用（1天前）≈ 2.5', () => {
    const score = calculateScore(5, now - 24 * 3600000, now);
    assert.ok(Math.abs(score - 2.5) < 0.1);
  });

  it('新内容首次使用 = 1.0', () => {
    const score = calculateScore(1, now, now);
    assert.strictEqual(score, 1);
  });

  it('长时间未用自然衰减', () => {
    const score = calculateScore(3, now - 7 * 24 * 3600000, now); // 7天前
    assert.ok(score < 0.5);
  });

  it('lastUsedTime=null 视为刚使用', () => {
    const score = calculateScore(5, null, now);
    assert.strictEqual(score, 5);
  });

  it('halfLifeHours 参数生效', () => {
    const score1 = calculateScore(5, now - 24 * 3600000, now, 24);
    const score2 = calculateScore(5, now - 24 * 3600000, now, 48);
    assert.ok(score2 > score1); // 半衰期更长，衰减更慢
  });

  it('评分特性表验证', () => {
    // 低频使用（2天前）
    const score = calculateScore(2, now - 48 * 3600000, now);
    assert.ok(Math.abs(score - 0.67) < 0.1);
  });
});

// ─── recordUse 测试 ───

describe('recordUse 防刷分', () => {
  const now = Date.now();

  const baseRelation: Relation = {
    id: 'rel_001',
    text: '测试',
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };

  it('首次使用 useCount=1', () => {
    const result = recordUse(baseRelation, now);
    assert.strictEqual(result.useCount, 1);
    assert.strictEqual(result.lastUsedTime, now);
  });

  it('5分钟内重复使用不计数', () => {
    const used = { ...baseRelation, useCount: 3, lastUsedTime: now };
    const result = recordUse(used, now + 2 * 60 * 1000); // 2分钟后
    assert.strictEqual(result.useCount, 3); // 不变
  });

  it('5分钟后使用计数+1', () => {
    const used = { ...baseRelation, useCount: 3, lastUsedTime: now };
    const result = recordUse(used, now + 6 * 60 * 1000); // 6分钟后
    assert.strictEqual(result.useCount, 4);
  });

  it('不超过 maxUseCount=10', () => {
    const maxed = { ...baseRelation, useCount: 10, lastUsedTime: now - 3600000 };
    const result = recordUse(maxed, now);
    assert.strictEqual(result.useCount, 10);
  });

  it('不修改原始对象', () => {
    const original = { ...baseRelation, useCount: 2, lastUsedTime: now - 3600000 };
    const result = recordUse(original, now);
    assert.strictEqual(original.useCount, 2); // 原始不变
    assert.strictEqual(result.useCount, 3);
  });
});

// ─── partitionByScore 冷热分区测试 ───

describe('partitionByScore 冷热分区', () => {
  const now = Date.now();
  const H = 3600 * 1000;

  function makeRelation(id: string, useCount: number, hoursAgo: number | null, isImported = false): Relation {
    return {
      id,
      text: id,
      score: 0,
      useCount,
      lastUsedTime: hoursAgo === null ? null : now - hoursAgo * H,
      isImported,
    };
  }

  /** 复刻 query-group.partitionRelations 的调用方式：重算 score + 按 recentHours 识别新兴 */
  function partition(relations: Relation[], config = DEFAULT_PARTITION_CONFIG) {
    const items = relations.map((r) => ({
      ...r,
      score: calculateScore(r.useCount, r.lastUsedTime, now, config.halfLifeHours),
    }));
    const threshold = config.recentHours * H;
    const emergingIds = new Set(
      items.filter((r) => r.lastUsedTime && now - r.lastUsedTime < threshold).map((r) => r.id)
    );
    return partitionByScore(items, {
      getId: (r) => r.id,
      getScore: (r) => r.score,
      isEmerging: (r) => emergingIds.has(r.id),
      getEmergingSortScore: (r) => r.lastUsedTime ?? 0,
    }, config);
  }

  const idSet = (arr: Relation[]) => new Set(arr.map((r) => r.id));

  it('基本分区功能', () => {
    const items = [
      makeRelation('r1', 10, 0.1),  // 高分
      makeRelation('r2', 5, 1),     // 中分
      makeRelation('r3', 2, 48),    // 低分
      makeRelation('r4', 1, 168),   // 很低
    ];

    const result = partition(items);
    assert.ok(result.hot.length >= 1);
    assert.strictEqual(result.hot.length + result.warm.length + result.cold.length, 4);
  });

  it('分区守恒：跨越热区上限阈值时条目不会凭空消失（回归 2026-09-04 P0）', () => {
    // N=34 是默认配置（maxHotCount=10, hotPercent=0.3）下首个触发截断的规模；
    // 修复前 N=34 丢 1 条、N=120 丢 36 条（被截断项既不在 hot 也不在 warm/cold）
    for (const n of [1, 10, 33, 34, 40, 100, 120]) {
      const items = Array.from({ length: n }, (_, i) => makeRelation(`r${i}`, 1 + (i % 9), 100 + i));
      const result = partition(items);
      const total = result.hot.length + result.warm.length + result.cold.length;
      const seen = new Set([...idSet(result.hot), ...idSet(result.warm), ...idSet(result.cold)]);
      assert.strictEqual(total, n, `N=${n} 三区之和应等于输入总数`);
      assert.strictEqual(seen.size, n, `N=${n} 不应有条目在所有分区都查不到`);
    }
  });

  it('热区上限截断生效，溢出项回流常温/冷区', () => {
    const items = Array.from({ length: 20 }, (_, i) => makeRelation(`r${i}`, 10 - i * 0.5, 100 + i));

    const result = partition(items, { ...DEFAULT_PARTITION_CONFIG, maxHotCount: 3 });
    assert.ok(result.hot.length <= 3);
    assert.strictEqual(result.hot.length + result.warm.length + result.cold.length, 20);

    const hotIds = idSet(result.hot);
    const rest = new Set([...idSet(result.warm), ...idSet(result.cold)]);
    for (const r of items) {
      if (!hotIds.has(r.id)) assert.ok(rest.has(r.id), `${r.id} 被挤出热区后应在常温或冷区`);
    }
  });

  it('回流不改变热区语义：hot 仍是全局评分最高的那批', () => {
    const items = Array.from({ length: 40 }, (_, i) => makeRelation(`r${i}`, 1 + (i % 9), 100 + i));
    const result = partition(items);

    const top10 = items
      .map((r) => ({ id: r.id, score: calculateScore(r.useCount, r.lastUsedTime, now, 24) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.id)
      .sort();
    assert.deepStrictEqual(result.hot.map((r) => r.id).sort(), top10);
  });

  it('maxHotCount=0 表示热区不展示（而非退化为不限制）', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeRelation(`z${i}`, 5, 100 + i));
    const result = partition(items, { ...DEFAULT_PARTITION_CONFIG, maxHotCount: 0 });
    assert.strictEqual(result.hot.length, 0);
    assert.strictEqual(result.warm.length + result.cold.length, 10);
  });

  it('maxWarmCount 截断的溢出项回流冷区', () => {
    const items = Array.from({ length: 120 }, (_, i) => makeRelation(`w${i}`, 1 + (i % 9), 100 + i));
    const result = partition(items, { ...DEFAULT_PARTITION_CONFIG, maxWarmCount: 5 });
    assert.ok(result.warm.length <= 5);
    assert.strictEqual(result.hot.length + result.warm.length + result.cold.length, 120);
  });

  it('全新兴场景（recentHours 内全部使用过）仍守恒', () => {
    // reservedEmerging=10 与 maxHotCount=10 相等时，新兴席位可占满热区，
    // 修复前被挤出的新兴条目会同样凭空消失
    const items = Array.from({ length: 40 }, (_, i) => makeRelation(`e${i}`, 5, i * 0.5));
    const result = partition(items);
    assert.strictEqual(result.hot.length + result.warm.length + result.cold.length, 40);
    assert.strictEqual(result.emergingSet.size, 40);
    assert.strictEqual(result.hot.length, DEFAULT_PARTITION_CONFIG.maxHotCount);
  });

  it('maxColdCount 是守恒不变量的唯一例外：仅截断评分最低的冷区末端', () => {
    const items = Array.from({ length: 120 }, (_, i) => makeRelation(`c${i}`, 1 + (i % 9), 100 + i));
    const result = partition(items, { ...DEFAULT_PARTITION_CONFIG, maxColdCount: 5 });

    assert.strictEqual(result.cold.length, 5);
    assert.strictEqual(result.hot.length, 10);  // 热区上限不受冷区配置影响
    assert.strictEqual(result.warm.length, 50); // 常温上限（已含热区溢出回流）

    const kept = new Set([...result.hot, ...result.warm, ...result.cold].map((r) => r.id));
    const discarded = items.filter((r) => !kept.has(r.id));
    assert.strictEqual(discarded.length, 55, '超出冷区上限的末端条目按配置丢弃');

    // 丢弃的必须是评分最低的那批（不能误删热知识）
    const scoreOf = (r: Relation) => calculateScore(r.useCount, r.lastUsedTime, now, 24);
    const keptColdMin = Math.min(...result.cold.map(scoreOf));
    const discardedMax = Math.max(...discarded.map(scoreOf));
    assert.ok(discardedMax <= keptColdMin, '丢弃项评分不得高于保留的冷区项');
  });

  it('常温区以「热区之外的候选池」为基准（配比与热区规模解耦）', () => {
    const items = Array.from({ length: 40 }, (_, i) => makeRelation(`p${i}`, 1 + (i % 9), 100 + i));
    const result = partition(items);
    const pool = items.length - result.hot.length;
    assert.strictEqual(result.warm.length, Math.ceil(pool * DEFAULT_PARTITION_CONFIG.warmPercent));
  });

  it('新兴数超过 maxHotCount 而触发截断：砍尾保留 recency 最新的新兴项', () => {
    // 覆盖此前无用例的路径：emergingHeldCount >= maxHotCount。
    // 15 个新兴（reservedEmerging=15 全部占席）+ 5 个分数更高的历史项。
    // 若将来把填充顺序改成「先历史后新兴」，高分历史项会占满前 10 席，
    // 下面的顺序断言会立即变红——这才是真正的护栏（而非恒等的 if/else 分支）。
    const items = [
      ...Array.from({ length: 15 }, (_, i) => makeRelation(`e${i}`, 3, 1 + i)),
      ...Array.from({ length: 5 }, (_, i) => makeRelation(`h${i}`, 10, 50 + i)),
    ];
    const result = partition(items, {
      ...DEFAULT_PARTITION_CONFIG, reservedEmerging: 15, maxHotCount: 10,
    });

    assert.strictEqual(result.hot.length, 10);
    // 顺序敏感：getEmergingSortScore 取 lastUsedTime 降序，hoursAgo 越小越新
    assert.deepStrictEqual(
      result.hot.map((r) => r.id),
      ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'],
      '热区必须是 recency 最新的 10 个新兴项，不得被高分历史项挤占'
    );

    // 被挤出的新兴项与未入热区的高分历史项都必须回流，不得消失
    assert.strictEqual(result.hot.length + result.warm.length + result.cold.length, 20);
    const rest = new Set([...result.warm, ...result.cold].map((r) => r.id));
    for (const id of ['e10', 'e11', 'e12', 'e13', 'e14', 'h0', 'h1', 'h2', 'h3', 'h4']) {
      assert.ok(rest.has(id), `${id} 应在常温或冷区`);
    }
    // 高分历史项按 score 排在候选池最前，占满常温区（warmCount = ceil(10 * 0.5) = 5）
    assert.deepStrictEqual(result.warm.map((r) => r.id), ['h0', 'h1', 'h2', 'h3', 'h4']);
    assert.deepStrictEqual(result.cold.map((r) => r.id), ['e10', 'e11', 'e12', 'e13', 'e14']);
  });

  it('新兴热区保留席位：低分新条目不被历史高分挤出', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) => makeRelation(`new${i}`, 1, i + 1)),
      ...Array.from({ length: 17 }, (_, i) => makeRelation(`old${i}`, 9, 100 + i)),
    ];
    const result = partition(items);

    const hotIds = idSet(result.hot);
    for (const id of ['new0', 'new1', 'new2']) {
      assert.ok(hotIds.has(id), `${id} 应占新兴保留席位`);
    }
    assert.strictEqual(result.emergingSet.size, 3);
  });

  it('新兴热区基于最近使用，不区分 isImported', () => {
    const items = [
      makeRelation('imported', 10, 1, true), // 导入的，最近使用
      makeRelation('native', 5, 2, false),   // 原生的，最近使用
    ];

    const result = partition(items, { ...DEFAULT_PARTITION_CONFIG, reservedEmerging: 5 });
    const hotIds = idSet(result.hot);
    assert.ok(hotIds.has('imported'), 'imported item should be in hot (emerging)');
    assert.ok(hotIds.has('native'), 'native item should be in hot (emerging)');
  });

  it('导入态条目（useCount=0/lastUsedTime=null）不计入新兴，评分为 0', () => {
    const items = [
      makeRelation('imp', 0, null, true),
      makeRelation('used', 1, 0.1),
    ];
    const result = partition(items);
    assert.ok(!result.emergingSet.has('imp'));
    assert.ok(result.emergingSet.has('used'));
  });

  it('重复 id 全部落在热区外时不丢条目（输入违约兜底）', () => {
    // getId 唯一是守恒前提；违约时的兜底表现需明确锁定，避免将来无意改回「静默丢弃」。
    // 注意重复 id 有两种情形（详见 partitionByScore JSDoc），本用例只锁情形②：
    // 重复项必须**全部落在热区之外**（热区席位被高分项占满）——这是唯一能区分
    // 「候选池是否对池内重复项二次去重」的场景；若重复项有一个进了热区（情形①），
    // 其 id 会被 seen 挡掉，去重与不去重两种实现结果相同。
    const items = [
      makeRelation('p', 10, 10), makeRelation('q', 9, 10),
      makeRelation('x', 3, 10), makeRelation('x', 1, 10),
    ];
    const result = partitionByScore(items, {
      getId: (r) => r.id,
      getScore: (r) => calculateScore(r.useCount, r.lastUsedTime, now, 24),
      isEmerging: () => false,
    }, DEFAULT_PARTITION_CONFIG);

    // 热区仍按 id 去重（totalHotSeats = max(1, ceil(4*0.3)) = 2）
    assert.deepStrictEqual(result.hot.map((r) => r.id), ['p', 'q']);
    // 守恒不破：三区之和 == 输入长度（重构前为 3，x 的第二条被静默丢弃）
    assert.strictEqual(
      result.hot.length + result.warm.length + result.cold.length, items.length,
      '情形②下不得静默丢条目'
    );
  });

  it('重复 id 有一个入热区时，其余同 id 项被丢弃（输入违约情形①）', () => {
    // 锁定 JSDoc 描述的情形①：与上例相反，此时**不守恒**属预期行为（非本次重构引入）。
    // 4 条但只有 2 个唯一 id，且两个 id 都能进热区（totalHotSeats=2）→ 候选池为空。
    const items = [
      makeRelation('a', 9, 100), makeRelation('a', 5, 110),
      makeRelation('b', 3, 120), makeRelation('b', 1, 130),
    ];
    const result = partitionByScore(items, {
      getId: (r) => r.id,
      getScore: (r) => calculateScore(r.useCount, r.lastUsedTime, now, 24),
      isEmerging: () => false,
    }, DEFAULT_PARTITION_CONFIG);

    assert.deepStrictEqual(result.hot.map((r) => r.id), ['a', 'b']);
    assert.strictEqual(result.warm.length + result.cold.length, 0, '同 id 项已全部被热区去重挡下');
    assert.strictEqual(
      result.hot.length + result.warm.length + result.cold.length, 2,
      '情形①下三区之和为唯一 id 数（< items.length），属违约兜底而非缺陷'
    );
  });

  it('纯函数：不修改输入数组与条目', () => {
    const items = Array.from({ length: 40 }, (_, i) => makeRelation(`r${i}`, 1 + (i % 9), 100 + i));
    const snapshot = items.map((r) => ({ ...r }));

    partition(items);

    assert.deepStrictEqual(items, snapshot);
  });
});
