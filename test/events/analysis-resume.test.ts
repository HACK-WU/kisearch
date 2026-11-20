/**
 * analysis-resume.test.ts —— 分析断点的读写、过期、裁剪（2026-11-20）
 *
 * 契约：
 *   1. 写完能原样读回（含 messages / steps / filesRead）；
 *   2. clear 之后读不到；
 *   3. 过期（updatedAt 超 TTL）读时自动删除并返回 null；
 *   4. 坏 JSON / 形状不符 → null 且顺手删掉，不能把坏断点留在盘上；
 *   5. 超过 RESUME_MAX_BYTES → 裁剪最旧轮次（保留 system + 首条 user + 最近若干条）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-resume.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-resume-'));
const cfgPath = path.join(tmpRoot, 'config.yaml');
const dataDir = path.join(tmpRoot, 'data');
const SCOPE = 'probe-resume';
const EVENT = 'evt_probe_1';

before(() => {
  process.env.KI_CONFIG_PATH = cfgPath;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    cfgPath,
    [
      `dataDir: ${dataDir}`,
      `backupDir: ${path.join(tmpRoot, 'backup')}`,
      `vectorDir: ${path.join(tmpRoot, 'vector')}`,
      'scopeMode: default',
      'scopes:',
      `  ${SCOPE}: {}`,
      '',
    ].join('\n'),
    'utf-8',
  );
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function load() {
  return import('../../src/lib/events/analysis-resume.js');
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    eventId: EVENT,
    runId: 'run_test_1',
    round: 3,
    turns: 3,
    tokens: 1200,
    elapsedMs: 45_000,
    messages: [
      { role: 'system' as const, content: 'SYS' },
      { role: 'user' as const, content: 'USER' },
      { role: 'assistant' as const, content: 'A1' },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'T1' },
    ],
    steps: [{ name: 'round-1', title: '第 1 轮探索：fs_read', ms: 12, metrics: {} }],
    filesRead: ['src/a.ts'],
    startedAt: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('分析断点', () => {
  it('写完原样读回', async () => {
    const { writeResume, readResume, resumeFilePath } = await load();
    assert.equal(writeResume(SCOPE, EVENT, makeState() as never), true);
    assert.equal(fs.existsSync(resumeFilePath(SCOPE, EVENT)), true);
    const got = readResume(SCOPE, EVENT);
    assert.ok(got);
    assert.equal(got.runId, 'run_test_1');
    assert.equal(got.messages.length, 4);
    assert.deepEqual(got.filesRead, ['src/a.ts']);
  });

  it('clear 后读不到，且文件已删', async () => {
    const { writeResume, readResume, clearResume, resumeFilePath } = await load();
    writeResume(SCOPE, EVENT, makeState() as never);
    clearResume(SCOPE, EVENT);
    assert.equal(readResume(SCOPE, EVENT), null);
    assert.equal(fs.existsSync(resumeFilePath(SCOPE, EVENT)), false);
  });

  it('过期断点读时删除并返回 null', async () => {
    const { writeResume, readResume, resumeFilePath, RESUME_TTL_MS } = await load();
    writeResume(SCOPE, EVENT, makeState({ updatedAt: Date.now() - RESUME_TTL_MS - 1000 }) as never);
    assert.equal(readResume(SCOPE, EVENT), null);
    assert.equal(fs.existsSync(resumeFilePath(SCOPE, EVENT)), false);
  });

  it('坏 JSON / 形状不符 → null 且不留残骸', async () => {
    const { readResume, resumeFilePath } = await load();
    const file = resumeFilePath(SCOPE, EVENT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json', 'utf8');
    assert.equal(readResume(SCOPE, EVENT), null);
    assert.equal(fs.existsSync(file), false);

    fs.writeFileSync(file, JSON.stringify({ version: 2, eventId: EVENT }), 'utf8');
    assert.equal(readResume(SCOPE, EVENT), null);
    assert.equal(fs.existsSync(file), false);
  });

  it('超限时裁剪：保留 system + 首条 user + 最近消息', async () => {
    const { writeResume, readResume } = await load();
    const big = 'x'.repeat(200_000);
    const messages = [
      { role: 'system' as const, content: 'SYS' },
      { role: 'user' as const, content: 'USER' },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: 'tool' as const,
        tool_call_id: `c${i}`,
        content: big,
      })),
    ];
    writeResume(SCOPE, EVENT, makeState({ messages, round: 60 }) as never);
    const got = readResume(SCOPE, EVENT);
    assert.ok(got);
    assert.ok(got.messages.length < messages.length, '应被裁剪');
    assert.equal(got.messages[0]?.content, 'SYS');
    assert.equal(got.messages[1]?.content, 'USER');
    // 尾部保留：最后一条仍在
    assert.equal(got.messages[got.messages.length - 1]?.tool_call_id, 'c59');
  });
});
