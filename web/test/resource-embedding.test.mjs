/**
 * 「资源 / 向量模型」页纯逻辑单测（REQ-20261030-001）
 *
 * 锁住：
 *   1) API Key 获取地址与 README 的**权威源**一致（改 README 忘了改前端时这里会红）；
 *   2) 配置片段含 6 个字段、密钥用 `${ENV_VAR}` 引用而不是明文；
 *   3) 未配置态文案必须点明「当前显示的是内置默认值」（既有缺陷 D-1）；
 *   4) 维度一致性**不得**在未配置 / 未建索引 / 未知时显示「一致」（既有缺陷 D-2）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.dirname(webRoot);

const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

const {
  buildEmbeddingConfigSnippet,
  buildLlmConfigSnippet,
  describeEmbeddingStatus,
  EMBEDDING_API_KEY_URL,
  EMBEDDING_API_KEY_URL_LABEL,
  EMBEDDING_API_KEY_URL_NOTE,
  EMBEDDING_CONSEQUENCE_NOTES,
  EMBEDDING_FIELD_NOTES,
  EMBEDDING_RELOAD_HINT,
  embeddingConsistencyView,
  embeddingSourceLabel,
  formatCharsK,
  formatDimensionCheckedAt,
  formatTimeoutSeconds,
  RESOURCE_TOPICS,
} = await vite.ssrLoadModule('/src/lib/resourcesPage.ts');
after(async () => vite.close());

describe('目录项', () => {
  const topic = RESOURCE_TOPICS.find((t) => t.id === 'embedding');

  it('新增「向量模型」在接入组，编号 04 不动既有 03', () => {
    assert.ok(topic, 'RESOURCE_TOPICS 应含 embedding');
    assert.equal(topic.group, 'access');
    assert.equal(topic.label, '向量模型');
    assert.equal(topic.title, '配置向量模型');
    assert.equal(topic.kicker, '04 · EMBED');
    assert.ok(topic.summary.includes('embedding'), 'summary 应点明它即 embedding');
  });

  it('既有三项编号不受影响', () => {
    const byId = new Map(RESOURCE_TOPICS.map((t) => [t.id, t]));
    assert.equal(byId.get('mcp').kicker, '01 · MCP');
    assert.equal(byId.get('skill').kicker, '02 · SKILL');
    assert.equal(byId.get('llm').kicker, '03 · LLM');
  });
});

describe('API Key 获取入口', () => {
  it('★ 地址与 README 权威源一致（README 改了这里没跟就会红）', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
    assert.ok(
      readme.includes(EMBEDDING_API_KEY_URL),
      `README.md 中未找到 ${EMBEDDING_API_KEY_URL} —— 前端常量与权威源已漂移`,
    );
    assert.equal(EMBEDDING_API_KEY_URL, 'https://platform.qianwenai.com/home/api-keys');
  });

  it('链接文案带限定语（baseURL 换成别家时这个地址不成立）', () => {
    assert.ok(EMBEDDING_API_KEY_URL_LABEL.includes('DashScope'));
    assert.ok(EMBEDDING_API_KEY_URL_NOTE.includes('默认'));
    assert.ok(EMBEDDING_API_KEY_URL_NOTE.includes('厂商'), '必须说明换厂商时向对应厂商索取');
  });
});

describe('配置片段与说明', () => {
  const snippet = buildEmbeddingConfigSnippet();

  it('含 6 个字段，且 apiKey 用 ${ENV_VAR} 引用（不写明文）', () => {
    assert.ok(snippet.startsWith('embedding:'));
    for (const key of ['provider', 'baseURL', 'model', 'dimension', 'apiKey', 'queryTimeoutMs']) {
      assert.ok(snippet.includes(`${key}:`), `片段缺 ${key}`);
    }
    assert.ok(snippet.includes('${DASHSCOPE_API_KEY}'));
    assert.equal(/sk-[A-Za-z0-9]/.test(snippet), false, '片段不得含明文密钥形态');
  });

  it('维度与重建口径都写进了字段说明', () => {
    assert.ok(EMBEDDING_FIELD_NOTES.some((n) => n.includes('dimension')));
    assert.ok(EMBEDDING_RELOAD_HINT.includes('无需重启'));
  });

  it('★ 片段用「当前生效值」，不硬编码维度（复制不能把 768 维写成 1024）', () => {
    const custom = buildEmbeddingConfigSnippet({
      provider: 'siliconflow',
      baseURL: 'https://api.example.com/v1',
      model: 'bge-large',
      dimension: 768,
      queryTimeoutMs: 5000,
    });
    assert.ok(custom.includes('provider: siliconflow'));
    assert.ok(custom.includes('baseURL: https://api.example.com/v1'));
    assert.ok(custom.includes('model: bge-large'));
    assert.ok(custom.includes('dimension: 768'));
    assert.ok(custom.includes('queryTimeoutMs: 5000'));
    assert.equal(custom.includes('1024'), false, '自定义 768 维时不得出现 1024');

    // 缺省 / 非法值回落内置默认，不渲染 NaN / undefined
    const fallback = buildEmbeddingConfigSnippet({ dimension: Number.NaN, model: '   ' });
    assert.ok(fallback.includes('dimension: 1024'));
    assert.ok(fallback.includes('model: qwen3.7-text-embedding-flash'));
    assert.equal(/undefined|NaN/.test(fallback), false);
  });

  it('★ 后果预告必须覆盖「换模型但不换维度」这条静默劣化', () => {
    const text = EMBEDDING_CONSEQUENCE_NOTES.join('\n');
    assert.ok(text.includes('rebuild-vector'), '必须给出重建命令');
    assert.ok(text.includes('维度不变'), '必须讲「换模型但维度不变」');
    assert.ok(text.includes('静默劣化'), '必须点明检索质量静默劣化');
    assert.ok(text.includes('ki doctor'), '必须指引先跑 doctor 验上游实际维度');
  });
});

describe('状态条文案', () => {
  it('未配置时必须点明「内置默认值，不是你的配置」', () => {
    const copy = describeEmbeddingStatus({ apiKeyConfigured: false, model: 'm', dimension: 1024 });
    assert.equal(copy.tone, 'warn');
    assert.ok(copy.title.includes('尚未配置'));
    assert.ok(copy.detail.includes('内置默认值'));
    assert.ok(copy.detail.includes('纯全文'));
  });

  it('已配置时展示模型与维度；有 warning 时用 warning 替换副文', () => {
    const ok = describeEmbeddingStatus({ apiKeyConfigured: true, model: 'm1', dimension: 1024 });
    assert.equal(ok.tone, 'ok');
    assert.ok(ok.title.includes('m1'));
    assert.ok(ok.title.includes('1024 维'));

    const warned = describeEmbeddingStatus({ apiKeyConfigured: true, model: 'm1', warning: '读文件失败' });
    assert.equal(warned.detail, '读文件失败');
  });

  it('★ 已配置时不宣称「可用」（本页没验证密钥有效性与连通性）', () => {
    const ok = describeEmbeddingStatus({ apiKeyConfigured: true, model: 'm1', dimension: 1024 });
    assert.equal(ok.detail.includes('向量化可用'), false, '只读配置不能断言可用');
    assert.ok(ok.detail.includes('ki doctor'), '应把可用性指向 doctor / 顶栏');
  });

  it('★ 上游不可用/无法确认时跟着顶栏降级（不得只凭配置文件显示绿）', () => {
    const down = describeEmbeddingStatus({
      apiKeyConfigured: true, model: 'm1', dimension: 1024,
      availability: { status: 'unavailable', reason: '密钥无效' },
    });
    assert.equal(down.tone, 'warn', '顶栏说不可用时页面不能是绿的');
    assert.ok(down.detail.includes('密钥无效'), '必须透出顶栏给的原因');
    assert.ok(down.detail.includes('降级为全文'));

    const unknown = describeEmbeddingStatus({
      apiKeyConfigured: true, model: 'm1', availability: { status: 'unknown' },
    });
    assert.equal(unknown.tone, 'warn');
    assert.ok(unknown.detail.includes('无法确认'));

    const available = describeEmbeddingStatus({
      apiKeyConfigured: true, model: 'm1', availability: { status: 'available' },
    });
    assert.equal(available.tone, 'ok');
  });

  it('无数据时为「状态未知」，不冒充已配置', () => {
    const copy = describeEmbeddingStatus(null);
    assert.equal(copy.tone, 'warn');
    assert.ok(copy.title.includes('未知'));
  });
});

describe('维度一致性', () => {
  it('未配置 API Key → 不判（不得出现「一致」）', () => {
    const view = embeddingConsistencyView({
      apiKeyConfigured: false, state: 'compatible', configured: 1024, persisted: 1024, scope: 's',
    });
    assert.equal(view.tone, 'off');
    assert.equal(view.text.includes('一致'), false);
    assert.equal(view.command, undefined);
  });

  it('失配 → warn + 可复制的重建命令带真实 scope', () => {
    const view = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'mismatch', configured: 1024, persisted: 768, scope: 'wiki',
    });
    assert.equal(view.tone, 'warn');
    assert.ok(view.text.includes('768'));
    assert.equal(view.command, 'ki restore wiki --rebuild-vector --yes');
  });

  it('★ persisted 缺失时不冒充「一致」（后端此刻确实返回 compatible）', () => {
    const view = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'compatible', configured: 1024, scope: 's',
    });
    assert.equal(view.tone, 'off');
    assert.equal(view.text.includes('一致'), false);
    assert.ok(view.text.includes('尚未建向量索引'));
  });

  it('一致 / 请求失败 / 快照缺失三态', () => {
    const ok = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'compatible', configured: 1024, persisted: 1024, scope: 's',
    });
    assert.equal(ok.tone, 'ok');
    assert.ok(ok.text.includes('一致'));

    // ★ 失败必须排在「无 persisted」之前：探测失败时 persisted 本来就没有，
    //   先判会把它说成「尚未建索引」，把故障伪装成正常
    const failed = embeddingConsistencyView({ apiKeyConfigured: true, state: 'unknown', hasError: true, scope: 's' });
    assert.equal(failed.tone, 'off');
    assert.equal(failed.text, '无法确认');
    assert.ok(failed.detail.includes('读取失败'));
    assert.ok(failed.detail.includes('ki doctor'));

    const probeFailed = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'unknown', statusError: 'zvec 打不开', scope: 's',
    });
    assert.equal(probeFailed.text, '无法确认');
    assert.ok(probeFailed.detail.includes('zvec 打不开'));

    const stale = embeddingConsistencyView({ apiKeyConfigured: true, state: 'unknown', scope: 's' });
    assert.equal(stale.tone, 'off');
    assert.equal(stale.text, '未确认');
    assert.ok(stale.detail.includes('快照缺失'));
  });
});

/**
 * 结论块分层（用户 2026-10-30：一句话药丸 → 状态卡 + 维度对比）。
 *
 * 页面同时消费 `headline`（主行短词）与 `compare`（维度对比数字），`text` 只作
 * aria-label / 降级文本。此处锁三件事：三者由同一分支产出、缺值时不硬造对比、
 * 文案不得再指向已删除的「重新检查」按钮。
 */
