/**
 * analysis-save-edits.test.ts —— 人工校正写入口（saveDraftEdits）单测
 * REQ-20261123-001 · S01 批 2
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-save-edits.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import { startEventAnalysis } from '../../src/lib/events/analysis-runner.js';
import {
  readAnalysisDocRaw,
  saveDraftEdits,
  writeDraftStart,
} from '../../src/lib/events/analysis-store.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';

const scope = `ana-save-edits-${Date.now()}`;
let tmpDir = '';
let repoDir = '';
let cfg: never;
const deps = (): { loadConfigFn: () => never } => ({ loadConfigFn: () => cfg });

before(() => {
  registerTestScope(scope);
  initScope(scope);
  tmpDir = fs.mkdtempSync('/tmp/ki-save-edits-');
  repoDir = `${tmpDir}/repo`;
  fs.mkdirSync(`${repoDir}/src`, { recursive: true });
  // 12 行，够测越界（行号 13 应被验真拒绝）
  fs.writeFileSync(
    `${repoDir}/src/app.ts`,
    Array.from({ length: 12 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'),
    'utf8',
  );
  const chatDir = `${tmpDir}/chat`;
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(`${chatDir}/prompt-config.json`, JSON.stringify({
    version: 1,
    analysis: { targetDirs: { byScope: { [scope]: repoDir }, defaultDir: '' } },
  }), 'utf8');
  cfg = {
    dataDir: `${tmpDir}/data`,
    chatDir,
    llm: { baseURL: 'http://localhost', model: 'test', apiKey: 'k', kbDisclosureAck: true, supportsTools: true },
  } as never;
});

after(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

async function seedDraft(eventId: string, patch: Record<string, unknown> = {}): Promise<void> {
  await writeDraftStart(scope, eventId, {
    runId: 'run_seed',
    status: 'ready',
    targetDir: repoDir,
    commit: 'abc1234',
    conclusion: '原始结论',
    chain: [{ kind: 'symptom', text: '原始现象' }],
    candidates: [],
    unconfirmed: ['原始疑问'],
    steps: [],
    stats: { turns: 1, filesRead: 0, tokens: 0, ms: 0 },
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  } as never);
}

const isCode = (code: string) => (e: unknown): boolean =>
  e instanceof GovernanceError && e.code === code;

describe('saveDraftEdits：写入与修订标识', () => {
  it('① 三块一起改：落盘一致 + editedAt 出现', async () => {
    const ev = await createEvent(scope, { title: '正常保存', typeId: 'et_1' });
    await seedDraft(ev.id);
    const now = Date.now();
    const doc = await saveDraftEdits(scope, ev.id, {
      expectedRunId: 'run_seed',
      conclusion: '改后的结论',
      chain: [{ kind: 'root', text: '改后的根因', branches: ['条件A'] }],
      unconfirmed: ['改后的疑问'],
    }, now, deps());

    assert.equal(doc.draft?.conclusion, '改后的结论');
    assert.deepEqual(doc.draft?.chain, [{ kind: 'root', text: '改后的根因', branches: ['条件A'] }]);
    assert.deepEqual(doc.draft?.unconfirmed, ['改后的疑问']);
    assert.equal(doc.draft?.editedAt, now);
    // 回读一致（真正落盘而不是只返回对象）
    assert.equal(readAnalysisDocRaw(scope, ev.id).draft?.conclusion, '改后的结论');
  });

  it('② 空 patch 不写盘：editedAt / updatedAt 都不动', async () => {
    const ev = await createEvent(scope, { title: '空 patch', typeId: 'et_1' });
    await seedDraft(ev.id);
    const before = readAnalysisDocRaw(scope, ev.id);
    const doc = await saveDraftEdits(scope, ev.id, {}, Date.now() + 1000, deps());
    assert.equal(doc.draft?.editedAt, undefined);
    assert.equal(doc.draft?.updatedAt, before.draft?.updatedAt);
    assert.equal(readAnalysisDocRaw(scope, ev.id).draft?.editedAt, undefined);
  });

  it('③ 清空三块：draft 仍存在（不置 null），editedAt 有值', async () => {
    const ev = await createEvent(scope, { title: '清空', typeId: 'et_1' });
    await seedDraft(ev.id);
    const doc = await saveDraftEdits(scope, ev.id, {
      conclusion: null,
      chain: [],
      unconfirmed: [],
    }, Date.now(), deps());
    assert.notEqual(doc.draft, null);
    assert.equal(doc.draft?.conclusion, null);
    assert.deepEqual(doc.draft?.chain, []);
    assert.deepEqual(doc.draft?.unconfirmed, []);
    assert.equal(typeof doc.draft?.editedAt, 'number');
  });
});

describe('saveDraftEdits：并发与运行中', () => {
  it('④ expectedRunId 不匹配 → REVISION_CONFLICT（磁盘不变）', async () => {
    const ev = await createEvent(scope, { title: '冲突', typeId: 'et_1' });
    await seedDraft(ev.id);
    await assert.rejects(
      saveDraftEdits(scope, ev.id, { expectedRunId: 'run_other', conclusion: 'x' }, Date.now(), deps()),
      isCode('REVISION_CONFLICT'),
    );
    assert.equal(readAnalysisDocRaw(scope, ev.id).draft?.conclusion, '原始结论');
  });

  it('⑤ expectedRunId=null 但已有草稿 → REVISION_CONFLICT', async () => {
    const ev = await createEvent(scope, { title: '期望无草稿', typeId: 'et_1' });
    await seedDraft(ev.id);
    await assert.rejects(
      saveDraftEdits(scope, ev.id, { expectedRunId: null, conclusion: 'x' }, Date.now(), deps()),
      isCode('REVISION_CONFLICT'),
    );
  });

  it('⑥ 运行中禁改 → ANALYSIS_ALREADY_RUNNING', async () => {
    const ev = await createEvent(scope, { title: '运行中', typeId: 'et_1' });
    await seedDraft(ev.id, { status: 'running' });
    await assert.rejects(
      saveDraftEdits(scope, ev.id, { conclusion: 'x' }, Date.now(), deps()),
      isCode('ANALYSIS_ALREADY_RUNNING'),
    );
  });
});

describe('saveDraftEdits：校验与新建', () => {
  it('⑦ 校验失败 → ANALYSIS_EDIT_INVALID，details.errors 带 field/index', async () => {
    const ev = await createEvent(scope, { title: '校验失败', typeId: 'et_1' });
    await seedDraft(ev.id);
    await assert.rejects(
      saveDraftEdits(scope, ev.id, {
        chain: [{ kind: 'symptom', text: 'ok' }, { kind: 'symptom', text: 'a'.repeat(201) }],
      }, Date.now(), deps()),
      (e: unknown) => {
        assert.ok(isCode('ANALYSIS_EDIT_INVALID')(e));
        const details = (e as GovernanceError).details as { errors: Array<{ field: string; index?: number }> };
        assert.equal(details.errors[0]!.field, 'chain');
        assert.equal(details.errors[0]!.index, 1);
        return true;
      },
    );
  });

  it('⑧ 无草稿保存 → 新建 manual 草稿（status=ready，editedAt 有值）', async () => {
    const ev = await createEvent(scope, { title: '无草稿新建', typeId: 'et_1' });
    const doc = await saveDraftEdits(scope, ev.id, {
      expectedRunId: null,
      conclusion: '人工写的第一条结论',
    }, Date.now(), deps());
    assert.match(doc.draft!.runId, /^manual_/);
    assert.equal(doc.draft?.status, 'ready');
    assert.equal(doc.draft?.conclusion, '人工写的第一条结论');
    assert.equal(doc.draft?.targetDir, repoDir);
    assert.equal(typeof doc.draft?.editedAt, 'number');
  });

  it('⑨ 未配置目标目录时无草稿保存 → ANALYSIS_TARGET_NOT_CONFIGURED', async () => {
    const ev = await createEvent(scope, { title: '无配置', typeId: 'et_1' });
    const emptyChat = `${tmpDir}/chat-empty`;
    fs.mkdirSync(emptyChat, { recursive: true });
    await assert.rejects(
      saveDraftEdits(scope, ev.id, { conclusion: 'x' }, Date.now(), {
        loadConfigFn: () => ({ dataDir: `${tmpDir}/data`, chatDir: emptyChat }) as never,
      }),
      isCode('ANALYSIS_TARGET_NOT_CONFIGURED'),
    );
  });
});

describe('saveDraftEdits：人工位置', () => {
  it('⑩ 真实位置：验真通过并生成 snippet，confidence=0（非 AI 判定）', async () => {
    const ev = await createEvent(scope, { title: '手工加位置', typeId: 'et_1' });
    await seedDraft(ev.id);
    const doc = await saveDraftEdits(scope, ev.id, {
      confirmedAdd: [{ file: 'src/app.ts', line: 3, why: '手工核对' }],
    }, Date.now(), deps());
    assert.equal(doc.confirmed.length, 1);
    const loc = doc.confirmed[0]!;
    assert.equal(loc.file, 'src/app.ts');
    assert.equal(loc.line, 3);
    assert.equal(loc.confidence, 0);
    assert.match(loc.snippet, /line3/);
    assert.equal(loc.why, '手工核对');
    assert.equal(loc.targetDir, repoDir);
  });

  it('⑪ 行号越界 / 路径不存在 → ANALYSIS_LOCATION_VERIFY_FAILED，且不落盘', async () => {
    const ev = await createEvent(scope, { title: '验真失败', typeId: 'et_1' });
    await seedDraft(ev.id);
    await assert.rejects(
      saveDraftEdits(scope, ev.id, {
        confirmedAdd: [{ file: 'src/app.ts', line: 99, why: '越界' }],
      }, Date.now(), deps()),
      isCode('ANALYSIS_LOCATION_VERIFY_FAILED'),
    );
    await assert.rejects(
      saveDraftEdits(scope, ev.id, {
        confirmedAdd: [{ file: 'src/none.ts', line: 1, why: '不存在' }],
      }, Date.now(), deps()),
      isCode('ANALYSIS_LOCATION_VERIFY_FAILED'),
    );
    assert.equal(readAnalysisDocRaw(scope, ev.id).confirmed.length, 0);
  });

  it('⑫ 同一位置重复加是幂等（不重复、不报错）', async () => {
    const ev = await createEvent(scope, { title: '重复加', typeId: 'et_1' });
    await seedDraft(ev.id);
    await saveDraftEdits(scope, ev.id, {
      confirmedAdd: [{ file: 'src/app.ts', line: 5, why: '一' }],
    }, Date.now(), deps());
    const doc = await saveDraftEdits(scope, ev.id, {
      confirmedAdd: [{ file: 'src/app.ts', line: 5, why: '二' }],
    }, Date.now(), deps());
    assert.equal(doc.confirmed.length, 1);
  });

  it('⑬ 改理由：命中则更新，未命中 → ANALYSIS_LOCATION_NOT_FOUND', async () => {
    const ev = await createEvent(scope, { title: '改理由', typeId: 'et_1' });
    await seedDraft(ev.id);
    const created = await saveDraftEdits(scope, ev.id, {
      confirmedAdd: [{ file: 'src/app.ts', line: 7, why: '旧理由' }],
    }, Date.now(), deps());
    const id = created.confirmed[0]!.id;
    const updated = await saveDraftEdits(scope, ev.id, {
      confirmedUpdate: [{ id, why: '新理由' }],
    }, Date.now(), deps());
    assert.equal(updated.confirmed[0]!.why, '新理由');
    await assert.rejects(
      saveDraftEdits(scope, ev.id, { confirmedUpdate: [{ id: 'loc_nope', why: 'x' }] }, Date.now(), deps()),
      isCode('ANALYSIS_LOCATION_NOT_FOUND'),
    );
  });

  it('⑭ 重置后（无草稿）仍可手工加位置 —— targetDir 由配置解析', async () => {
    const ev = await createEvent(scope, { title: '重置后加位置', typeId: 'et_1' });
    const doc = await saveDraftEdits(scope, ev.id, {
      confirmedAdd: [{ file: 'src/app.ts', line: 9, why: '重置后补' }],
    }, Date.now(), deps());
    assert.equal(doc.confirmed.length, 1);
    assert.equal(doc.draft?.targetDir, repoDir);
  });
});

describe('startEventAnalysis：有修订时重跑被拦（R-08）', () => {
  /** 没配 targetDirs 的配置：用它就能证明"闸门已放行（继续往下走到目录校验）"而不真的发起分析 */
  const noTargetCfg = (): never => ({
    dataDir: `${tmpDir}/data`,
    chatDir: `${tmpDir}/chat-empty`,
  }) as never;

  it('⑮ 纯文本结论 + 人工修订（无候选）→ 重跑被拦（旧闸门只看 candidates，会静默覆盖）', async () => {
    const ev = await createEvent(scope, { title: '有修订重跑', typeId: 'et_1' });
    await seedDraft(ev.id, { editedAt: Date.now(), candidates: [] });
    await assert.rejects(
      startEventAnalysis(scope, ev.id, { deps: { loadConfigFn: noTargetCfg as never } }),
      isCode('REVISION_CONFLICT'),
    );
  });

  it('⑯ forceOverwrite=true 越过闸门（错误变为目录未配置，证明不是被闸门挡的）', async () => {
    const ev = await createEvent(scope, { title: '确认覆盖', typeId: 'et_1' });
    await seedDraft(ev.id, { editedAt: Date.now(), candidates: [] });
    await assert.rejects(
      startEventAnalysis(scope, ev.id, {
        forceOverwrite: true,
        deps: { loadConfigFn: noTargetCfg as never },
      }),
      isCode('ANALYSIS_TARGET_NOT_CONFIGURED'),
    );
  });

  it('⑰ 无修订且无候选 → 不拦（继续走到目录校验）', async () => {
    const ev = await createEvent(scope, { title: '无修订', typeId: 'et_1' });
    await seedDraft(ev.id, { candidates: [] });
    await assert.rejects(
      startEventAnalysis(scope, ev.id, { deps: { loadConfigFn: noTargetCfg as never } }),
      isCode('ANALYSIS_TARGET_NOT_CONFIGURED'),
    );
  });
});

