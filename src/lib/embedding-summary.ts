/**
 * embedding-summary.ts —— 「资源 / 向量模型」页的只读摘要（REQ-20261030-001）
 *
 * 为什么单独成模块、不塞进 mcp-http-api：
 *   1) 「字段来自你的配置」还是「来自内置默认」这条判据必须能单测，不能埋在 handler 里；
 *   2) 本模块**只读文件，不发任何 embedding / zvec 请求** —— 页面每次进入都会调，必须廉价。
 *
 * ★ 为什么不复用 `GET /api/vector/status`：
 *   那个接口必须带 scope，且只回答「配置维度 vs 集合维度」；既没有 apiKey 是否配置，
 *   也没有「这个值是不是内置默认」。而这两项恰恰是本页要修的既有缺陷：
 *     D-1 总览把内置默认值当「已配置」显示（缺省回落 DEFAULT_EMBEDDING）；
 *     D-2 维度角标只看维度、不看 apiKey，没配 key 也可能显示绿色「集合一致」。
 *
 * ★ 安全：apiKey 只出**布尔**，绝不返回值 / 长度 / 前缀 / 尾部字符（防侧信道）。
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { KiConfig } from './config.js';

/** 字段来源：写在配置文件里 = configured，走内置兜底 = builtin-default */
export type EmbeddingFieldSource = 'configured' | 'builtin-default';

export interface EmbeddingFieldView<T> {
  value: T;
  source: EmbeddingFieldSource;
}

export interface EmbeddingSummary {
  /** 配置文件路径；用内置默认值运行（无配置文件）时为 null */
  configPath: string | null;
  provider: EmbeddingFieldView<string>;
  baseURL: EmbeddingFieldView<string>;
  model: EmbeddingFieldView<string>;
  dimension: EmbeddingFieldView<number>;
  queryTimeoutMs: EmbeddingFieldView<number>;
  /** **只出布尔**；`${ENV_VAR}` 引用的变量不存在时同样为 false（实际不可用） */
  apiKeyConfigured: boolean;
  /** 有配置文件但读不出来时：来源标记一律降级为 builtin-default，并在前端显式提示 */
  warning?: string;
}

interface RawEmbeddingResult {
  /** 文件里 `embedding` 段的内容；文件存在但无该段 = `{}` */
  fields: Record<string, unknown> | null;
  /** 有配置文件但读/解析失败 */
  readFailed: boolean;
}

/**
 * 读**原始**配置文件里的 `embedding` 段。
 *
 * ★ 为什么不用 `loadConfig()` 的结果：那个对象已经把缺省字段合并成内置默认值，
 *   信息已经丢了 —— 用户显式写 `dimension: 1024` 与「没写、兜底成 1024」在结果里一模一样，
 *   靠比较值是否等于默认值来猜来源会误判（显式写默认值是常见写法）。
 */
function readRawEmbedding(configPath: string | undefined): RawEmbeddingResult {
  if (!configPath) return { fields: null, readFailed: false };
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    const ext = path.extname(configPath).toLowerCase();
    const parsed = (ext === '.yaml' || ext === '.yml') ? YAML.parse(text) : JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { fields: {}, readFailed: false };
    const emb = (parsed as Record<string, unknown>).embedding;
    if (!emb || typeof emb !== 'object' || Array.isArray(emb)) return { fields: {}, readFailed: false };
    return { fields: emb as Record<string, unknown>, readFailed: false };
  } catch {
    // loadConfig 刚读过同一个文件并成功了 ⇒ 这里失败基本是并发删改，极罕见。
    // 降级为「来源未确认」而不是抛错：一个展示接口不该因此整页失败。
    return { fields: null, readFailed: true };
  }
}

/**
 * 「这个字段是否算用户配置过」。
 *
 * ★ 必须与 `config.ts` 的**合并表达式**逐字段同口径，否则会出现
 *   「值其实来自内置默认，却标成你的配置」——那正是 D-1 的同一个错误，只是方向相反：
 *     provider / baseURL / model → `raw.x ? String(x) : DEFAULT`（**truthy** 判断）
 *     dimension / queryTimeoutMs → `raw.x !== undefined ? Number(x) : DEFAULT`（**存在**判断）
 *   `provider: ''` 在 schema 里是合法字符串（无 validate），合并时会被当成缺省回落默认值，
 *   若这里按「存在」判定就会标成 configured。
 */
const STRING_FIELDS = new Set(['provider', 'baseURL', 'model']);

function isConfiguredField(fields: Record<string, unknown> | null, field: string): boolean {
  if (fields === null) return false;
  const raw = fields[field];
  if (raw === undefined) return false;
  return STRING_FIELDS.has(field) ? Boolean(raw) : true;
}

export function buildEmbeddingSummary(config: KiConfig): EmbeddingSummary {
  const emb = config.embedding;
  const { fields, readFailed } = readRawEmbedding(config._configPath);

  const sourceOf = (field: string): EmbeddingFieldSource =>
    isConfiguredField(fields, field) ? 'configured' : 'builtin-default';

  return {
    configPath: config._configPath ?? null,
    provider: { value: emb.provider, source: sourceOf('provider') },
    baseURL: { value: emb.baseURL, source: sourceOf('baseURL') },
    model: { value: emb.model, source: sourceOf('model') },
    dimension: { value: emb.dimension, source: sourceOf('dimension') },
    queryTimeoutMs: { value: emb.queryTimeoutMs, source: sourceOf('queryTimeoutMs') },
    apiKeyConfigured: Boolean(emb.apiKey),
    ...(readFailed
      ? { warning: '读取配置文件失败，无法区分「你的配置」与「内置默认」；下面的来源标记一律按内置默认显示' }
      : {}),
  };
}
