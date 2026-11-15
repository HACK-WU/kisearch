/**
 * governance-contract.test.ts —— 知识治理契约层（B0 门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-contract.test.ts
 *
 * 覆盖：
 *   ① 前后端 DTO 形状一致（接口名 + 每个字段名与可选性）；
 *   ② 错误码唯一且落在登记号段内；
 *   ③ `resolveLifecycle` 的缺省与不一致诊断；
 *   ④ `validateLifecycleInput` 的六条校验分支；
 *   ⑤ 回收站设置校验。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { GOVERNANCE_CODE_NUMBERS } from '../src/lib/governance-errors.js';
import {
  resolveLifecycle,
  validateLifecycleInput,
  findExpiredTemp,
  remainDays,
  ttlDaysToExpiresAt,
} from '../src/lib/lifecycle.js';
import { validateTrashSettings, TRASH_KEEP_DAYS, BUILTIN_PRESETS } from '../src/lib/governance-store.js';

const ROOT = process.cwd();

/** 提取 `export interface X { ... }` 的字段名（含 `?` 标记），忽略行内嵌套对象 */
function parseInterfaces(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /export interface\s+(\w+)(?:<[^>]*>)?\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields: string[] = [];
    for (const line of body.split('\n')) {
      const fm = line.match(/^\s{2}(\w+)(\?)?:/);
      if (fm) fields.push(fm[2] ? `${fm[1]}?` : fm[1]);
    }
    out.set(name, fields);
  }
  return out;
}

const backendSrc = fs.readFileSync(path.join(ROOT, 'src/lib/governance-contract.ts'), 'utf8');
const frontendSrc = fs.readFileSync(path.join(ROOT, 'web/src/api/governanceContract.ts'), 'utf8');

describe('① 前后端 DTO 形状一致', () => {
  const backend = parseInterfaces(backendSrc);
  const frontend = parseInterfaces(frontendSrc);

  it('接口名集合一致', () => {
    assert.ok(backend.size > 20, `后端接口应 >20 个，实际 ${backend.size}`);
    assert.deepEqual([...frontend.keys()].sort(), [...backend.keys()].sort());
  });

  it('每个接口的字段名与可选性一致', () => {
    const diffs: string[] = [];
    for (const [name, fields] of backend) {
      const other = frontend.get(name);
      if (!other) { diffs.push(`${name}: 前端缺失`); continue; }
      if (fields.join(',') !== other.join(',')) {
        diffs.push(`${name}\n  后端: ${fields.join(',')}\n  前端: ${other.join(',')}`);
      }
    }
    assert.equal(diffs.length, 0, `字段漂移：\n${diffs.join('\n')}`);
  });
});

describe('② 错误码登记', () => {
  const entries = Object.entries(GOVERNANCE_CODE_NUMBERS);

  it('号唯一', () => {
    const nums = entries.map(([, n]) => n);
    assert.equal(new Set(nums).size, nums.length, '存在重复号');
  });

  it('全部落在 1000-1599（1000-1499 = 业务分段，1500-1599 = 通用/传输层）', () => {
    for (const [code, n] of entries) {
      assert.ok(n >= 1000 && n <= 1599, `${code}=${n} 超出登记号段`);
    }
  });

  it('通用段只放传输层错误（防止把业务错误塞进 15xx 绕过分段约定）', () => {
    const generic = entries.filter(([, n]) => n >= 1500).map(([code]) => code).sort();
    assert.deepEqual(generic, ['DOC_NOT_FOUND', 'FORBIDDEN_SCOPE']);
  });

  it('分段归属正确（抽查关键码）', () => {
    assert.equal(GOVERNANCE_CODE_NUMBERS.LIFECYCLE_INVALID, 1001);
    assert.equal(GOVERNANCE_CODE_NUMBERS.TTL_REQUIRED, 1003);
    assert.equal(GOVERNANCE_CODE_NUMBERS.EVENT_CLOSED, 1102);
    assert.equal(GOVERNANCE_CODE_NUMBERS.VISIBILITY_PARTIAL, 1202);
    assert.equal(GOVERNANCE_CODE_NUMBERS.RESTORE_NAME_CONFLICT, 1303);
    assert.equal(GOVERNANCE_CODE_NUMBERS.REF_ALREADY_ADDED, 1402);
  });
});

