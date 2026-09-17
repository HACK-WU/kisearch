/**
 * embedding/batch-scheduler.ts —— 有界 Embedding 批调度器（REQ-20260914-001）
 *
 * 调度器只负责 provider 调用的并发、背压和批次生命周期；zvec 写入仍由
 * ZvecEngine 的单一写链串行完成。这样可以把外部网络等待与本地持久化解耦，
 * 同时不会把 zvec 的单写约束误当成可并行写入。
 */

import os from 'node:os';
import type { EmbeddingAttemptEvent, EmbeddingProvider, EmbedOptions } from './provider.js';

export interface EmbeddingSchedulerConfig {
  /** provider 单次逻辑调用的文本批大小 */
  batchSize: number;
  /** 单任务同时在 provider 中等待/执行的逻辑调用数 */
  maxConcurrency: number;
  /** daemon 内所有任务共享的逻辑调用槽数量 */
  maxGlobalConcurrency: number;
  /** 单任务允许预取的批次数；当前实现以 worker 窗口实现该上限 */
  maxPrefetchBatches: number;
  /** 单任务可占用的待持久化向量估算字节数 */
  maxBufferedVectorBytes: number;
  /** daemon 内所有任务共享的待持久化向量估算字节数 */
  globalBufferedVectorBytes: number;
  /**
   * 单次 provider 请求的超时（ms）。超时按 provider 既有策略重试，
   * 故单批最坏耗时 ≈ 本值 ×(重试次数 + 1) + 退避；长文本（wiki 全文）可适当调大。
   */
  requestTimeoutMs: number;
}

/**
 * 默认值依据实测标定（真实 SiliconFlow + wiki 全文负载）：
 *   - batchSize 16：单批约 18 万字符 ≈ 10s，距 requestTimeoutMs(60s) 有 5 倍余量；
 *     旧的 64（单批约 76 万字符 ≈ 41s）在并发排队下会击穿超时线，是历史上整批失败的成因。
 *   - maxConcurrency / maxGlobalConcurrency 25：实测 20 并发即可跑完 rebuild（23/23 批、0 失败批），
 *     25 为同量级上限；若 provider 出现 429/超时，优先下调本值。
 *   - maxPrefetchBatches 必须 ≥ maxConcurrency，否则实际并发会被它静默压低（workerCount 取 min）。
 */
export const DEFAULT_EMBEDDING_SCHEDULER: EmbeddingSchedulerConfig = {
  batchSize: 16,
  maxConcurrency: 25,
  maxGlobalConcurrency: 25,
  maxPrefetchBatches: 25,
  maxBufferedVectorBytes: 64 * 1024 * 1024,
  globalBufferedVectorBytes: 128 * 1024 * 1024,
  requestTimeoutMs: 60_000,
};

/** 单请求超时上限：再大就不是调优而是配置事故——一次失败重试即十几分钟，且与重试次数相乘。 */
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

export function normalizeEmbeddingScheduler(
  config?: Partial<EmbeddingSchedulerConfig>,
): EmbeddingSchedulerConfig {
  const merged = { ...DEFAULT_EMBEDDING_SCHEDULER, ...(config ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`embedding.scheduler.${key} 必须是正整数，实际=${value}`);
    }
  }
  // maxPrefetchBatches 是内部预取窗口，对用户没有业务语义：未显式配置时自动跟随
  // maxConcurrency，避免"只想改并发、却被迫同时配对预取"的陷阱（只写 maxConcurrency 即可生效）。
  // 仅当用户显式写出矛盾值时才 fail-loud（意图明确但自相矛盾，不能替他猜）。
  if (config?.maxPrefetchBatches === undefined && merged.maxPrefetchBatches < merged.maxConcurrency) {
    merged.maxPrefetchBatches = merged.maxConcurrency;
  }
  // 成对约束的报错必须给出实际值、默认值来源与修复动作，否则用户不知道"该改哪个、改成多少"。
  if (merged.maxConcurrency > merged.maxGlobalConcurrency) {
    throw new Error(
      'embedding.scheduler.maxConcurrency 不能大于 maxGlobalConcurrency'
      + `（当前 maxConcurrency=${merged.maxConcurrency}，maxGlobalConcurrency=${merged.maxGlobalConcurrency}`
      + `${config?.maxGlobalConcurrency === undefined ? '，后者来自默认值' : ''}；`
      + `修复：调小 maxConcurrency，或在配置中同时把 maxGlobalConcurrency 设为 ≥ ${merged.maxConcurrency}）`,
    );
  }
  if (merged.maxPrefetchBatches < merged.maxConcurrency) {
    throw new Error(
      'embedding.scheduler.maxPrefetchBatches 不能小于 maxConcurrency'
      + `（当前 maxPrefetchBatches=${merged.maxPrefetchBatches}，maxConcurrency=${merged.maxConcurrency}；`
      + '修复：删除配置中的 maxPrefetchBatches（省略时会自动跟随 maxConcurrency）、把它调到不低于 maxConcurrency，'
      + '或把 maxConcurrency 调到不高于它）',
    );
  }
  if (merged.batchSize > 1000) {
    throw new Error(`embedding.scheduler.batchSize 不能大于 1000（当前 batchSize=${merged.batchSize}）`);
  }
  if (merged.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `embedding.scheduler.requestTimeoutMs 不能大于 ${MAX_REQUEST_TIMEOUT_MS}（当前 requestTimeoutMs=${merged.requestTimeoutMs}；`
      + '超时越大，单批失败重试的总耗时按倍数放大——需要更长超时请优先减小 batchSize）',
    );
  }
  if (merged.maxBufferedVectorBytes > merged.globalBufferedVectorBytes) {
    throw new Error(
      'embedding.scheduler.maxBufferedVectorBytes 不能大于 globalBufferedVectorBytes'
      + `（当前 maxBufferedVectorBytes=${merged.maxBufferedVectorBytes}，globalBufferedVectorBytes=${merged.globalBufferedVectorBytes}）`,
    );
  }
  return merged;
}