describe('一致性结论块', () => {
  it('一致 → headline 短词 + compare 相等关系', () => {
    const view = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'compatible', configured: 1024, persisted: 1024, scope: 's',
    });
    assert.equal(view.headline, '一致');
    assert.deepEqual(view.compare, { collection: 1024, configured: 1024, relation: 'eq' });
  });

  it('失配 → headline 不一致 + compare 失配关系 + 可复制命令', () => {
    const view = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'mismatch', configured: 1024, persisted: 768, scope: 'wiki',
    });
    assert.equal(view.headline, '不一致');
    assert.deepEqual(view.compare, { collection: 768, configured: 1024, relation: 'ne' });
    assert.equal(view.command, 'ki restore wiki --rebuild-vector --yes');
  });

  it('★ 配置维度未知时不给 compare（不得拿 persisted 顶替两边）', () => {
    const view = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'mismatch', persisted: 768, scope: 's',
    });
    assert.equal(view.tone, 'warn');
    assert.equal(view.compare, undefined);
    assert.ok(view.text.includes('768'));
  });

  it('未配置 Key / 未建索引 / 无法确认 → 都不给 compare', () => {
    const noKey = embeddingConsistencyView({
      apiKeyConfigured: false, state: 'compatible', configured: 1024, persisted: 1024, scope: 's',
    });
    assert.equal(noKey.headline, '暂不校验');
    assert.equal(noKey.compare, undefined);

    const noIndex = embeddingConsistencyView({ apiKeyConfigured: true, state: 'compatible', configured: 1024, scope: 's' });
    assert.equal(noIndex.headline, '尚未建向量索引');
    assert.equal(noIndex.compare, undefined);

    const failed = embeddingConsistencyView({ apiKeyConfigured: true, state: 'unknown', hasError: true, scope: 's' });
    assert.equal(failed.headline, '无法确认');
    assert.equal(failed.compare, undefined);
  });

  it('★ 文案不得再指向已删除的「重新检查」按钮，也不得承诺「自动更新」', () => {
    const views = [
      embeddingConsistencyView({ apiKeyConfigured: true, state: 'mismatch', configured: 1024, persisted: 768, scope: 's' }),
      embeddingConsistencyView({ apiKeyConfigured: true, state: 'unknown', hasError: true, scope: 's' }),
      embeddingConsistencyView({ apiKeyConfigured: true, state: 'unknown', scope: 's' }),
    ];
    for (const view of views) {
      assert.equal(`${view.headline}${view.text}${view.detail}`.includes('重新检查'), false);
    }
    // ★ 本页给的 rebuild 命令是 CLI 的，CLI 重建不产生 Web 任务记录 ⇒ AppShell 的任务完成
    //   失效钩子不触发，写「自动更新」就是假承诺（全站同口径是「完成后刷新页面」）。
    const mismatch = embeddingConsistencyView({
      apiKeyConfigured: true, state: 'mismatch', configured: 1024, persisted: 768, scope: 's',
    });
    assert.equal(mismatch.detail.includes('自动更新'), false);
    assert.ok(mismatch.detail.includes('刷新本页'));
  });
});

