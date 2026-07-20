/**
 * embedding/provider.ts —— EmbeddingProvider 抽象
 *
 * 与设计文档对齐：S-03 §4a.1
 *
 * 方案 X：embed 在主线程执行；产出向量经 Float32Array + Transferable 传 worker。
 */

export interface EmbedOptions {
  /** 失败重试次数，默认 3 */
  retries?: number;
  /** 分批大小（避免限流），默认 64；失败粒度 = 小批 */
  batchSize?: number;
  /** 单批超时，默认 30000 */
  timeoutMs?: number;
  /** 进度回调 */
  onProgress?: (done: number, total: number) => void;
}

export interface EmbeddingProvider {
  /** 输出向量维度；必须 === ZvecEngineConfig.collection.dimension */
  readonly dimension: number;
  /**
   * 文本 → 向量。返回长度 === texts.length，每条向量长度 === dimension。
   * 小批失败时抛 EmbeddingError（携带该批文本范围信息）。
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}