export interface EmbeddingBatchItem<T> {
  item: T;
  inputIndex: number;
  docId: string;
}

export interface EmbeddingBatch<T> {
  batchIndex: number;
  items: EmbeddingBatchItem<T>[];
  /** 与 items 一一对应；provider 整批失败时全部为 null。 */
  vectors: Array<number[] | null>;
  /** 仅在批次被拆分隔离后使用；与 items 一一对应。 */
  itemErrors?: Array<Error | undefined>;
  error?: Error;
}

export interface BatchPersistOutcome {
  /** zvec 与必要元数据均成功 */
  persisted: number;
  /** 没有可用成功结果的条目 */
  failed: number;
  /** zvec 成功但元数据回调未完成的条目 */
  metadataPending?: number;
}

export interface EmbeddingScheduleResult {
  attempted: number;
  persisted: number;
  metadataPending: number;
  failed: number;
  cancelled: number;
  cancelledItems: EmbeddingBatchItem<unknown>[];
  failedItems: EmbeddingBatchItem<unknown>[];
  errors: Error[];
  fatalError?: Error;
}

export interface EmbeddingScheduler {
  readonly config: EmbeddingSchedulerConfig;
  schedule<T>(
    provider: EmbeddingProvider,
    items: T[],
    options: {
      getText: (item: T) => string;
      getDocId: (item: T) => string;
      /** 保持既有单批文本复用语义；不跨批缓存，不改变失败粒度。 */
      dedupeKey?: (item: T) => string;
      abortSignal?: AbortSignal;
      onBatchComplete: (batch: EmbeddingBatch<T>) => Promise<BatchPersistOutcome | void> | BatchPersistOutcome | void;
    },
  ): Promise<EmbeddingScheduleResult>;
  getMetrics(): EmbeddingSchedulerMetrics;
}

export interface EmbeddingSchedulerMetrics {
  activeTasks: number;
  inFlightRequests: number;
  bufferedVectorBytes: number;
  submittedBatches: number;
  completedBatches: number;
  failedBatches: number;
  cancelledItems: number;
  providerRequests: number;
  retries: number;
  rateLimited: number;
  timeouts: number;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  return Object.assign(new Error('向量化已取消'), { code: 'VECTORIZE_CANCELLED' });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isSplittableParameterError(error: Error): boolean {
  const candidate = error as Error & { code?: string };
  // SiliconFlow 20015 表示请求参数非法；批次中只要有一个坏文本，整批都会被拒绝。
  // 只对这个明确的 provider 错误做逐条隔离，避免把认证/模型配置等 4xx 误当成可恢复错误。
  return candidate.code === 'HTTP_400'
    && /(?:20015|parameter is invalid)/i.test(error.message);
}

/** 参数错误隔离的请求上限，避免用户把 batchSize 调大后一次生成大量单条请求。 */
const MAX_PARAMETER_ERROR_ISOLATION_ITEMS = 64;

/** FIFO、支持 AbortSignal 的逻辑调用槽。 */
class AsyncLimiter {
  private used = 0;
  private readonly waiters: Waiter<() => void>[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('limiter capacity must be positive');
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter<() => void> = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (this.used < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.onAbort && waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortError());
        continue;
      }
      this.used++;
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.used--;
        this.pump();
      });
    }
  }
}

