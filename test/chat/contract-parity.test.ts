/**
 * 契约对齐测试：**前后端两份契约的形状必须一致**
 *
 * 背景：`web/tsconfig.json` 的 `include` 只含 `web/src`，前端**无法 import** 后端类型
 * （两端是独立 package，强行跨包引用会耦合构建）→ 契约只能"各写一份"。
 *
 * 本测试是**那份副本的唯一机械保证**。它比对两份文件的**文本形状**（不 import 前端文件，
 * 避免测试运行时依赖前端构建配置）。
 *
 * ⚠️ **骨架期本文件应为【绿】**（它验的是骨架自身的质量，不是业务行为）。
 *   若它变红 → 说明两侧契约已漂移，**变绿前不得交付**。
 *
 * 运行：`npx jiti test/chat/contract-parity.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BACK = path.resolve(import.meta.dirname, '../../src/lib/chat/chat-contract.ts');
const FRONT = path.resolve(import.meta.dirname, '../../web/src/api/chatContract.ts');

function read(p: string): string {
  assert.ok(fs.existsSync(p), `契约文件缺失：${p}`);
  return fs.readFileSync(p, 'utf8');
}

/** 提取 `export const NAME = [ 'a', 'b', ... ] as const;` 中的字符串项 */
function extractStringArray(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  assert.ok(m, `未找到 ${name}`);
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** 提取 `export interface NAME { ... }` 的顶层字段名 */
function extractInterfaceFields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `未找到 interface ${name}`);
  return [...m![1]!.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((x) => x[1]!).sort();
}

/** 提取 `export type NAME = 'a' | 'b' ...` 的联合成员 */
function extractTypeUnion(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export type ${name}\\s*=\\s*([^;]+);`));
  assert.ok(m, `未找到 type ${name}`);
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe('契约对齐 · SSE 事件协议', () => {
  it('CHAT_EVENT_TYPES 两侧完全一致（11 类事件）', () => {
    const b = extractStringArray(read(BACK), 'CHAT_EVENT_TYPES');
    const f = extractStringArray(read(FRONT), 'CHAT_EVENT_TYPES');
    assert.deepEqual(f, b);
    assert.equal(b.length, 11);
  });

  it('DegradedReason 两侧一致（三类互斥原因）', () => {
    assert.deepEqual(extractTypeUnion(read(FRONT), 'DegradedReason'), extractTypeUnion(read(BACK), 'DegradedReason'));
  });

  it('RetrievalMode 两侧一致', () => {
    assert.deepEqual(extractTypeUnion(read(FRONT), 'RetrievalMode'), extractTypeUnion(read(BACK), 'RetrievalMode'));
  });
});

describe('契约对齐 · 数据模型', () => {
  for (const name of ['SourceRef', 'ChatMessage', 'ConversationFile', 'ConversationSummary', 'ChatConfigOk']) {
    it(`${name} 字段集合两侧一致`, () => {
      assert.deepEqual(extractInterfaceFields(read(FRONT), name), extractInterfaceFields(read(BACK), name));
    });
  }

  it('ChatMessage 两侧都【不含】reasoning 字段（D7 结构性隔离）', () => {
    for (const p of [BACK, FRONT]) {
      const fields = extractInterfaceFields(read(p), 'ChatMessage');
      assert.ok(!fields.includes('reasoning'), `${p} 的 ChatMessage 不应含 reasoning`);
    }
  });

  it('ChatConfigOk 两侧都含 4 个 v2 字段（D13）', () => {
    const need = ['ackRequired', 'maxToolRounds', 'retrievalEnabled', 'supportsTools'];
    for (const p of [BACK, FRONT]) {
      const fields = extractInterfaceFields(read(p), 'ChatConfigOk');
      for (const k of need) assert.ok(fields.includes(k), `${p} 缺少 ${k}`);
    }
  });
});
