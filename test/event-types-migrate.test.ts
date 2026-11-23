/**
 * event-types-migrate.test.ts —— 技术债阶段迁移（REQ-20261123-007 · S-03）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/event-types-migrate.test.ts
 *
 * 迁移是**动用户数据**的动作，六条口径必须逐条钉住：
 *   ① 两阶段 → 四阶段，插入位置在「待处理」之后，可见性与另外三条内置同构
 *   ② 幂等：重复执行返回 skipped，且不推进 revision
 *   ③ 半迁移（只缺一条）只插一条
 *   ④ 已有阶段 stageKey 不变（事件位置靠它，动了就是数据漂移）
 *   ⑤ dry-run 不写盘
 *   ⑥ 库里没有技术债时跳过
 *
 * ⚠️ 必须**直接写 `_types.json`** 造「老库」：走 createType 会拿到内置 4 条快照，
 * 技术债天生就是 4 阶段，测不出迁移。
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { listTypes, updateType } from '../src/lib/events/type-service.js';
import { writeTypesDoc } from '../src/lib/events/store.js';
import { migrateTechDebtStages } from '../src/lib/events/migrate-tech-debt.js';
import { getKbDir } from '../src/lib/scope.js';
import type { EventTypeRecord } from '../src/lib/events/types.js';

const scope = `evt-migrate-${Date.now()}`;
registerTestScope(scope);
after(() => cleanupTestConfig());

function typesFile(s: string): string {
  return path.join(getKbDir(s), '.events', '_types.json');
}

/** 造一个「老库」：盘上已有两阶段的技术债（模拟用户在本需求之前自建的那份） */
function seedTwoStageDebt(s: string, stages = ['待处理', '已收敛']): void {
  const now = Date.now();
  const vis = ['hidden', 'full'] as const;
  const record: EventTypeRecord = {
    id: 'et_4',
    scope: s,
    name: '技术债',
    builtin: false,
    stages: stages.map((name, i) => ({
      key: `st_${i + 1}`,
      name,
      // 中间阶段（已排期 / 偿还中）按内置口径给 fts-only，其余按原两阶段的 hidden / full
      visibility: i === 0 ? 'hidden' : i === stages.length - 1 ? 'full' : (vis[1] === 'full' ? 'fts-only' : 'full'),
    })),
    terminalAction: 'keep',
    fallbackDays: 90,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  writeTypesDoc(s, { version: 1, revision: 1, types: [record] });
}

function debtOf(s: string): EventTypeRecord {
  return listTypes(s).find((t) => t.name === '技术债')!;
}

describe('技术债阶段迁移', () => {
  beforeEach(() => seedTwoStageDebt(scope));

  it('① 两阶段 → 四阶段，插在「待处理」之后，可见性与内置同构', async () => {
    assert.deepEqual(debtOf(scope).stages.map((s) => s.name), ['待处理', '已收敛']);

    const res = await migrateTechDebtStages(scope);
    assert.deepEqual(res.added, ['已排期', '偿还中']);
    assert.deepEqual(res.stagesAfter, ['待处理', '已排期', '偿还中', '已收敛']);

    const after = debtOf(scope);
    assert.deepEqual(after.stages.map((s) => s.name), ['待处理', '已排期', '偿还中', '已收敛']);
    assert.deepEqual(
      after.stages.map((s) => s.visibility),
      ['hidden', 'fts-only', 'fts-only', 'full'],
      '可见性必须与另外三条内置一致：起始藏、进行中仅全文、终态全开',
    );
    assert.ok(res.backupPath, '写盘前必须留备份');
    assert.ok(fs.existsSync(res.backupPath!), '备份文件应真实存在');
  });

  it('② 幂等：重复执行只返回 skipped，且不推进 revision', async () => {
    await migrateTechDebtStages(scope);
    const first = debtOf(scope);

    const res = await migrateTechDebtStages(scope);
    assert.equal(res.skipped, '已迁移');

    const second = debtOf(scope);
    assert.equal(second.stages.length, 4);
    assert.equal(second.revision, first.revision, 'skipped 不得推进 revision');
  });

  it('③ 半迁移（只缺「偿还中」）只插一条', async () => {
    seedTwoStageDebt(scope, ['待处理', '已排期', '已收敛']);
    const cur = debtOf(scope);
    await updateType(scope, cur.id, {
      revision: cur.revision,
      stages: [
        { key: 'st_1', name: '待处理', visibility: 'hidden' },
        { key: 'st_2', name: '已排期', visibility: 'fts-only' },
        { key: 'st_3', name: '已收敛', visibility: 'full' },
      ],
    });

    const res = await migrateTechDebtStages(scope);
    assert.deepEqual(res.added, ['偿还中']);
    assert.deepEqual(res.stagesAfter, ['待处理', '已排期', '偿还中', '已收敛']);
  });

  it('④ 已有阶段的 stageKey 不变', async () => {
    const keyByName = new Map(debtOf(scope).stages.map((s) => [s.name, s.key]));
    await migrateTechDebtStages(scope);

    for (const stage of debtOf(scope).stages) {
      if (keyByName.has(stage.name)) {
        assert.equal(stage.key, keyByName.get(stage.name), `「${stage.name}」的 key 被改动了`);
      }
    }
  });

  it('⑤ dry-run 不写盘', async () => {
    const file = typesFile(scope);
    const before = fs.readFileSync(file, 'utf-8');

    const res = await migrateTechDebtStages(scope, { dryRun: true });
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.stagesAfter, ['待处理', '已排期', '偿还中', '已收敛']);
    assert.equal(fs.readFileSync(file, 'utf-8'), before, 'dry-run 不得修改 _types.json');
  });

  it('⑥ 库里没有「技术债」类型时跳过', async () => {
    const other = `evt-migrate-none-${Date.now()}`;
    registerTestScope(other);
    const now = Date.now();
    writeTypesDoc(other, {
      version: 1,
      revision: 1,
      types: [{
        id: 'et_9', scope: other, name: '只有这个', builtin: false,
        stages: [
          { key: 'st_1', name: 'A', visibility: 'hidden' },
          { key: 'st_2', name: 'B', visibility: 'full' },
        ],
        terminalAction: 'keep', fallbackDays: 90, revision: 1, createdAt: now, updatedAt: now,
      }],
    });

    const res = await migrateTechDebtStages(other);
    assert.match(String(res.skipped), /没有「技术债」类型/);
  });
});