/** FIFO 字节背压器；单条向量大于容量时 fail-loud，避免永久等待。 */
class ByteLimiter {
  private used = 0;
  private readonly waiters: Array<Waiter<() => void> & { bytes: number }> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('byte limiter capacity must be positive');
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > this.capacity) {
      return Promise.reject(new Error(`向量批次估算 ${bytes} bytes 超过背压容量 ${this.capacity} bytes`));
    }
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, bytes } as ArrayElement<ByteLimiter['waiters']>;
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.signal?.aborted) {
        this.waiters.shift();
        waiter.onAbort && waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortError());
        continue;
      }
      if (this.used + waiter.bytes > this.capacity) return;
      this.waiters.shift();
      this.used += waiter.bytes;
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.used -= waiter.bytes;
        this.pump();
      });
    }
  }
}

type ArrayElement<T> = T extends Array<infer E> ? E : never;

/** daemon 进程内共享；每个任务只创建自己的 task limiter。 */
export class EmbeddingSchedulerRuntime implements EmbeddingScheduler {
  readonly config: EmbeddingSchedulerConfig;
  private readonly globalRequests: AsyncLimiter;
  private readonly globalBuffers: ByteLimiter;
  private readonly metrics: EmbeddingSchedulerMetrics = {
    activeTasks: 0,
    inFlightRequests: 0,
    bufferedVectorBytes: 0,
    submittedBatches: 0,
    completedBatches: 0,
    failedBatches: 0,
    cancelledItems: 0,
    providerRequests: 0,
    retries: 0,
    rateLimited: 0,
    timeouts: 0,
  };

  constructor(config?: Partial<EmbeddingSchedulerConfig>) {
    this.config = normalizeEmbeddingScheduler(config);
    this.globalRequests = new AsyncLimiter(this.config.maxGlobalConcurrency);
    this.globalBuffers = new ByteLimiter(this.config.globalBufferedVectorBytes);
  }

  getMetrics(): EmbeddingSchedulerMetrics {
    return { ...this.metrics };
  }

  /** RSS admission guard：连续 3 次超过 70% 时停止发起新批次，低于 60% 连续 3 次恢复。 */
  private async waitForMemory(signal?: AbortSignal): Promise<void> {
    let highSamples = 0;
    let recoveredSamples = 0;
    let guardSamples = 0;
    let paused = false;
    while (true) {
      const rss = process.memoryUsage().rss;
      const available = os.freemem();
      if (!paused) {
        if (available > 0 && rss > available * 0.7) highSamples++;
        else highSamples = 0;
        if (highSamples < 3) {
          if (highSamples === 0) return;
          await wait(250, signal);
          continue;
        }
        paused = true;
      } else {
        guardSamples++;
        if (available > 0 && rss < available * 0.6) recoveredSamples++;
        else recoveredSamples = 0;
        if (recoveredSamples >= 3) return;
      }
      if (guardSamples >= 120) {
        throw Object.assign(new Error(
          `Embedding 因 RSS admission guard 暂停超过 30s（rss=${rss}，available=${available}）；` +
          '请降低并发/批大小或释放 daemon 资源后重试',
        ), { code: 'VECTORIZE_RESOURCE_ADMISSION' });
      }
      await wait(250, signal);
    }
  }

  async schedule<T>(
    provider: EmbeddingProvider,
    items: T[],
    options: {
      getText: (item: T) => string;
      getDocId: (item: T) => string;
      dedupeKey?: (item: T) => string;
      abortSignal?: AbortSignal;
      onBatchComplete: (batch: EmbeddingBatch<T>) => Promise<BatchPersistOutcome | void> | BatchPersistOutcome | void;
    },
  ): Promise<EmbeddingScheduleResult> {
    const taskRequests = new AsyncLimiter(this.config.maxConcurrency);
    const taskBuffers = new ByteLimiter(this.config.maxBufferedVectorBytes);
    const batches: EmbeddingBatchItem<T>[][] = [];
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const docId = options.getDocId(item);
      if (!docId || seen.has(docId)) {
        throw Object.assign(new Error(`Embedding 批次映射非法：docId 缺失或重复（${docId || '<empty>'}）`), {
          code: 'EMBED_ITEM_MAPPING_INVALID',
        });
      }
      seen.add(docId);
      const batchIndex = Math.floor(i / this.config.batchSize);
      (batches[batchIndex] ??= []).push({ item, inputIndex: i, docId });
    }
    this.metrics.activeTasks++;

