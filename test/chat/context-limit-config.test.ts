/**
 * 上下文上限：**界面覆盖值单独存，绝不改 config.yaml**（REQ-20261014-001 · 用户裁决 2026-10-14）
 *
 * ═══ 本文件存在的理由 ═══
 * 上限有两层，边界必须锁死：
 *   · `~/.ki/config.yaml` 的 `llm.contextChars` = **部署默认**（运维级，含 apiKey / 模型 / scope）
 *   · `{chatDir}/prompt-config.json` 的 `contextChars` = **用户覆盖值**（产品级，缺省 = 未覆盖）
 * 生效值 = 覆盖值 ?? 部署默认 ?? 内置 1000K。
 *
 * 任何一条写错都不会崩，只会静默出错：界面上点一次保存就把运维级配置文件重写并丢掉注释，
 * 或"恢复默认"回到写死的 1000K 而不是部署默认 —— 所以逐条上锁：
 *   ① **保存对话配置后 config.yaml 必须逐字节不变**（本文件最重要的一条）
 *   ② 缺省 = 未覆盖（字段不落盘），而不是写入 1000K
 *   ③ 非法值必须在写盘**之前**被拒，且两个文件都无改动
 *   ④ 生效值 / 默认值 / 是否覆盖三个字段的自洽（含"恢复默认"回到部署默认而非 1000K）
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/context-limit-config.test.ts`
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 隔离环境：临时配置 + 临时 chatDir（不碰 ~/.ki）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ctxlimit-test-'));
const CFG = path.join(TMP, '.ki', 'config.yaml');
const CHAT_ROOT = path.join(TMP, 'chat');
const DATA_ROOT = path.join(TMP, 'data');

fs.mkdirSync(path.dirname(CFG), { recursive: true });

/** 部署默认上限：6K —— 与内置 1000K 明显不同，任何"回落到内置默认"的 bug 都能立刻暴露 */
const DEPLOY_DEFAULT = 6000;
/** 超上界（与 prompt-config.ts::CONTEXT_CHARS_MAX 同源） */
const CHARS_MAX = 100_000_000;

const INITIAL_CONFIG = [
  `dataDir: ${DATA_ROOT}`,
  `backupDir: ${path.join(TMP, 'backup')}`,
  `chatDir: ${CHAT_ROOT}`,
  'scopeMode: default',
  'scopes:',
  '  default: {}',
  'embedding:',
  '  provider: openai-compatible',
  '  baseURL: https://embed.example.com/v1',
  '  model: test-embed',
  '  dimension: 4096',
  '  apiKey: test-embed-key',
  'llm:',
  '  baseURL: https://llm.example.com/v1',
  '  model: test-model',
  '  apiKey: test-llm-key',
  '  kbDisclosureAck: true',
  `  contextChars: ${DEPLOY_DEFAULT}`,
].join('\n') + '\n';

fs.writeFileSync(CFG, INITIAL_CONFIG, { mode: 0o600 });
process.env.KI_CONFIG_PATH = CFG;

// 动态 import：必须在设置 KI_CONFIG_PATH 之后
const { handleApiRequest } = await import('../../src/lib/mcp-http-api.js');

const PROMPT_CFG_FILE = path.join(CHAT_ROOT, 'prompt-config.json');

let server: import('node:http').Server;
let port = 0;

const TOKEN_SCOPES: Record<string, string[] | undefined> = { secret: ['A'] };
const SCENARIOS = {
  open: { authEnabled: false },
  'token-scope-A': { authEnabled: true, clientAddr: '10.0.0.9' },
};
type ScenarioKey = keyof typeof SCENARIOS;

