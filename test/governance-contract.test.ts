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

import { GOVERNANCE_CODE_NUMBERS, GovernanceError } from '../src/lib/governance-errors.js';
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

  it('全部落在 1000-1799（1000-1499 = 业务分段，1500-1599 = 通用/传输层，1600-1699 = 事件源码分析，1700-1799 = 治理视图聚合）', () => {
    for (const [code, n] of entries) {
      assert.ok(n >= 1000 && n <= 1799, `${code}=${n} 超出登记号段`);
    }
  });

  it('通用段只放传输层错误（防止把业务错误塞进 15xx 绕过分段约定）', () => {
    const generic = entries.filter(([, n]) => n >= 1500 && n < 1600).map(([code]) => code).sort();
    assert.deepEqual(generic, ['DOC_NOT_FOUND', 'FORBIDDEN_SCOPE']);
  });

  it('分段归属正确（抽查关键码）', () => {
    assert.equal(GOVERNANCE_CODE_NUMBERS.LIFECYCLE_INVALID, 1001);
    assert.equal(GOVERNANCE_CODE_NUMBERS.TTL_REQUIRED, 1003);
    assert.equal(GOVERNANCE_CODE_NUMBERS.EVENT_CLOSED, 1102);
    assert.equal(GOVERNANCE_CODE_NUMBERS.VISIBILITY_PARTIAL, 1202);
    assert.equal(GOVERNANCE_CODE_NUMBERS.RESTORE_NAME_CONFLICT, 1303);
    // 回收站参数类错误（2026-11-23）：dirName / group 非法必须与「条目不存在」分成不同码
    assert.equal(GOVERNANCE_CODE_NUMBERS.TRASH_BAD_DIRNAME, 1309);
    assert.equal(GOVERNANCE_CODE_NUMBERS.TRASH_GROUP_NO_CONTENT, 1311);
    assert.equal(GOVERNANCE_CODE_NUMBERS.REF_ALREADY_ADDED, 1402);
    // REQ-20261120-001：治理视图聚合独占 17xx，且**不得**塞进 15xx（上一条测试强制）
    assert.equal(GOVERNANCE_CODE_NUMBERS.SCOPE_MULTI_UNSUPPORTED, 1701);
    assert.equal(GOVERNANCE_CODE_NUMBERS.VIEW_NO_USABLE_MEMBER, 1702);
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

/**
 * 追问（B2）四个新码的 HTTP 状态：编号表只校验唯一性，不校验状态，
 * 漏登记 HTTP_STATUS 会静默回退 400（正是设计里列的那个风险）。
 */
describe("追问（B2）错误码状态映射", () => {
  it("1615~1618 的 err.status 与契约一致", () => {
    assert.equal(new GovernanceError("ANALYSIS_ASK_QUESTION_TOO_LONG", "x").status, 400);
    assert.equal(new GovernanceError("ANALYSIS_ASK_RATE_LIMITED", "x").status, 429);
    assert.equal(new GovernanceError("ANALYSIS_ASK_BUSY", "x").status, 429);
    assert.equal(new GovernanceError("ANALYSIS_ASK_TIMEOUT", "x").status, 504);
  });

  it("1627（主动停止）必须是 499 而不是 504 —— 停不是超时", () => {
    assert.equal(GOVERNANCE_CODE_NUMBERS.ANALYSIS_ASK_CANCELED, 1627);
    assert.equal(new GovernanceError("ANALYSIS_ASK_CANCELED", "x").status, 499);
  });
});

/**
 * 视角词表前后端一致（2026-11-20 · REQ-20261120-002）。
 *
 * 前端有一份渲染副本（web 端不复用 `src/**`，与 DTO 契约同一做法）。两处 `VIEW_LABELS`
 * 一旦漂移，用户看到的词就与喂给模型的词不同 —— 这正是 #48 那类「两份副本手工同步」的翻版。
 * 只比对象体（四个视角的 entries），不比类型注解（两边的 kind 类型别名不同名）。
 */
describe('⑥ 视角词表前后端一致', () => {
  const pick = (rel: string): string => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = src.match(/export const VIEW_LABELS[^{]*\{([\s\S]*?)\n\};/);
    assert.ok(m, `${rel} 缺少 VIEW_LABELS`);
    return m![1].replace(/\s+/g, ' ').trim();
  };

  it('四个视角的标签逐字一致', () => {
    const backend = pick('src/lib/events/analysis-view.ts');
    const frontend = pick('web/src/lib/analysisView.ts');
    assert.equal(frontend, backend, `视角词表漂移：\n后端: ${backend}\n前端: ${frontend}`);
  });

  it('内置类型 → 视角的映射逐行一致', () => {
    const backend = fs.readFileSync(path.join(ROOT, 'src/lib/events/analysis-view.ts'), 'utf8');
    const frontend = fs.readFileSync(path.join(ROOT, 'web/src/lib/analysisView.ts'), 'utf8');
    for (const line of ["et_1: 'fault'", "et_2: 'perf'", "et_3: 'change'"]) {
      assert.ok(backend.includes(line), `后端缺 ${line}`);
      assert.ok(frontend.includes(line), `前端缺 ${line}`);
    }
  });

  /*
   * 渲染四要素（强调点 / 清标 / 轨道 / 列宽）比词表更容易漂：词表有上面那条比对，
   * 而这几个字段分散在后端 `PROFILES` 与前端 `RENDER` 里，改一处不同步，卡片会
   * 「标签对了但高亮错位」，且没有任何编译错误。这里按视角逐个比对取值。
   */
  it('渲染四要素（emphasize / flag / rail / wide）逐视角一致', () => {
    const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const backend = read('src/lib/events/analysis-view.ts');
    const frontend = read('web/src/lib/analysisView.ts');

    /**
     * 截出某视角的配置块：后端跨多行（到 `\n  },`），前端是单行（到行尾）。
     * 必须从 PROFILES / RENDER **之后**开始找 —— 文件里先出现的 `fault: {` 是词表块，
     * 那里没有渲染四要素（首版就是踩了这个坑）。
     */
    const blockOf = (src: string, view: string, marker: string): string => {
      const from = src.indexOf(marker);
      assert.ok(from >= 0, `缺少标记 ${marker}`);
      const start = src.slice(from).search(new RegExp(`\\n  ${view}: \\{`));
      assert.ok(start >= 0, `缺少视角块 ${view}`);
      const rest = src.slice(from + start + 1);
      const end = rest.search(/\n {2}\},/);
      return end >= 0 ? rest.slice(0, end) : rest.split('\n')[0]!;
    };

    const fields = (block: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of block.matchAll(/\b(emphasize|flag|rail|wide):\s*([^,\n]+)/g)) {
        // 前端是单行对象，最后一个字段会连上 `}` —— 先切掉再统一去引号
        out[m[1]!] = m[2]!.trim().replace(/\s*\}.*$/, '').trim().replace(/^'|'$/g, '').replace(/^"|"$/g, '');
      }
      return out;
    };

    for (const view of ['fault', 'perf', 'change', 'generic']) {
      const b = fields(blockOf(backend, view, 'const PROFILES'));
      const f = fields(blockOf(frontend, view, 'const RENDER'));
      for (const key of ['emphasize', 'flag', 'rail', 'wide']) {
        assert.ok(b[key] !== undefined, `后端 ${view} 缺 ${key}`);
        assert.ok(f[key] !== undefined, `前端 ${view} 缺 ${key}`);
        assert.equal(f[key], b[key], `${view}.${key} 前后端漂移：后端=${b[key]} 前端=${f[key]}`);
      }
    }
  });
});
