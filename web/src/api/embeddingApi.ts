/**
 * embeddingApi.ts —— 「资源 / 向量模型」页的只读接口（REQ-20261030-001）
 *
 * 对应后端 `GET /api/embedding/summary`（`src/lib/embedding-summary.ts`）：
 * 纯读配置文件，不触发 embedding 请求、不打开 zvec，可高频调用。
 *
 * ★ 与 `/api/vector/status` 的分工：
 *   那个接口按 scope 回答「配置维度 vs 集合维度」；本接口回答「配置本身是什么、哪些是内置默认」。
 *   页面两者都要，但**只共用同一份缓存**（维度状态走 `hooks.useVectorDimensionStatus`）。
 */

export type EmbeddingFieldSource = 'configured' | 'builtin-default';

export interface EmbeddingFieldView<T> {
  value: T;
  source: EmbeddingFieldSource;
}

export interface EmbeddingSummary {
  ok: boolean;
  /** 无配置文件（全内置默认）时为 null */
  configPath: string | null;
  provider: EmbeddingFieldView<string>;
  baseURL: EmbeddingFieldView<string>;
  model: EmbeddingFieldView<string>;
  dimension: EmbeddingFieldView<number>;
  queryTimeoutMs: EmbeddingFieldView<number>;
  /** 后端只出布尔，永不含密钥内容 */
  apiKeyConfigured: boolean;
  warning?: string;
  error?: string;
}

/**
 * 读向量模型摘要。
 *
 * ★ 404 / 字段缺失按「旧 daemon」处理：抛出的 Error 由页面渲染成
 *   「后端版本较旧，重启 ki mcp --http 后重试」，而不是整页白屏。
 */
export async function getEmbeddingSummary(): Promise<EmbeddingSummary> {
  const res = await fetch('/api/embedding/summary', { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    throw Object.assign(
      new Error('后端未提供 /api/embedding/summary（daemon 版本较旧），请重启 ki mcp --http 后刷新页面'),
      { status: 404 },
    );
  }
  const body = await res.json().catch(() => ({})) as EmbeddingSummary;
  if (!res.ok) {
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return body;
}