async function api(
  method: string,
  pathAndQuery: string,
  scenario: ScenarioKey,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { __probe_scenario: scenario };
  if (scenario === 'token-scope-A') headers.authorization = 'Bearer secret';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const cfgText = (): string => fs.readFileSync(CFG, 'utf-8');
/** prompt-config.json 原文；文件不存在 → null（= 从未保存过） */
const promptCfgText = (): string | null => {
  try { return fs.readFileSync(PROMPT_CFG_FILE, 'utf-8'); } catch { return null; }
};
const promptCfgJson = (): any => {
  const t = promptCfgText();
  return t === null ? null : JSON.parse(t);
};
const effectiveChars = async (): Promise<number> => {
  const r = await api('GET', '/api/chat/config', 'open');
  return r.json?.contextChars;
};

before(async () => {
  const http = await import('node:http');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const which = (req.headers['__probe_scenario'] as string) ?? 'open';
    const base = SCENARIOS[which as ScenarioKey] ?? SCENARIOS.open;
    await handleApiRequest(req, res, url, {
      ...base,
      resolveTokenScopes: (t) => TOKEN_SCOPES[t],
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ═══════════════════════════════════════════════════════════

describe('① 生效值优先链：无覆盖时取部署默认', () => {
  it('①a 未保存过对话配置 → 生效值 = config.yaml 的 6K，且标记未覆盖', async () => {
    const r = await api('GET', '/api/chat/config', 'open');
    assert.equal(r.status, 200);
    assert.equal(r.json.contextChars, DEPLOY_DEFAULT, '应取部署默认');
    assert.equal(r.json.contextCharsDefault, DEPLOY_DEFAULT);
    assert.equal(r.json.contextCharsOverridden, false);
  });

  it('①b 对话配置的默认上限透出部署默认与硬上界（前端不写死 1000K）', async () => {
    const r = await api('GET', '/api/chat/prompt-config', 'open');
    assert.equal(r.status, 200);
    assert.equal(r.json.contextCharsDefault, DEPLOY_DEFAULT, '「恢复默认」的目标值 = 部署默认');
    assert.equal(r.json.limits.contextCharsMax, CHARS_MAX);
  });
});

describe('② ★ 保存覆盖值：写 prompt-config.json，**config.yaml 逐字节不变**', () => {
  it('②a 保存 contextChars=12000 → 200', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: 12000 });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json?.config?.contextChars, 12000);
  });

  it('②b 覆盖值落在 prompt-config.json', async () => {
    assert.equal(promptCfgJson()?.contextChars, 12000);
  });

  it('②c ★★ config.yaml **逐字节不变**（用户核心要求：界面改上限不得写配置文件）', () => {
    assert.equal(cfgText(), INITIAL_CONFIG, '配置文件被改写了 —— 这是本需求的红线');
  });

  it('②d 生效值与三个字段自洽', async () => {
    const r = await api('GET', '/api/chat/config', 'open');
    assert.equal(r.json.contextChars, 12000, '生效值 = 覆盖值');
    assert.equal(r.json.contextCharsDefault, DEPLOY_DEFAULT, '默认值仍是部署默认');
    assert.equal(r.json.contextCharsOverridden, true);
  });

  it('②e 再保存一次仍不动 config.yaml（幂等且不写文件）', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: 12000 });
    assert.equal(r.status, 200);
    assert.equal(cfgText(), INITIAL_CONFIG);
  });
});

describe('③ 「恢复默认」= 删掉覆盖值（回到部署默认，不是写死 1000K）', () => {
  it('③a 保存时不带 contextChars → 键从落盘 JSON 中消失', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: undefined });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    const saved = promptCfgJson();
    assert.equal('contextChars' in (saved ?? {}), false, '未覆盖时不应留下该键（否则会被读成"覆盖成 0/默认"）');
  });

  it('③b 生效值回到部署默认 6K（而非内置 1000K）', async () => {
    const r = await api('GET', '/api/chat/config', 'open');
    assert.equal(r.json.contextChars, DEPLOY_DEFAULT, '★ 回到部署默认，不是写死 1000K');
    assert.equal(r.json.contextCharsOverridden, false);
  });

  it('③c 此次操作同样未动 config.yaml', () => {
    assert.equal(cfgText(), INITIAL_CONFIG);
  });
});

describe('④ 契约锁定：对话配置是**整体替换**，调用方必须带全字段', () => {
  it('④a 先设覆盖值，再用"只带 prompt"的请求保存 → 覆盖值被清掉（整体替换语义）', async () => {
    await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: 9000 });
    assert.equal(await effectiveChars(), 9000);

    // 不带 contextChars 的请求 = 显式声明"未覆盖"
    const r = await api('PUT', '/api/chat/prompt-config', 'open', { prompt: { content: '新提示词' } });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(await effectiveChars(), DEPLOY_DEFAULT);
    assert.equal('contextChars' in (promptCfgJson() ?? {}), false);
    // ★ 前端因此必须走 cloneConfig 把该字段搬进草稿（漏掉会表现为"改 skill 保存一下上限就被清"）
  });
});

