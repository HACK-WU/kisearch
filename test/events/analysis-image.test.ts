/**
 * AI 分析链路看图（REQ-20261123-008 · B5）
 *
 * ═══ 守什么 ═══
 * 分析链路是**独立实现**（entry 是 `run(args)`、scope 在闭包、tool 消息本来是一整段
 * `<kb_doc>…</kb_doc>` 字符串），所以对话链路的改造不会自动生效。这里钉三件事：
 *   ① 取图工具在分析域可用，且结果能变成 tool 消息的 `image_url` part（模型据图作答）；
 *   ② **过程区/落盘的 `response` 不含 base64** —— 否则一张 500KB 图会把
 *      `.analysis.json` 撑大数倍，前端也会卡（这是最容易漏的一处）；
 *   ③ 图片与 `<kb_doc>` 标签共存：文本分片仍被标签包裹，防止把图当指令。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-image.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getAssetsDir, getKbDir } from '../../src/lib/scope.js';
import type { KiConfig } from '../../src/lib/config.js';
import { savePromptConfig } from '../../src/lib/chat/prompt-config.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import {
  isAnalysisActive,
  readNormalizedAnalysisDoc,
  startEventAnalysis,
} from '../../src/lib/events/analysis-runner.js';
import type { ChatTurn, StreamChatOptions, StreamPart } from '../../src/lib/chat/llm-client.js';

const scope = `ana-img-${Date.now()}`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GROUP = '排查记录';

let tmpDir = '';
let repoDir = '';
let cfg: KiConfig;

function okLlmStatus() {
  return {
    enabled: true,
    reason: null,
    supportsImages: false,
    supportsTools: true,
    ackRequired: false,
    model: 'test-model',
    baseURL: 'http://localhost',
    contextChars: 1_000_000,
    maxToolRounds: Infinity,
    askMaxRounds: 6,
    askSessionTtlMs: 600_000,
  };
}

/** 只关心"分析读图"，开场预取直接跳过（避免真打上游） */
const skipRecall = async () => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'TEST_SKIP' }) }],
  isError: true,
});

async function waitDone(eventId: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc = readNormalizedAnalysisDoc(scope, eventId);
    if (!isAnalysisActive(scope, eventId) && doc.draft && doc.draft.status !== 'running') return doc;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('分析任务等待超时');
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ana-img-'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'login.ts'), 'export const a = 1;\n', 'utf8');
  // 造一张真实可读的 PNG（走 ki_get_image 的真实内核）
  const assets = getAssetsDir(scope, GROUP);
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'shot.png'), Buffer.concat([PNG_MAGIC, Buffer.alloc(96, 3)]));

  cfg = {
    dataDir: path.dirname(getKbDir(scope)),
    chatDir: path.join(tmpDir, 'chat'),
    // `getScopeDataDir` 会直接读 `config.scopes[scope]`：手写 cfg 必须给一个对象，
    // 否则取图内核（走配置快照）会抛 “Cannot read properties of undefined (reading 'ana-img-…')”
    scopes: {},
    llm: { baseURL: 'http://localhost', model: 'test-model', apiKey: 'k', kbDisclosureAck: true, supportsTools: true },
  } as unknown as KiConfig;
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('B5：分析链路读图', () => {
  it('取图结果变成 tool 消息的 image part；落盘 response 不含 base64', async () => {
    const ev = await createEvent(scope, { title: '分析读图', typeId: 'et_1' });
    savePromptConfig(cfg, {
      analysis: {
        targetDirs: { byScope: { [scope]: repoDir } },
        prompt: { content: '测试分析' },
        skills: [],
        // 打开读工具：文档读取 + 取图（写工具全关）
        tools: {
          fs_read: true, fs_grep: true, fs_find: true, fs_ls: true,
          ki_get_module_info: true, ki_get_image: true,
          ki_store: false, ki_sync_relation: false, ki_bulk_sync_relation: false, ki_group_create: false,
        },
      },
    });

    let turn = 0;
    /** 第 3 轮（tool 结果已回）看到的 messages —— 用来断言 image part 真的进了上下文 */
    let seenImageParts = 0;
    let seenHasTag = false;
    /** 从工具消息里捞出的 base64 片段（若泄漏进 text 分片就会被抓到） */
    let leakedIntoText = false;

    const fakeStream = async function* (messages: ChatTurn[], opts?: StreamChatOptions): AsyncGenerator<StreamPart> {
      turn += 1;
      assert.ok(opts?.llm?.model, 'streamChat 第二参必须带 llm.model');

      if (turn === 3) {
        for (const m of messages) {
          if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
          for (const p of m.content) {
            if (p.type === 'image_url') seenImageParts += 1;
            if (p.type === 'text') {
              if (p.text.includes('<kb_doc>')) seenHasTag = true;
              // base64 绝不能出现在文本分片里（否则会被当成正文喂给模型）
              if (p.text.includes('base64,')) leakedIntoText = true;
            }
          }
        }
      }

      if (turn === 1) {
        yield {
          type: 'tool_calls',
          calls: [{
            id: 'c1',
            name: 'ki_get_module_info',
            arguments: JSON.stringify({ group: GROUP, relation: '登录故障笔记' }),
          }],
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      if (turn === 2) {
        yield {
          type: 'tool_calls',
          calls: [{
            id: 'c2',
            name: 'ki_get_image',
            arguments: JSON.stringify({ group: GROUP, refs: ['shot.png'] }),
          }],
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield {
        type: 'content',
        text: JSON.stringify({
          conclusion: '截图里显示了登录失败的提示，根因在守卫未兜底空 token。',
          chain: [{ kind: 'cause', text: '守卫在解构前读取 token', ref: 'src/login.ts:1' }],
          candidates: [{ file: 'src/login.ts', line: 1, why: '读取位置', confidence: 0.8 }],
          unconfirmed: [],
        }),
      };
      yield { type: 'done', finishReason: 'stop' };
    };

    await startEventAnalysis(scope, ev.id, {
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: okLlmStatus,
        streamChatFn: fakeStream as never,
        recallFn: skipRecall as never,
        // 文档正文带图引用 + 清单（模拟 B1 之后的返回体）
        kbExecutor: {
          getModuleInfo: async ({ group, relation }) => ({
            group,
            relation,
            content: '现象见截图\n\n![登录失败](./shot.png)\n',
            images: [{
              index: 1,
              ref: 'shot.png',
              mime: 'image/png',
              bytes: 104,
              supported: true,
            }],
          }),
        } as never,
      },
    });

    const doc = await waitDone(ev.id);

    // ─── ① 图片真的进了上下文（tool 消息 parts）───
    assert.equal(seenImageParts, 1, `第 3 轮应有 1 个 image part，实际 ${seenImageParts}`);
    assert.equal(seenHasTag, true, '文本分片仍须被 <kb_doc> 包裹（防注入）');
    assert.equal(leakedIntoText, false, 'base64 不得出现在文本分片');

    // ─── ② 过程区/落盘的 response 不含 base64，且长度可控 ───
    const steps = doc.draft?.steps ?? [];
    const calls = steps.flatMap((s) => s.calls ?? []);
    const imageCall = calls.find((c) => c.name === 'ki_get_image');
    assert.ok(imageCall, '过程区应有取图这一步');
    assert.equal(String(imageCall!.response ?? '').includes('base64'), false, '落盘 response 泄漏了 base64');
    assert.ok(String(imageCall!.response ?? '').length <= 2000, '展示口径仍按 2000 字截断');

    // ─── ③ 分析正常收尾 ───
    assert.equal(doc.draft?.status === 'running', false);
  });
});
