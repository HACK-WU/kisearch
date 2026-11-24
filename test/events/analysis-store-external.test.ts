/**
 * analysis-store-external.test.ts —— 外部结论上传写入口（saveExternalAnalysis）
 * REQ-20261123-009 · S-01
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-store-external.test.ts
 *
 * 守的是 S-01 §3.3/§6 的语义：
 *   ① 产出形状：`source=external` / `importedAt` / **不设 `editedAt`** / `steps: []` / `stats` 全 0；
 *   ② 三道闸：running 拒绝 → expectedRunId → 覆盖权限（非外部草稿必须 `overwrite`）；
 *   ③ 严格校验：candidates 必填 ≥1、chain ≥1 节点、chain.ref ⊆ candidates、阈值不裁剪；
 *   ④ 验真：默认整批失败，`skipInvalidCandidates` 时剔除并记录，全无效时明确报错；
 *   ⑤ `targetDir` 只接受配置根（防两个基准让 ref 解析漂移）；
 *   ⑥ `confirmed[]` 覆盖结论时保留；
 *   ⑦ 读出口（`getEventDetail`）透出来源，供 MCP / 前端区分。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import {
  readAnalysisDocRaw,
  saveExternalAnalysis,
  writeDraftStart,
} from '../../src/lib/events/analysis-store.js';
import { getEventDetail } from '../../src/lib/events/event-detail.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';

const scope = `ana-external-${Date.now()}`;
let tmpDir = '';
let repoDir = '';
let cfg: never;
const deps = (): { loadConfigFn: () => never } => ({ loadConfigFn: () => cfg });

const isCode = (code: string) => (e: unknown): boolean =>
  e instanceof GovernanceError && (e as GovernanceError).code === code;

const BASE_CHAIN = [{ kind: 'root', text: '采样未按配置过滤', ref: 'src/app.ts:3' }];
const BASE_CANDS = [{ file: 'src/app.ts', line: 3, why: '采样过滤点', confidence: 0.9 }];

async function newEvent(): Promise<string> {
  const ev = await createEvent(scope, {
    title: `外部上传-${Math.random().toString(36).slice(2, 7)}`,
    typeId: 'et_1',
  });
  return ev.id;
}

async function seedDraft(eventId: string, patch: Record<string, unknown> = {}): Promise<void> {
  await writeDraftStart(scope, eventId, {
    runId: 'run_seed',
    status: 'ready',
    targetDir: repoDir,
    commit: null,
    conclusion: 'AI 原结论',
    chain: [{ kind: 'symptom', text: 'AI 原现象' }],
    candidates: [],
    unconfirmed: [],
    steps: [],
    stats: { turns: 1, filesRead: 0, tokens: 0, ms: 0 },
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  } as never);
}

function upload(eventId: string, extra: Record<string, unknown> = {}) {
  return saveExternalAnalysis(scope, eventId, {
    conclusion: '采样未过滤导致趋势图误判',
    chain: BASE_CHAIN,
    candidates: BASE_CANDS,
    unconfirmed: ['配置 22 的停用原因不在代码内'],
    sourceClient: 'mcp',
    ...extra,
  } as never, Date.now(), deps());
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
  tmpDir = fs.mkdtempSync('/tmp/ki-ext-analysis-');
  repoDir = `${tmpDir}/repo`;
  fs.mkdirSync(`${repoDir}/src`, { recursive: true });
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
  cfg = { dataDir: `${tmpDir}/data`, chatDir } as never;
});

after(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('产出形状', () => {
  it('① 落盘为 external：ext_ runId / importedAt / 不设 editedAt / steps=[] / stats 全 0', async () => {
    const id = await newEvent();
    const out = await upload(id);
    const d = out.doc.draft!;
    assert.equal(d.source, 'external');
    assert.equal(typeof d.importedAt, 'number');
    assert.equal(d.editedAt, undefined, '外部上传不是人工修订，不能打 editedAt');
    assert.deepEqual(d.steps, []);
    assert.deepEqual(d.stats, { turns: 0, filesRead: 0, tokens: 0, ms: 0 });
    assert.ok(d.runId.startsWith('ext_'));
    assert.equal(d.sourceClient, 'mcp');
    assert.equal(d.status, 'ready');
    assert.equal(out.overwritten, false);
  });

  it('② 候选经验真后**直接生效**：写进 confirmed、draft.candidates 清空、snippet 来自真实文件', async () => {
    const id = await newEvent();
    const out = await upload(id);
    assert.deepEqual(out.doc.draft!.candidates, [], '不再留「待确认」，否则页面会逼人再点一次确认');
    const loc = out.doc.confirmed[0]!;
    assert.equal(loc.file, 'src/app.ts');
    assert.equal(loc.line, 3);
    assert.ok(loc.snippet.length > 0, 'snippet 必须来自真实文件，不能是外部给的占位');
    assert.ok(loc.id.startsWith('loc_'));
    assert.equal(loc.confidence, 0.9);
    assert.equal(out.autoConfirmed, 1);
  });

  it('③ 缺省 confidence 用中性值 0.5（不伪造成 1.0）', async () => {
    const id = await newEvent();
    const out = await upload(id, { candidates: [{ file: 'src/app.ts', line: 3, why: '无置信度' }] });
    assert.equal(out.doc.confirmed[0]!.confidence, 0.5);
  });
});

describe('三道闸', () => {
  it('④ 分析进行中 → ANALYSIS_ALREADY_RUNNING', async () => {
    const id = await newEvent();
    await seedDraft(id, { runId: 'run_running', status: 'running' });
    await assert.rejects(() => upload(id), isCode('ANALYSIS_ALREADY_RUNNING'));
  });

  it('⑤ 已有 AI 结论且未带 overwrite → ANALYSIS_DRAFT_EXISTS', async () => {
    const id = await newEvent();
    await seedDraft(id);
    await assert.rejects(() => upload(id), isCode('ANALYSIS_DRAFT_EXISTS'));
    assert.equal(readAnalysisDocRaw(scope, id).draft?.conclusion, 'AI 原结论', '被拒时不能改盘上内容');
  });

  it('⑥ overwrite=true 才覆盖 AI 结论，且返回 overwritten=true', async () => {
    const id = await newEvent();
    await seedDraft(id);
    const out = await upload(id, { overwrite: true });
    assert.equal(out.overwritten, true);
    assert.equal(out.doc.draft?.conclusion, '采样未过滤导致趋势图误判');
    assert.equal(out.doc.draft?.source, 'external');
  });

  it('⑦ 外部草稿重传直接覆盖（幂等，无需 overwrite）', async () => {
    const id = await newEvent();
    await upload(id);
    const out = await upload(id, { conclusion: '第二版结论' });
    assert.equal(out.overwritten, true);
    assert.equal(out.doc.draft?.conclusion, '第二版结论');
  });

  it('⑧ expectedRunId 不符 → REVISION_CONFLICT（overwrite 不豁免）', async () => {
    const id = await newEvent();
    await seedDraft(id);
    await assert.rejects(
      () => upload(id, { overwrite: true, expectedRunId: 'run_other' }),
      isCode('REVISION_CONFLICT'),
    );
  });
});

describe('严格校验', () => {
  it('⑨ candidates 为空 → ANALYSIS_EDIT_INVALID（field=candidates）', async () => {
    const id = await newEvent();
    await assert.rejects(() => upload(id, { candidates: [] }), (e: unknown) => {
      assert.ok(e instanceof GovernanceError);
      assert.equal(e.code, 'ANALYSIS_EDIT_INVALID');
      const errors = (e.details as { errors: Array<{ field: string }> }).errors;
      assert.equal(errors[0]!.field, 'candidates');
      return true;
    });
  });

  it('⑩ chain 为空 → ANALYSIS_EDIT_INVALID（field=chain）', async () => {
    const id = await newEvent();
    await assert.rejects(() => upload(id, { chain: [] }), (e: unknown) => {
      assert.ok(e instanceof GovernanceError);
      assert.equal(e.code, 'ANALYSIS_EDIT_INVALID');
      const errors = (e.details as { errors: Array<{ field: string }> }).errors;
      assert.equal(errors[0]!.field, 'chain');
      return true;
    });
  });

  it('⑪ chain.ref 不在 candidates 内 → 报错（否则前端胶囊永远点不开）', async () => {
    const id = await newEvent();
    await assert.rejects(
      () => upload(id, { chain: [{ kind: 'root', text: '悬空引用', ref: 'src/app.ts:9' }] }),
      (e: unknown) => {
        assert.ok(e instanceof GovernanceError);
        assert.equal(e.code, 'ANALYSIS_EDIT_INVALID');
        const errors = (e.details as { errors: Array<{ field: string; reason: string }> }).errors;
        assert.equal(errors[0]!.field, 'chain');
        assert.ok(errors[0]!.reason.includes('不在候选位置内'));
        return true;
      },
    );
  });

  it('⑫ 节点文本超 200 字 → 报错且不裁剪', async () => {
    const id = await newEvent();
    await assert.rejects(
      () => upload(id, { chain: [{ kind: 'root', text: 'x'.repeat(201), ref: 'src/app.ts:3' }] }),
      isCode('ANALYSIS_EDIT_INVALID'),
    );
  });
});

describe('验真与剔除', () => {
  it('⑬ 默认整批失败：一条越界行号即拒', async () => {
    const id = await newEvent();
    await assert.rejects(
      () => upload(id, {
        // ref 必须先在候选集合内（否则先被 ref⊆candidates 拦下，测不到验真分支）
        chain: [{ kind: 'root', text: '只有越界候选' }],
        candidates: [{ file: 'src/app.ts', line: 99, why: '越界' }],
      }),
      isCode('ANALYSIS_LOCATION_VERIFY_FAILED'),
    );
    assert.equal(readAnalysisDocRaw(scope, id).draft, null, '失败时不能落半份草稿');
  });

  it('⑭ skipInvalidCandidates：剔除无效项并记录 dropped', async () => {
    const id = await newEvent();
    const out = await upload(id, {
      skipInvalidCandidates: true,
      candidates: [
        { file: 'src/app.ts', line: 3, why: '有效' },
        { file: 'src/app.ts', line: 99, why: '越界' },
      ],
    });
    assert.equal(out.doc.confirmed.length, 1, '剔除后只剩 1 处，且直接生效');
    assert.equal(out.dropped.length, 1);
    assert.equal(out.dropped[0]!.line, 99);
  });

  it('⑮ 剔除后链上 ref 指向被剔位置 → 只剪 ref、保留节点文本', async () => {
    const id = await newEvent();
    const out = await upload(id, {
      skipInvalidCandidates: true,
      // ref 在**原始**候选集合内（校验通过），但该候选验真失败被剔除 → 落盘前剪 ref
      chain: [{ kind: 'root', text: '引用越界位置', ref: 'src/app.ts:99' }],
      candidates: [
        { file: 'src/app.ts', line: 3, why: '有效' },
        { file: 'src/app.ts', line: 99, why: '越界' },
      ],
    });
    assert.equal(out.doc.confirmed.length, 1);
    const node = out.doc.draft!.chain[0]!;
    assert.equal(node.ref, undefined);
    assert.equal(node.text, '引用越界位置');
  });

  it('⑯ 全部无效 → ANALYSIS_CANDIDATE_ALL_DROPPED', async () => {
    const id = await newEvent();
    await assert.rejects(
      () => upload(id, {
        skipInvalidCandidates: true,
        chain: [{ kind: 'root', text: '只剩越界候选' }],
        candidates: [{ file: 'src/app.ts', line: 99, why: '越界' }],
      }),
      isCode('ANALYSIS_CANDIDATE_ALL_DROPPED'),
    );
  });
});

describe('targetDir 与已确认位置', () => {
  it('⑰ targetDir 与配置根不一致 → ANALYSIS_TARGET_OUT_OF_ROOT', async () => {
    const id = await newEvent();
    await assert.rejects(() => upload(id, { targetDir: '/tmp' }), isCode('ANALYSIS_TARGET_OUT_OF_ROOT'));
  });

  it('⑱ targetDir 等于配置根 → 放行', async () => {
    const id = await newEvent();
    const out = await upload(id, { targetDir: repoDir });
    assert.equal(out.doc.draft?.targetDir, repoDir);
  });

  it('⑲ 重复上传：位置直接生效且按 file+line 去重，覆盖结论不清空已确认位置', async () => {
    const id = await newEvent();
    const first = await upload(id);
    assert.equal(first.doc.confirmed.length, 1, '第一次上传就应直接生效');
    assert.equal(first.autoConfirmed, 1);

    const second = await upload(id, { conclusion: '第三版结论' });
    assert.equal(second.doc.confirmed.length, 1, '同一位置重复上传不得堆重复');
    assert.equal(second.autoConfirmed, 0, '去重后没有新位置');
    assert.equal(second.doc.draft?.conclusion, '第三版结论');
    assert.equal(readAnalysisDocRaw(scope, id).confirmed.length, 1);
  });
});

describe('读出口', () => {
  it('⑳ getEventDetail 透出 source / importedAt / sourceClient', async () => {
    const id = await newEvent();
    await upload(id);
    const view = getEventDetail(scope, { ref: id }) as unknown as {
      analysis: { draft: { source?: string; importedAt?: number; sourceClient?: string } | null };
    };
    assert.equal(view.analysis.draft?.source, 'external');
    assert.equal(typeof view.analysis.draft?.importedAt, 'number');
    assert.equal(view.analysis.draft?.sourceClient, 'mcp');
  });
});

describe('边界', () => {
  it('㉑ 事件不存在 → EVENT_NOT_FOUND（不产生孤儿分析文件）', async () => {
    await assert.rejects(
      () => upload('evt_nope_external'),
      isCode('EVENT_NOT_FOUND'),
    );
    assert.equal(readAnalysisDocRaw(scope, 'evt_nope_external').draft, null);
  });
});
