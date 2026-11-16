/**
 * analysis-store.test.ts —— S-03 事件描述、分析存储与 ki_event_list 投影单测
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-store.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import {
  createEvent,
  deleteEvent,
  transitionEvent,
  updateEvent,
} from '../../src/lib/events/event-service.js';
import {
  confirmDraftLocations,
  discardAnalysisDraft,
  getAnalysisPath,
  normalizeAnalysisDocForRead,
  readAnalysisDocRaw,
  removeConfirmedLocation,
  updateDraftIfMatch,
  writeDraftStart,
} from '../../src/lib/events/analysis-store.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEventListTool } from '../../src/lib/mcp-tools/event-list.js';

const scope = `ana-store-${Date.now()}`;

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('S-03 事件描述与分析存储契约', () => {
  it('① 创建与更新事件 description（含乐观锁与 4000 字上限）', async () => {
    const ev = await createEvent(scope, {
      title: '登录页白屏',
      description: '点击登录后偶发白屏',
      typeId: 'et_1',
    });
    assert.equal(ev.description, '点击登录后偶发白屏');

    const updated = await updateEvent(scope, ev.id, {
      description: '补充堆栈 Cannot read properties of null',
      revision: ev.revision,
    });
    assert.equal(updated.description, '补充堆栈 Cannot read properties of null');
    assert.equal(updated.revision, ev.revision + 1);

    await assert.rejects(
      () => updateEvent(scope, ev.id, { description: '旧版本覆盖', revision: ev.revision }),
      (e: unknown) => e instanceof GovernanceError && e.code === 'REVISION_CONFLICT',
    );

    await assert.rejects(
      () => updateEvent(scope, ev.id, { description: 'x'.repeat(4001), revision: updated.revision }),
      (e: unknown) => e instanceof GovernanceError && e.code === 'EVENT_DESCRIPTION_TOO_LONG',
    );
  });

  it('② 草稿读写、runId 守卫、并发保留 confirmed[]、勾选确认与移除', async () => {
    const ev = await createEvent(scope, { title: '分析存储测试', typeId: 'et_1' });
    await writeDraftStart(scope, ev.id, {
      runId: 'run_1',
      status: 'running',
      targetDir: '/tmp/repo',
      commit: 'abc1234',
      candidates: [],
      unconfirmed: [],
      steps: [],
      stats: { turns: 0, filesRead: 0, tokens: 0, ms: 0 },
      startedAt: 1000,
      updatedAt: 1000,
    });

    // 不匹配的 runId 写入被拒绝（返回 null）
    const mismatch = await updateDraftIfMatch(scope, ev.id, 'run_other', (d) => ({ ...d, status: 'ready' }));
    assert.equal(mismatch, null);

    // 匹配 runId 更新为 ready
    await updateDraftIfMatch(scope, ev.id, 'run_1', (d) => ({
      ...d,
      status: 'ready',
      candidates: [
        { id: 'c1', file: 'src/a.ts', line: 10, snippet: 'const x = 1;', why: '主因', confidence: 0.9 },
        { id: 'c2', file: 'src/b.ts', line: 20, snippet: 'return null;', why: '次因', confidence: 0.6 },
      ],
      updatedAt: 2000,
    }));

    // expectedRunId 错误时拒绝确认
    await assert.rejects(
      () => confirmDraftLocations(scope, ev.id, { candidateIds: ['c1'], expectedRunId: 'run_wrong' }),
      (e: unknown) => e instanceof GovernanceError && e.code === 'REVISION_CONFLICT',
    );

    // 确认 c1 并保留草稿
    const res1 = await confirmDraftLocations(scope, ev.id, { candidateIds: ['c1'], expectedRunId: 'run_1' });
    assert.equal(res1.added, 1);
    assert.equal(res1.doc.confirmed.length, 1);

    // 开启新一轮 run_2，验证不丢失已有 confirmed[0]
    await writeDraftStart(scope, ev.id, {
      runId: 'run_2',
      status: 'running',
      targetDir: '/tmp/repo',
      commit: 'abc1234',
      candidates: [],
      unconfirmed: [],
      steps: [],
      stats: { turns: 0, filesRead: 0, tokens: 0, ms: 0 },
      startedAt: 3000,
      updatedAt: 3000,
    });
    const afterStart2 = readAnalysisDocRaw(scope, ev.id);
    assert.equal(afterStart2.confirmed.length, 1, '新分析启动不得清空已有 confirmed');

    // 删除单条已确认位置与丢弃草稿
    const locId = afterStart2.confirmed[0]!.id;
    const afterRm = await removeConfirmedLocation(scope, ev.id, locId);
    assert.equal(afterRm.confirmed.length, 0);
    const afterDiscard = await discardAnalysisDraft(scope, ev.id);
    assert.equal(afterDiscard.draft, null);
  });

  it('③ 跨进程僵尸 running 态自动恢复为 ANALYSIS_INTERRUPTED', () => {
    const normalized = normalizeAnalysisDocForRead({
      version: 1,
      eventId: 'evt_z',
      draft: {
        runId: 'r1',
        bootId: 'old-dead-boot-id',
        status: 'running',
        targetDir: '/tmp',
        commit: null,
        candidates: [],
        unconfirmed: [],
        steps: [],
        stats: { turns: 0, filesRead: 0, tokens: 0, ms: 0 },
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      },
      confirmed: [],
      updatedAt: Date.now() - 1000,
    }, false);
    assert.equal(normalized.draft?.status, 'failed');
    assert.equal(normalized.draft?.errorCode, 'ANALYSIS_INTERRUPTED');
  });

  it('④ ki_event_list 透出 codeLocationTotal 与 codeLocationsPreview；deleteEvent 清理 .analysis.json', async () => {
    const ev = await createEvent(scope, { title: '列表透出测试', typeId: 'et_1' });
    await writeDraftStart(scope, ev.id, {
      runId: 'run_x',
      status: 'ready',
      targetDir: '/tmp/repo',
      commit: 'deadbeef',
      candidates: [
        { id: 'c1', file: 'src/index.ts', line: 42, endLine: 45, snippet: 'throw err;', why: '未捕获异常', confidence: 0.92 },
      ],
      unconfirmed: [],
      steps: [],
      stats: { turns: 1, filesRead: 1, tokens: 100, ms: 50 },
      startedAt: 1000,
      updatedAt: 1050,
    });
    await confirmDraftLocations(scope, ev.id, { candidateIds: ['c1'], discardDraft: true });

    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerEventListTool(server);
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const toolOut = await registered.ki_event_list!.handler({
      scope,
      status: 'open',
      limit: 20,
      offset: 0,
      docs_preview_limit: 3,
      locations_preview_limit: 5,
    });
    const parsed = JSON.parse(toolOut.content[0]!.text) as {
      events: Array<{ id: string; codeLocationTotal: number; codeLocationsPreview: Array<{ file: string; line: number }> }>;
    };
    const found = parsed.events.find((e) => e.id === ev.id);
    assert.ok(found);
    assert.equal(found!.codeLocationTotal, 1);
    assert.equal(found!.codeLocationsPreview[0]!.file, 'src/index.ts');
    assert.equal(found!.codeLocationsPreview[0]!.line, 42);

    // 收口并删除事件，校验 .analysis.json 被一并清理
    assert.ok(fs.existsSync(getAnalysisPath(scope, ev.id)));
    await transitionEvent(scope, { event: ev.id, stage: '已关闭' });
    await deleteEvent(scope, { event: ev.id, docAction: 'wiki' });
    assert.equal(fs.existsSync(getAnalysisPath(scope, ev.id)), false, '删除事件必须清理 .analysis.json');
  });
});
