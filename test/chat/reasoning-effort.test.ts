/**
 * 思考级别（REQ-20261016-001）—— llm-client 下发口径 + 配置层两段校验。
 *
 * 覆盖设计 §13 的关键断言（原为 `temp/verify-reasoning-effort-b1b2.ts`，本次转正）：
 *   ① 未配置档位 → 请求体**不含** `reasoning_effort`（回归点：与改造前逐字节一致）
 *   ② 配置档位 → **顶层** `reasoning_effort` 透传
 *   ③ 400 文案含 tools + reasoning_effort → **不**判为"工具不支持"，且带档位指引（设计 §4.7）
 *   ④ 新值 ∈ 清单 → 保存成功；∉ 清单 → 400
 *   ⑤ 既有值脱离清单（运维改小清单）→ **放行**（防保存死锁，设计 §5 决策 6/7）
 *   ⑥ 保留字 `__follow_default__` → 400
 *   ⑦ 读取宽松：磁盘值形状非法 → 只忽略该字段 + issue，**不**整份回退默认
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/reasoning-effort.test.ts`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { LlmUpstreamError, ToolsUnsupportedError, streamChat } from '../../src/lib/chat/llm-client.js';

const seen: Record<string, unknown>[] = [];
let failWith: string | null = null;
let server: Server;
let base = '';
const llmBase = (): { baseURL: string; apiKey: string; model: string } => ({ baseURL: base, apiKey: 'k', model: 'm' });

async function drain(opts: Parameters<typeof streamChat>[1]): Promise<void> {
  for await (const _p of streamChat([{ role: 'user', content: 'q' }], opts)) { /* noop */ }
}

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw) as Record<string, unknown>);
      if (failWith !== null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: failWith } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); });

describe('思考级别 · llm-client 下发', () => {
  it('① 未配置档位 → 请求体不含 reasoning_effort', async () => {
    seen.length = 0;
    await drain({ llm: llmBase() });
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0], 'reasoning_effort'), false);
  });

  it('② 配置档位 → 顶层 reasoning_effort 透传', async () => {
    seen.length = 0;
    await drain({ llm: { ...llmBase(), reasoningEffort: 'max' } });
    assert.equal(seen[0].reasoning_effort, 'max');
  });

  it('③ 400 含 tools + reasoning_effort → 不判"工具不支持"，且带档位指引', async () => {
    failWith = 'unknown parameters: tools, reasoning_effort';
    await assert.rejects(
      () => drain({ llm: { ...llmBase(), reasoningEffort: 'max' } }),
      (e: unknown) => e instanceof LlmUpstreamError
        && !(e instanceof ToolsUnsupportedError)
        && /思考级别/.test((e as Error).message),
    );
    failWith = null;
  });
});

describe('思考级别 · 压缩路径不携带（D4 回归守卫）', () => {
  it('compaction.ts 不得出现 reasoningEffort（若将来要为压缩单独定档，先更新设计 D4 再改本断言）', () => {
    const src = fs.readFileSync(new URL('../../src/lib/chat/compaction.ts', import.meta.url), 'utf-8');
    // 结构保证：压缩摘要走独立参数块且**刻意不传**该字段 —— 该决策由设计 §5 D4 固化
    assert.equal(/reasoningEffort/i.test(src), false, '压缩路径出现了思考级别字段，与 D4（完全不传）冲突');
  });
});

describe('思考级别 · 配置层两段校验与读取宽松', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-effort-'));
  const cfgPath = path.join(tmp, 'config.yaml');
  const cfgDir = path.join(tmp, 'chat');
  const promptFile = path.join(cfgDir, 'prompt-config.json');

  const writeCfg = (efforts: string, def?: string): void => {
    fs.writeFileSync(cfgPath, [
      `dataDir: ${tmp}/kb`,
      `chatDir: ${cfgDir}`,
      'llm:',
      '  baseURL: http://127.0.0.1:1/v1',
      '  model: m',
      '  apiKey: k',
      '  kbDisclosureAck: true',
      `  reasoningEfforts: ${efforts}`,
      ...(def !== undefined ? [`  reasoningEffort: ${def}`] : []),
      '',
    ].join('\n'));
  };

  let ctx: {
    loadConfig: typeof import('../../src/lib/config.js').loadConfig;
    resetConfigCache: typeof import('../../src/lib/config.js').resetConfigCache;
    readPromptConfig: typeof import('../../src/lib/chat/prompt-config.js').readPromptConfig;
    savePromptConfig: typeof import('../../src/lib/chat/prompt-config.js').savePromptConfig;
    PromptConfigError: typeof import('../../src/lib/chat/prompt-config.js').PromptConfigError;
  };

  before(async () => {
    writeCfg('[low, high]', 'low');
    process.env.KI_CONFIG_PATH = cfgPath;
    // 动态 import：必须在 KI_CONFIG_PATH 生效之后（jiti 下静态 import 会被提升）
    const { loadConfig, resetConfigCache } = await import('../../src/lib/config.js');
    const mod = await import('../../src/lib/chat/prompt-config.js');
    ctx = { loadConfig, resetConfigCache, ...mod };
  });

  it('④ 新值 ∈ 清单 → 保存成功；∉ 清单 → 400', () => {
    const saved = ctx.savePromptConfig(ctx.loadConfig(), { reasoningEffort: 'high' });
    assert.equal(saved.reasoningEffort, 'high');
    assert.throws(() => ctx.savePromptConfig(ctx.loadConfig(), { reasoningEffort: 'nope' }), ctx.PromptConfigError);
  });

  it('⑤ 既有值脱离清单（运维改小清单）→ 放行，不死锁', () => {
    writeCfg('[low]', 'low'); // 磁盘上仍是 high，清单只剩 low
    ctx.resetConfigCache();
    const saved = ctx.savePromptConfig(ctx.loadConfig(), { reasoningEffort: 'high' });
    assert.equal(saved.reasoningEffort, 'high');
  });

  it('⑥ 保留字 → 400（哨兵不得落盘）', () => {
    assert.throws(
      () => ctx.savePromptConfig(ctx.loadConfig(), { reasoningEffort: '__follow_default__' }),
      ctx.PromptConfigError,
    );
  });

  it('⑦ 读取宽松：磁盘值形状非法 → 只忽略该字段 + issue，不整份回退', () => {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(promptFile, JSON.stringify({
      version: 1,
      prompt: { content: '我的自定义提示词', at: '1970-01-01T00:00:00.000Z' },
      // ⚠️ 刻意**省略** skills / tools：写 `[]` / `{}` 会触发既有"内置 skill 不可删除"校验 ⇒ 整份回退
      //    （与档位字段无关），那会掩盖本条验证目标
      reasoningEffort: '',
    }, null, 2));
    const { config, issue } = ctx.readPromptConfig(ctx.loadConfig());
    assert.equal(config.reasoningEffort, undefined, '非法档位应被忽略');
    assert.ok(issue !== null && /思考级别/.test(issue), `issue 应说明原因，实际：${String(issue)}`);
    assert.equal(config.prompt.content, '我的自定义提示词', '其余字段不得回退默认');
  });
});
