/**
 * vector-idle-race.test.ts —— idle close 与在途操作的竞态回归测试
 *
 * 场景（修复前必现的竞态）：
 *   ki_search → vectorSearch → engine.search() 主线程 embedding（网络 0.5s~数秒）
 *   超过 idle 窗口 → idle timer 触发 closeEngine → proxy.close() 的 drain 只等
 *   已 postMessage 的请求（embedding 阶段不可见）→ drain 立即完成 → worker closed
 *   → embedding 返回后 proxy.send 报 "worker not open (state=closed)"
 *
 * 修复：withEngine 包装（_inFlightOps 在途计数，idle 判定加 `_inFlightOps === 0`）
 * + WorkerUnavailableError 自愈重试兜底。
 *
 * 本测试用真实 engine + 真实 embedding（idle 窗口设 800ms < embedding 耗时）
 * 验证在途操作不被 idle close 打断。需 SILICONFLOW_API_KEY（无则 skip）。
 *
 * 运行：npx jiti test/vector-idle-race.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hasKey = !!process.env.SILICONFLOW_API_KEY;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-idle-race-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  vectorDir: path.join(tmpDir, 'vector'),
  dataDir: path.join(tmpDir, 'kb'),
  embedding: {
    provider: 'siliconflow',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-Embedding-8B',
    dimension: 4096,
    apiKey: '${SILICONFLOW_API_KEY}',
  },
  scopes: { default: {} },
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let vc: typeof import('../src/lib/vector-client.js');

before(async () => {
  vc = await import('../src/lib/vector-client.js');
});

after(async () => {
  await vc.closeEngine();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('idle close 在途竞态（idle 800ms < embedding 耗时）', () => {
  it('embedding 期间 idle 窗口到期 → 操作不被打断，无 "worker not open"', { skip: !hasKey && '需真实 embedding 密钥' }, async () => {
    // 800ms idle 窗口：首次 getEngine open 后，vectorStore 的 embedding（网络 ~1s）
    // 必然跨过 idle 到期点——修复前 idle close 会在 embedding 期间关掉 worker。
    vc.enableIdleClose(800);

    // 第一次调用触发 open + embedding + upsert（全程在途保护内）
    const r = await vc.vectorStore({
      scope: 'default',
      text: `idle-race-probe-${Date.now()}：这是一条用于验证空闲释放竞态的测试文本，需要足够的长度以触发真实的 embedding 网络调用耗时。`.repeat(3),
      tags: 'idle-race-test',
    });
    assert.ok(r.docId, 'vectorStore 应成功（在途操作不被 idle close 打断）');

    // 紧接着第二次调用验证 engine 仍可用（无论 idle 是否已释放过，reopen 应正常）
    const r2 = await vc.vectorStore({
      scope: 'default',
      text: `idle-race-probe-2-${Date.now()}：第二次调用验证 engine 生命周期正常。`,
      tags: 'idle-race-test',
    });
    assert.ok(r2.docId);

    // 清理测试数据 + 关闭 idle 计时
    await vc.vectorDelete({ scope: 'default', ids: [r.docId, r2.docId] });
  });
});