describe('③ resolveLifecycle', () => {
  it('未传 → wiki，且不标记不一致', () => {
    assert.deepEqual(resolveLifecycle({}), { kind: 'wiki', inconsistent: false });
  });

  it('temp 带 expiresAt → 正常', () => {
    const r = resolveLifecycle({ lifecycle: 'temp', expiresAt: 1000, ttlDays: 30 });
    assert.equal(r.kind, 'temp');
    assert.equal(r.expiresAt, 1000);
    assert.equal(r.ttlDays, 30);
    assert.equal(r.inconsistent, false);
  });

  it('temp 缺 expiresAt → 仍返回 temp 但标诊断', () => {
    const r = resolveLifecycle({ lifecycle: 'temp' });
    assert.equal(r.kind, 'temp');
    assert.equal(r.inconsistent, true);
    assert.match(r.reason ?? '', /expiresAt/);
  });

  it('event 缺 eventId → 标诊断', () => {
    const r = resolveLifecycle({ lifecycle: 'event' });
    assert.equal(r.kind, 'event');
    assert.equal(r.inconsistent, true);
  });

  it('wiki 带残留字段 → 标诊断', () => {
    const r = resolveLifecycle({ lifecycle: 'wiki', expiresAt: 1 });
    assert.equal(r.inconsistent, true);
    assert.match(r.reason ?? '', /expiresAt/);
  });

  it('未知值 → 回落 wiki 并标诊断', () => {
    const r = resolveLifecycle({ lifecycle: 'temporary' });
    assert.equal(r.kind, 'wiki');
    assert.equal(r.inconsistent, true);
  });
});

describe('④ validateLifecycleInput', () => {
  const NOW = 1_700_000_000_000;

  it('什么都没传 → specified=false', () => {
    const r = validateLifecycleInput({}, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.specified, false);
  });

  it('temp 缺 ttl_days → TTL_REQUIRED', () => {
    const r = validateLifecycleInput({ lifecycle: 'temp' }, NOW);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'TTL_REQUIRED');
  });

  it('ttl_days 越界 → TTL_INVALID', () => {
    for (const bad of [0, -1, 366, 1.5]) {
      const r = validateLifecycleInput({ lifecycle: 'temp', ttlDays: bad }, NOW);
      assert.equal(r.ok, false, `ttl=${bad} 应被拒`);
      assert.equal(r.ok === false && r.code, 'TTL_INVALID');
    }
  });

  it('temp 合法 → 换算出 expiresAt', () => {
    const r = validateLifecycleInput({ lifecycle: 'temp', ttlDays: 30 }, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.kind, 'temp');
    assert.equal(r.ok && r.expiresAt, ttlDaysToExpiresAt(30, NOW));
  });

  it('wiki 带 ttl_days → 冲突', () => {
    const r = validateLifecycleInput({ lifecycle: 'wiki', ttlDays: 7 }, NOW);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'LIFECYCLE_ARG_CONFLICT');
  });

  it('event 缺 eventId → EVENT_REQUIRED；带 ttl 也冲突', () => {
    const missing = validateLifecycleInput({ lifecycle: 'event' }, NOW);
    assert.equal(missing.ok === false && missing.code, 'EVENT_REQUIRED');
    const conflict = validateLifecycleInput({ lifecycle: 'event', ttlDays: 7, eventId: 'evt_1' }, NOW);
    assert.equal(conflict.ok === false && conflict.code, 'LIFECYCLE_ARG_CONFLICT');
  });

  it('未给 lifecycle 但给 eventId → 推断为 event', () => {
    const r = validateLifecycleInput({ eventId: 'evt_x' }, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.kind, 'event');
  });

  it('非法 lifecycle → LIFECYCLE_INVALID', () => {
    const r = validateLifecycleInput({ lifecycle: 'forever' }, NOW);
    assert.equal(r.ok === false && r.code, 'LIFECYCLE_INVALID');
  });
});

describe('⑤ 过期查询与回收站设置', () => {
  it('findExpiredTemp 只挑已到期 temp', () => {
    const now = 1000;
    const rows = [
      { lifecycle: 'temp', expiresAt: 999 },
      { lifecycle: 'temp', expiresAt: 1001 },
      { lifecycle: 'wiki' },
      { lifecycle: 'temp' },
    ];
    assert.equal(findExpiredTemp(rows, now).length, 1);
  });

  it('remainDays 向下取整且不为负', () => {
    const now = 0;
    assert.equal(remainDays(2 * 86_400_000, now), 2);
    assert.equal(remainDays(0, now), 0);
    assert.equal(remainDays(-5, now), 0);
  });

  it('保留天数只允许 3/7/14/30', () => {
    assert.deepEqual([...TRASH_KEEP_DAYS], [3, 7, 14, 30]);
    assert.equal(validateTrashSettings({ keepDays: 5 as never }).ok, false);
    assert.equal(validateTrashSettings({ expireAction: 'delete' as never }).ok, false);
    const ok = validateTrashSettings({ keepDays: 14, expireAction: 'notify' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok && ok.value, { keepDays: 14, expireAction: 'notify' });
  });

  it('内置预设 3 项且 id 稳定', () => {
    assert.equal(BUILTIN_PRESETS.length, 3);
    assert.deepEqual(BUILTIN_PRESETS.map((p) => p.id), [
      'preset_builtin_wiki',
      'preset_builtin_temp7',
      'preset_builtin_temp30',
    ]);
  });
});