    const result: EmbeddingScheduleResult = {
      attempted: 0,
      persisted: 0,
      metadataPending: 0,
      failed: 0,
      cancelled: 0,
      cancelledItems: [],
      failedItems: [],
      errors: [],
    };
    const estimatedBatchBytes = Math.max(
      1,
      Math.min(this.config.batchSize, Math.max(1, items.length))
        * provider.dimension
        * Float64Array.BYTES_PER_ELEMENT,
    );
    if (estimatedBatchBytes > this.config.maxBufferedVectorBytes
      || estimatedBatchBytes > this.config.globalBufferedVectorBytes) {
      throw Object.assign(new Error(
        `Embedding 单批估算 ${estimatedBatchBytes} bytes 超过配置缓冲上限（任务 ${this.config.maxBufferedVectorBytes}，全局 ${this.config.globalBufferedVectorBytes}）`,
      ), { code: 'VECTOR_BUFFER_LIMIT_INVALID' });
    }
    let nextBatch = 0;
    let fatalError: Error | undefined;
    const workerCount = Math.min(this.config.maxConcurrency, this.config.maxPrefetchBatches, Math.max(1, batches.length));

    const cancelRemaining = (): void => {
      for (; nextBatch < batches.length; nextBatch++) {
        const rest = batches[nextBatch].map((entry) => entry as EmbeddingBatchItem<unknown>);
        result.cancelledItems.push(...rest);
        result.cancelled += rest.length;
        this.metrics.cancelledItems += rest.length;
      }
    };