describe('检查时刻文案', () => {
  it('格式化到「月-日 时:分 检查」', () => {
    const ts = new Date(2026, 9, 30, 16, 12, 45).getTime();
    assert.equal(formatDimensionCheckedAt(ts), '10-30 16:12 检查');
  });

  it('缺值 / 非法值返回空串（页面据此不渲染这一格）', () => {
    assert.equal(formatDimensionCheckedAt(undefined), '');
    assert.equal(formatDimensionCheckedAt(Number.NaN), '');
    assert.equal(formatDimensionCheckedAt(Number.POSITIVE_INFINITY), '');
  });
});

/**
 * 单位换算（用户 2026-10-30：字符用「1000K」，超时用秒）。
 *
 * ★ 这里同时锁住「只改展示、不改配置片段」：snippet 是复制进 config.yaml 的内容，
 *   把 `requestTimeoutMs: 300000` 改写成 `300s` 会让人照着写错配置。
 */
describe('单位换算', () => {
  it('字符数 → K 刻度（去尾随零）', () => {
    assert.equal(formatCharsK(1_000_000), '1000K');
    assert.equal(formatCharsK(250_000), '250K');
    assert.equal(formatCharsK(1_500), '1.5K');
    assert.equal(formatCharsK(800), '800');
    assert.equal(formatCharsK(0), '0');
  });

  it('字符数异常值 → —', () => {
    assert.equal(formatCharsK(undefined), '—');
    assert.equal(formatCharsK(Number.NaN), '—');
    assert.equal(formatCharsK(-1), '—');
  });

  it('毫秒 → 秒', () => {
    assert.equal(formatTimeoutSeconds(300_000), '300s');
    assert.equal(formatTimeoutSeconds(3_000), '3s');
    assert.equal(formatTimeoutSeconds(1_500), '1.5s');
    assert.equal(formatTimeoutSeconds(0), '0s');
    assert.equal(formatTimeoutSeconds(undefined), '—');
    assert.equal(formatTimeoutSeconds(Number.NaN), '—');
  });

  it('★ 配置示例片段仍用 ms 原值（展示换算不得渗进 snippet）', () => {
    assert.ok(buildLlmConfigSnippet().includes('requestTimeoutMs: 300000'));
    assert.ok(buildEmbeddingConfigSnippet({ queryTimeoutMs: 3000 }).includes('queryTimeoutMs: 3000'));
  });
});

describe('来源角标', () => {
  it('只有内置默认才提示', () => {
    assert.equal(embeddingSourceLabel('builtin-default'), '内置默认');
    assert.equal(embeddingSourceLabel('configured'), '');
    assert.equal(embeddingSourceLabel(undefined), '');
  });
});
