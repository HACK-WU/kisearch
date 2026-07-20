/**
 * embedding/siliconflow.ts —— SiliconFlow EmbeddingProvider 参考实现
 *
 * 与设计文档对齐：S-03 §4a.1 / §3.3 / §3.4 / §5
 *
 * 关键决策：
 *   - 不传 `dimensions` 请求参数（并非所有 OpenAI 兼容 provider 都支持）
 *   - 维度一致性完全由响应 embedding.length === dimension 校验保证
 *   - 重试：5xx/429/网络错 重试（指数退避 + Retry-After），4xx（非 429）不重试
 *   - 批间串行（避免触发限流）
 */

import { EmbeddingConfigError, EmbeddingError } from '../errors.js';
import type { EmbeddingProvider, EmbedOptions } from './provider.js';

export interface SiliconFlowProviderConfig {
  /** 可选；缺省从 process.env.SILICONFLOW_API_KEY 读；二者都无则构造时抛 EmbeddingConfigError */
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimension?: number;
  /** 单测可注入 mock fetch */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-8B';
const DEFAULT_DIMENSION = 4096;

const DEFAULT_RETRIES = 3;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;

interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

interface EmbeddingResponse {
  data?: EmbeddingResponseItem[];
}

export class SiliconFlowProvider implements EmbeddingProvider {
  readonly dimension: number;

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SiliconFlowProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env.SILICONFLOW_API_KEY;
    if (!apiKey) {
      throw new EmbeddingConfigError(
        'SiliconFlow apiKey missing: pass apiKey in config or set SILICONFLOW_API_KEY env',
      );
    }
    const dimension = config.dimension ?? DEFAULT_DIMENSION;
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new EmbeddingConfigError(
        `SiliconFlow dimension must be a positive integer, got: ${dimension}`,
      );
    }
    const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    if (!baseURL.startsWith('https://')) {
      throw new EmbeddingConfigError(
        `SiliconFlow baseURL must start with https://, got: ${baseURL}`,
      );
    }
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimension = dimension;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];

    const retries = opts?.retries ?? DEFAULT_RETRIES;
    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const onProgress = opts?.onProgress;

    const total = texts.length;
    const result: number[][] = new Array(total);
    let done = 0;

    for (let start = 0; start < total; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const vectors = await this.embedBatchWithRetry(batch, retries, timeoutMs);
      for (let i = 0; i < vectors.length; i++) {
        result[start + i] = vectors[i];
      }
      done += batch.length;
      if (onProgress) {
        try { onProgress(done, total); } catch { /* 回调异常静默 */ }
      }
    }

    return result;
  }

  private async embedBatchWithRetry(
    batch: string[],
    retries: number,
    timeoutMs: number,
  ): Promise<number[][]> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.embedBatchOnce(batch, timeoutMs);
      } catch (err) {
        const e = err as EmbeddingError;
        // 4xx（非 429）与响应结构错误不重试
        const nonRetryable = e.data?.nonRetryable === true;
        if (nonRetryable || attempt === retries) {
          throw e;
        }
        lastError = e;
        // 指数退避 + Retry-After 优先
        const retryAfterMs = (e.data?.retryAfterMs as number | undefined);
        const backoff = retryAfterMs ?? Math.min(1000 * 2 ** attempt, 8000);
        await sleep(backoff);
      }
    }
    throw lastError ?? new EmbeddingError('embed batch failed with unknown error');
  }

  private async embedBatchOnce(batch: string[], timeoutMs: number): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await this.fetchImpl(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const status = resp.status;
        const text = await safeReadText(resp);
        const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
        // 5xx / 429 可重试；其他 4xx 不可重试
        const nonRetryable = status >= 400 && status < 500 && status !== 429;
        throw new EmbeddingError(
          `SiliconFlow /embeddings HTTP ${status}: ${truncate(text, 300)}`,
          { code: `HTTP_${status}`, data: { status, nonRetryable, retryAfterMs } },
        );
      }

      const json = (await resp.json()) as EmbeddingResponse;
      const data = json.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new EmbeddingError(
          `SiliconFlow response data length mismatch: expected ${batch.length}, got ${data?.length ?? 'undefined'}`,
          { data: { nonRetryable: true } },
        );
      }

      // 按 index 排序对齐输入顺序（防御 provider 乱序返回）
      const sorted = [...data].sort((a, b) => a.index - b.index);
      return sorted.map((item, i) => {
        if (!Array.isArray(item.embedding)) {
          throw new EmbeddingError(
            `SiliconFlow response item[${i}] embedding is not an array`,
            { data: { nonRetryable: true } },
          );
        }
        if (item.embedding.length !== this.dimension) {
          throw new EmbeddingError(
            `SiliconFlow response item[${i}] dimension mismatch: expected ${this.dimension}, got ${item.embedding.length}`,
            { data: { nonRetryable: true, expectedDim: this.dimension, actualDim: item.embedding.length } },
          );
        }
        return item.embedding;
      });
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      const e = err as Error & { name?: string };
      if (e.name === 'AbortError') {
        throw new EmbeddingError(
          `SiliconFlow /embeddings timeout after ${timeoutMs}ms`,
          { code: 'TIMEOUT', data: { nonRetryable: false } },
        );
      }
      // 网络错误（fetch reject）可重试
      throw new EmbeddingError(
        `SiliconFlow /embeddings network error: ${e.message}`,
        { code: 'NETWORK', data: { nonRetryable: false } },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── 内部工具 ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}