describe('⑤ 非法值：400 且两个文件都不得改动', () => {
  const bad: Array<{ name: string; value: unknown }> = [
    { name: '0', value: 0 },
    { name: '负数', value: -1 },
    { name: '小数', value: 1.5 },
    { name: '字符串数字', value: '12000' },
    { name: 'null', value: null },
    { name: '布尔', value: true },
    { name: '超过硬上界', value: CHARS_MAX + 1 },
  ];

  for (const c of bad) {
    it(`拒绝 ${c.name} → 400 PROMPT_CONFIG_INVALID，不落盘`, async () => {
      const cfgBefore = cfgText();
      const pcBefore = promptCfgText();
      const r = await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: c.value });
      assert.equal(r.status, 400, `期望 400，实际 ${r.status}：${r.text}`);
      assert.equal(r.json?.code, 'PROMPT_CONFIG_INVALID');
      assert.ok(
        (r.json?.details ?? []).some((d: any) => d.field === 'contextChars'),
        `details 应定位到 contextChars，实际 ${JSON.stringify(r.json?.details)}`,
      );
      assert.equal(cfgText(), cfgBefore, '非法请求不得改 config.yaml');
      assert.equal(promptCfgText(), pcBefore, '非法请求不得改 prompt-config.json');
    });
  }

  it('边界：恰好等于硬上界 → 接受', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: CHARS_MAX });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(cfgText(), INITIAL_CONFIG, '即使接受也不得动 config.yaml');
  });
});

describe('⑥ 权限：非全局授权身份 403', () => {
  it('⑥a 越权保存 → 403 且两个文件均未改动', async () => {
    const cfgBefore = cfgText();
    const pcBefore = promptCfgText();
    const r = await api('PUT', '/api/chat/prompt-config', 'token-scope-A', { contextChars: 5000 });
    assert.equal(r.status, 403, `期望 403，实际 ${r.status}：${r.text}`);
    assert.equal(cfgText(), cfgBefore);
    assert.equal(promptCfgText(), pcBefore);
  });
});

describe('⑦ 回归：API-13 ack 仍能写 config.yaml 的 kbDisclosureAck（本次未动它）', () => {
  it('⑦a ack 落盘 + 不触碰 contextChars / contextChars 之外的内容', async () => {
    const YAML = (await import('yaml')).default;
    const doc = YAML.parse(cfgText()) as any;
    doc.llm.kbDisclosureAck = false;
    fs.writeFileSync(CFG, YAML.stringify(doc));

    const r = await api('POST', '/api/chat/config/ack', 'open', { ack: true });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.kbDisclosureAck, true);

    const after = YAML.parse(cfgText()) as any;
    assert.equal(after.llm.kbDisclosureAck, true, 'ack 仍须真实落盘');
    assert.equal(after.llm.contextChars, DEPLOY_DEFAULT, 'ack 不得动部署默认值');
    assert.equal(after.llm.apiKey, 'test-llm-key');
  });

  it('⑦b 界面覆盖值的存在不影响 ack 之后的生效值', async () => {
    await api('PUT', '/api/chat/prompt-config', 'open', { contextChars: 8000 });
    await api('POST', '/api/chat/config/ack', 'open', { ack: true });
    assert.equal(await effectiveChars(), 8000);
  });
});

describe('⑧ 旧接口已移除：PUT /api/chat/config 不再存在', () => {
  it('⑧ 该路径的 PUT → 404（写 config.yaml 的通路已撤销）', async () => {
    const cfgBefore = cfgText();
    const r = await api('PUT', '/api/chat/config', 'open', { contextChars: 12345 });
    assert.equal(r.status, 404, `期望 404（路由不存在），实际 ${r.status}：${r.text}`);
    assert.equal(cfgText(), cfgBefore);
  });
});

describe('⑨ 边界事实锁定：手写非法 contextChars 会让**整个**对话配置在界面上回退默认', () => {
  it('⑨a 先写入带自定义提示词的合法配置', async () => {
    const r = await api('PUT', '/api/chat/prompt-config', 'open', {
      prompt: { content: '我的自定义提示词' },
      contextChars: 7000,
    });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(await effectiveChars(), 7000);
  });

  it('⑨b 手工把 contextChars 改写成字符串（模拟手改 JSON 出错）→ 读取**整体回退默认**并透出 issue', async () => {
    const raw = JSON.parse(promptCfgText()!) as Record<string, unknown>;
    raw.contextChars = '7000'; // ← 字符串（放过 API 校验，只有手改才可能落到这里）
    fs.writeFileSync(PROMPT_CFG_FILE, JSON.stringify(raw, null, 2));

    const r = await api('GET', '/api/chat/prompt-config', 'open');
    assert.ok(r.json.issue, `★ 必须 fail-loud 透出 issue，实际 ${JSON.stringify(r.json.issue)}`);
    assert.equal(r.json.config.contextChars, undefined, '回退后无覆盖值');
    assert.notEqual(
      r.json.config.prompt.content,
      '我的自定义提示词',
      '★ 既有语义：**任一**字段非法 → 整体回退默认（磁盘内容仍在，仅读取时回退）—— 本断言把该事实钉住',
    );
    assert.equal(await effectiveChars(), DEPLOY_DEFAULT, '生效值随之退回部署默认');
  });
});