    const worker = async (): Promise<void> => {
      while (true) {
        if (fatalError || options.abortSignal?.aborted) {
          cancelRemaining();
          return;
        }
        const batchIndex = nextBatch++;
        if (batchIndex >= batches.length) return;
        const batchItems = batches[batchIndex];
        // provider 返回的是 JS number[][]，单个 number 按 8 bytes 估算；不能用
        // 最终 zvec payload 的 Float32Array 4 bytes 低估 Node heap 背压。
        const bytes = Math.max(1, batchItems.length * provider.dimension * Float64Array.BYTES_PER_ELEMENT);
        let bufferCounted = false;
        let releaseTaskRequest: (() => void) | undefined;
        let releaseGlobalRequest: (() => void) | undefined;
        let releaseTaskBuffer: (() => void) | undefined;
        let releaseGlobalBuffer: (() => void) | undefined;
        try {
          await this.waitForMemory(options.abortSignal);
          releaseTaskBuffer = await taskBuffers.acquire(bytes, options.abortSignal);
          releaseGlobalBuffer = await this.globalBuffers.acquire(bytes, options.abortSignal);
          releaseTaskRequest = await taskRequests.acquire(options.abortSignal);
          releaseGlobalRequest = await this.globalRequests.acquire(options.abortSignal);
          if (options.abortSignal?.aborted) {
            result.cancelledItems.push(...batchItems.map((entry) => entry as EmbeddingBatchItem<unknown>));
            result.cancelled += batchItems.length;
            continue;
          }

          result.attempted += batchItems.length;
          this.metrics.submittedBatches++;
          this.metrics.bufferedVectorBytes += bytes;
          bufferCounted = true;
          const requestTexts: string[] = [];
          const requestIndexByKey = new Map<string, number>();
          const requestIndexForItem: number[] = [];
          for (const item of batchItems) {
            const text = options.getText(item.item);
            const key = options.dedupeKey?.(item.item) ?? `__item_${item.inputIndex}`;
            let requestIndex = requestIndexByKey.get(key);
            if (requestIndex === undefined) {
              requestIndex = requestTexts.length;
              requestIndexByKey.set(key, requestIndex);
              requestTexts.push(text);
            }
            requestIndexForItem.push(requestIndex);
          }
          let vectors: Array<number[] | null>;
          let itemErrors: Array<Error | undefined> | undefined;
          let providerError: Error | undefined;
          try {
            // global request permit intentionally covers the complete logical provider call,
            // including provider-owned retry/backoff; release happens only in finally.
            this.metrics.inFlightRequests++;
            const embedOptions: EmbedOptions = {
              batchSize: requestTexts.length,
              // 超时由调度配置统一提供：provider 内部按本值起 AbortController，
              // 未传时回落到 provider 自身默认（30s）。
              timeoutMs: this.config.requestTimeoutMs,
              onAttempt: (event: EmbeddingAttemptEvent) => {
                if (event.kind === 'request') this.metrics.providerRequests++;
                else {
                  this.metrics.retries++;
                  if (event.reason?.includes('429')) this.metrics.rateLimited++;
                  if (event.reason?.includes('timeout')) this.metrics.timeouts++;
                }
              },
            };
            try {
              const batchVectors = await provider.embed(requestTexts, embedOptions);
              if (batchVectors.length !== requestTexts.length || batchVectors.some((v) => v.length !== provider.dimension)) {
                throw new Error(`Embedding 返回数量/维度不匹配：期望 ${requestTexts.length}×${provider.dimension}，实际 ${batchVectors.length}`);
              }
              vectors = requestIndexForItem.map((index) => batchVectors[index]);
            } catch (err) {
              const batchError = err instanceof Error ? err : new Error(String(err));
              if (
                !isSplittableParameterError(batchError)
                || requestTexts.length <= 1
                || requestTexts.length > MAX_PARAMETER_ERROR_ISOLATION_ITEMS
              ) {
                throw batchError;
              }

              // 只隔离参数错误批次：成功的文本仍然可以落库，坏文本保留逐项错误。
              const isolatedVectors: Array<number[] | null> = [];
              const isolatedErrors: Array<Error | undefined> = [];
              for (const text of requestTexts) {
                try {
                  const singleVectors = await provider.embed([text], { ...embedOptions, batchSize: 1 });
                  if (singleVectors.length !== 1 || singleVectors[0].length !== provider.dimension) {
                    throw new Error(`Embedding 返回数量/维度不匹配：期望 1×${provider.dimension}，实际 ${singleVectors.length}`);
                  }
                  isolatedVectors.push(singleVectors[0]);
                  isolatedErrors.push(undefined);
                } catch (singleErr) {
                  const error = singleErr instanceof Error ? singleErr : new Error(String(singleErr));
                  isolatedVectors.push(null);
                  isolatedErrors.push(error);
                }
              }
              vectors = requestIndexForItem.map((index) => isolatedVectors[index]);
              itemErrors = requestIndexForItem.map((index) => isolatedErrors[index]);
            }
          } catch (err) {
            providerError = err instanceof Error ? err : new Error(String(err));
            vectors = [];
          } finally {
            this.metrics.inFlightRequests = Math.max(0, this.metrics.inFlightRequests - 1);
          }
          const completed: EmbeddingBatch<T> = {
            batchIndex,
            items: batchItems,
            vectors: providerError ? batchItems.map(() => null) : vectors,
            itemErrors: providerError ? undefined : itemErrors,
            error: providerError,
          };
          try {
            const outcome = await options.onBatchComplete(completed);
            const itemFailureCount = completed.vectors.filter((vector) => vector === null).length;
            if (outcome) {
              result.persisted += outcome.persisted;
              result.failed += outcome.failed;
              result.metadataPending += outcome.metadataPending ?? 0;
            } else if (providerError) {
              result.failed += batchItems.length;
            } else {
              result.persisted += batchItems.length - itemFailureCount;
              result.failed += itemFailureCount;
            }
            this.metrics.completedBatches++;
            if (providerError || itemFailureCount > 0) this.metrics.failedBatches++;
            if (providerError) result.errors.push(providerError);
          } catch (err) {
            fatalError = err instanceof Error ? err : new Error(String(err));
            result.errors.push(fatalError);
            this.metrics.failedBatches++;
            // 当前批次已经拿到 provider 结果但尚未完成持久化回调；按未确认处理。
            result.failedItems.push(...batchItems.map((entry) => entry as EmbeddingBatchItem<unknown>));
            result.failed += batchItems.length;
            cancelRemaining();
            return;
          }
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if ((e as Error & { code?: string }).code === 'VECTORIZE_CANCELLED' || options.abortSignal?.aborted) {
            result.cancelledItems.push(...batchItems.map((entry) => entry as EmbeddingBatchItem<unknown>));
            result.cancelled += batchItems.length;
            this.metrics.cancelledItems += batchItems.length;
          } else {
            fatalError = e;
            result.errors.push(e);
            result.failedItems.push(...batchItems.map((entry) => entry as EmbeddingBatchItem<unknown>));
            result.failed += batchItems.length;
            this.metrics.failedBatches++;
            cancelRemaining();
          }
          return;
        } finally {
          releaseGlobalRequest?.();
          releaseTaskRequest?.();
          releaseGlobalBuffer?.();
          releaseTaskBuffer?.();
          if (bufferCounted) this.metrics.bufferedVectorBytes = Math.max(0, this.metrics.bufferedVectorBytes - bytes);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    this.metrics.activeTasks = Math.max(0, this.metrics.activeTasks - 1);
    result.fatalError = fatalError;
    return result;
  }
}