/*
 * 数据链路走 PATCH（2026-11-24 · S03 §3.2）：这条路径只有「采纳追问补丁」在用，
 * 编辑态 UI 不开放（H13）。守三件事：
 *   ① 传了 → 落盘（补丁采纳必须真能写进去，否则解析出来也白搭）；
 *   ② 不传 → 保留原值（补丁缺省语义，与外部上传相反）；
 *   ③ 口径是**宽松归一**：超限截断 + 提示行，不报错。
 */
describe('saveDraftEdits：数据链路（补丁采纳专用）', () => {
  const flow = '页面打开 → 取表清单\n    ▼\n逐表查询';

  it('⑱ 传 dataFlow → 落盘且能回读', async () => {
    const ev = await createEvent(scope, { title: '链路写入', typeId: 'et_1' });
    await seedDraft(ev.id, { dataFlow: '旧链路' });
    const doc = await saveDraftEdits(scope, ev.id, { expectedRunId: 'run_seed', dataFlow: flow }, Date.now(), deps());
    assert.equal(doc.draft?.dataFlow, flow);
    assert.equal(readAnalysisDocRaw(scope, ev.id).draft?.dataFlow, flow);
  });

  it('⑲ 不传 dataFlow → 保留旧值（只改结论不该动链路）', async () => {
    const ev = await createEvent(scope, { title: '链路保留', typeId: 'et_1' });
    await seedDraft(ev.id, { dataFlow: flow });
    const doc = await saveDraftEdits(scope, ev.id, { conclusion: '只换结论' }, Date.now(), deps());
    assert.equal(doc.draft?.conclusion, '只换结论');
    assert.equal(doc.draft?.dataFlow, flow, '不传 = 不改链路');
  });

  it('⑳ 传 null / 全空白 → 清空（键被删掉，不是写 null）', async () => {
    const ev = await createEvent(scope, { title: '链路清空', typeId: 'et_1' });
    await seedDraft(ev.id, { dataFlow: flow });
    const doc = await saveDraftEdits(scope, ev.id, { dataFlow: '   \n  ' }, Date.now(), deps());
    assert.equal(doc.draft?.dataFlow, undefined);
    assert.equal('dataFlow' in (readAnalysisDocRaw(scope, ev.id).draft as object), false, '落盘后不该留空串 / null');

    await seedDraft(ev.id, { dataFlow: flow, runId: 'run_second' });
    const cleared = await saveDraftEdits(scope, ev.id, { dataFlow: null, expectedRunId: 'run_second' }, Date.now(), deps());
    assert.equal(cleared.draft?.dataFlow, undefined);
  });

  it('㉑ 超 40 行 / 超 3000 字 → 宽松截断 + 提示行（不报错，补丁才不至于整份失效）', async () => {
    const ev = await createEvent(scope, { title: '链路截断', typeId: 'et_1' });
    await seedDraft(ev.id);
    const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 步`).join('\n');
    const doc = await saveDraftEdits(scope, ev.id, { dataFlow: long }, Date.now(), deps());
    const saved = doc.draft?.dataFlow ?? '';
    assert.equal(saved.split('\n').length, 41);
    assert.match(saved, /已截断/);
  });

  it('㉒ 非字符串 → 报错（这是调用方写错，不是"内容长了一点"）', async () => {
    const ev = await createEvent(scope, { title: '链路类型错', typeId: 'et_1' });
    await seedDraft(ev.id, { dataFlow: flow });
    await assert.rejects(
      () => saveDraftEdits(scope, ev.id, { dataFlow: 123 as never }, Date.now(), deps()),
      isCode('ANALYSIS_EDIT_INVALID'),
    );
    assert.equal(readAnalysisDocRaw(scope, ev.id).draft?.dataFlow, flow, '报错时旧值不动');
  });
});
