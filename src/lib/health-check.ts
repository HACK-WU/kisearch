/**
 * health-check.ts —— ki 配置健康诊断（REQ-16）
 *
 * 供 `ki doctor` 命令与 `ki mcp` 启动预检共用同一套只读检查逻辑。
 *
 * 设计要点：
 *   - 纯只读：不修改任何配置或数据
 *   - 配置文件检查涵盖语法（YAML/JSON 解析）与字段级校验（名称/类型/取值，
 *     见 config-schema.ts）：字段不合法时 loadConfig 直接抛错，本检查项只在加载成功后报告
 *   - embedding 检查用 1 条最短文本（"test"）发一次真实请求，三合一验证
 *     URL 连通性 + 密钥有效性 + 维度匹配（复用 SiliconFlowProvider 现成错误语义）
 *   - 探测预算默认 8s ×(1+1 次重试)，可经 options.embeddingProbe 按调用方收紧；
 *     健康检查默认将 embedding 失败记为 fail，MCP 启动预检与 /api/health 显式降级为 warn，
 *     避免外部服务故障阻断 MCP / 误报服务不可用。401/403、配置非法、维度不符属
 *     non-degradable，任何调用方都保持 fail（真配置错误不被告警掩盖）。
 *   - 给本检查套请求级 deadline 的调用方，须用 healthCheckWorstCaseMs() 推导预算上界
 *   - zvec Collection 用按 scope 根目录下的子目录判定（不 open，避开与常驻 server 的文件锁冲突）
 */

import fs from 'fs';
import { SiliconFlowProvider } from '../../dist/zvec-engine/index.js';
import type { KiConfig } from './config.js';
import { getVectorDir, getEmbeddingConfig, runWithConfigSnapshot } from './config.js';
import { getCollectionsRoot } from './scope-collection.js';
import { getVectorDimensionStatus } from './vector-client.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface HealthItem {
  name: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  items: HealthItem[];
  pass: number;
  warn: number;
  fail: number;
}

/** embedding 探测单次超时默认值（ms） */
export const EMBED_PROBE_TIMEOUT_MS = 8_000;
/** embedding 探测重试次数默认值 */
export const EMBED_PROBE_RETRIES = 1;
/** 探测重试的指数退避基数（与 SiliconFlowProvider.embedBatchWithRetry 同源） */
const EMBED_PROBE_BACKOFF_MS = 1_000;

/**
 * runHealthCheck 的最坏耗时上界（仅 embedding 探测一项可能慢，其余为本地文件检查）。
 * 给本检查套外层预算的调用方（如 /api/health）必须用本函数取值，否则两层预算会各自漂移——
 * 曾经外层 10s < 内层 17s，导致慢子检查把整份报告一起丢掉。
 */
export function healthCheckWorstCaseMs(
  timeoutMs = EMBED_PROBE_TIMEOUT_MS,
  retries = EMBED_PROBE_RETRIES,
): number {
  let total = timeoutMs * (retries + 1);
  for (let attempt = 0; attempt < retries; attempt++) {
    total += Math.min(EMBED_PROBE_BACKOFF_MS * 2 ** attempt, 8_000);
  }
  return total;
}

export interface HealthCheckOptions {
  /**
   * embedding 探测失败的严重级别。doctor 默认 fail；MCP 启动预检与 /api/health 使用 warn，
   * 让关键词检索等不依赖 embedding 的能力仍可启动/上报。
   */
  embeddingFailure?: 'fail' | 'warn';
  /**
   * embedding 探测的时间预算。受外层请求预算约束的调用方（/api/health）应收紧，
   * 使最坏耗时落在自身 deadline 之内。缺省 8s ×(1+1 次重试)。
   */
  embeddingProbe?: { timeoutMs: number; retries: number };
  /** HTTP 健康接口不能在迁移切换窗口打开 Collection；doctor 保留完整诊断。 */
  checkCollectionDimensions?: boolean;
  /** 启动预检提示维度冲突，但允许全文搜索与迁移命令继续可用。 */
  collectionDimensionFailure?: 'fail' | 'warn';
}

interface EmbeddingCheckResult {
  items: HealthItem[];
  /** 缺少 apiKey 或可重试的网络/HTTP 故障，可在 MCP 启动预检中降级。 */
  degradable: boolean;
}

/** 目录存在且可写检查 */
function checkDir(name: string, dir: string): HealthItem {
  if (!fs.existsSync(dir)) {
    return { name, status: 'fail', detail: `${dir} 不存在` };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { name, status: 'fail', detail: `${dir} 无写权限` };
  }
  return { name, status: 'pass', detail: `${dir} 存在且可写` };
}

/**
 * embedding 三合一检查：发 1 条最短请求，按错误语义拆分为
 * URL 连通性 / 密钥有效性 / 维度匹配 三个报告项。
 */
async function checkEmbedding(
  config: KiConfig,
  probe: { timeoutMs: number; retries: number },
): Promise<EmbeddingCheckResult> {
  const emb = getEmbeddingConfig(config);
  const nameConn = 'URL 连通性';
  const nameKey = '密钥有效性';
  const nameDim = '维度匹配';

  // 有效密钥：仅取配置 apiKey（明文 / ${ENV_VAR} 已解析）。
  // 不做隐式 env 回退：提供商由 baseURL 自由配置，固定厂商密钥变量不应跨厂商注入。
  const effectiveApiKey = emb.apiKey;

  // apiKey 缺失时无法发起请求；MCP 启动可降级提示，但 doctor/API 仍如实报失败。
  if (!effectiveApiKey) {
    const detail = '未配置 embedding.apiKey（明文或 ${VAR_NAME} 引用），跳过检查';
    return {
      items: [
        { name: nameConn, status: 'fail', detail },
        { name: nameKey, status: 'fail', detail },
        { name: nameDim, status: 'fail', detail },
      ],
      degradable: true,
    };
  }

  let provider: SiliconFlowProvider;
  try {
    provider = new SiliconFlowProvider({
      baseURL: emb.baseURL,
      model: emb.model,
      dimension: emb.dimension,
      apiKey: effectiveApiKey,
    });
  } catch (err) {
    // 构造期错误（EmbeddingConfigError）：apiKey / baseURL 非法
    const detail = (err as Error).message;
    return {
      items: [
        { name: nameConn, status: 'fail', detail },
        { name: nameKey, status: 'fail', detail },
        { name: nameDim, status: 'fail', detail },
      ],
      degradable: false,
    };
  }

  try {
    const vectors = await provider.embed(['test'], {
      timeoutMs: probe.timeoutMs,
      retries: probe.retries,
    });
    const actualDim = vectors[0]?.length ?? 0;
    const dimOk = actualDim === emb.dimension;
    return {
      items: [
        { name: nameConn, status: 'pass', detail: `${emb.baseURL}/embeddings 可达` },
        { name: nameKey, status: 'pass', detail: `embedding 请求成功（维度 ${actualDim}）` },
        {
          name: nameDim,
          status: dimOk ? 'pass' : 'fail',
          detail: `config=${emb.dimension}, 实际=${actualDim}`,
        },
      ],
      degradable: false,
    };
  } catch (err) {
    const e = err as Error & { code?: string; data?: Record<string, unknown> };
    const code = e.code ?? '';
    const msg = e.message;

    // 维度不匹配：请求到达且鉴权通过，仅维度不符
    if (e.data && e.data.actualDim !== undefined) {
      return {
        items: [
          { name: nameConn, status: 'pass', detail: `${emb.baseURL}/embeddings 可达` },
          { name: nameKey, status: 'pass', detail: 'embedding 请求成功' },
          {
            name: nameDim,
            status: 'fail',
            detail: `config=${e.data.expectedDim ?? emb.dimension}, 实际=${e.data.actualDim}`,
          },
        ],
        degradable: false,
      };
    }

    // 401 / 403：连通但密钥无效
    if (code === 'HTTP_401' || code === 'HTTP_403') {
      return {
        items: [
          { name: nameConn, status: 'pass', detail: `${emb.baseURL}/embeddings 可达` },
          { name: nameKey, status: 'fail', detail: `密钥无效（${code}）` },
          { name: nameDim, status: 'fail', detail: '未获取到向量，无法校验维度' },
        ],
        degradable: false,
      };
    }

    // 其余（HTTP_* / TIMEOUT / NETWORK）：连通性失败
    // 文案必须回显实际预算：/api/health 与 doctor 用的是两套预算，
    // 写死数值会让两处结论看起来互相矛盾。
    const retryDetail = e.data?.nonRetryable === true
      ? '未重试（错误不可重试）'
      : probe.retries > 0 ? `已重试${probe.retries}次` : '未重试';
    const probeSec = probe.timeoutMs / 1000;
    const connDetail = code === 'TIMEOUT'
      ? `连接超时（>${probeSec}s，${retryDetail}）：${emb.baseURL}/embeddings`
      : code === 'NETWORK'
        ? `网络不可达 / DNS 解析失败（${retryDetail}）：${emb.baseURL}`
        : `请求失败（${code || 'ERROR'}，${retryDetail}）：${msg}`;
    return {
      items: [
        { name: nameConn, status: 'fail', detail: connDetail },
        { name: nameKey, status: 'fail', detail: '连通性失败，跳过' },
        { name: nameDim, status: 'fail', detail: '连通性失败，跳过' },
      ],
      degradable: e.data?.nonRetryable !== true,
    };
  }
}

/**
 * 执行完整健康检查，返回结构化报告。
 * 注：调用方需保证 config 已成功 loadConfig（解析失败会在 loadConfig 抛出）。
 */
export async function runHealthCheck(config: KiConfig, options: HealthCheckOptions = {}): Promise<HealthReport> {
  const items: HealthItem[] = [];

  // 1. 配置文件存在且可解析（字段名/类型/取值校验在 loadConfig 阶段 fail-loud，
  //    能走到这里即已通过语法 + 字段双重检查；无配置文件时 _configPath 为空）
  if (config._configPath) {
    items.push({ name: '配置文件', status: 'pass', detail: `${config._configPath} 格式与字段均合法` });
  } else {
    items.push({
      name: '配置文件',
      status: 'fail',
      detail: '未找到配置文件（使用内置默认值），建议执行 ki config init',
    });
  }

  // 1b. 字段告警（不阻断加载但需知道）：废弃字段 / null 的 scope 条目。
  // 同一原因的告警归组展示（如多个 scope 残留同一废弃字段），避免重复文案刷屏。
  const fieldWarns = config._fieldWarnings ?? [];
  if (fieldWarns.length === 0) {
    items.push({ name: '配置字段', status: 'pass', detail: '无废弃字段、无空 scope 条目' });
  } else {
    const byMessage = new Map<string, string[]>();
    for (const w of fieldWarns) {
      const paths = byMessage.get(w.message);
      if (paths) paths.push(w.path);
      else byMessage.set(w.message, [w.path]);
    }
    const MAX_MSG = 3;
    const groups = [...byMessage.entries()].slice(0, MAX_MSG).map(
      ([msg, paths]) => `${paths.join(', ')} → ${msg}`
    );
    items.push({
      name: '配置字段',
      status: 'warn',
      detail: `${fieldWarns.length} 处提示：${groups.join(' ｜ ')}`
        + (byMessage.size > MAX_MSG ? `（另有 ${byMessage.size - MAX_MSG} 类）` : ''),
    });
  }

  // 2~4. 目录存在且可写
  items.push(checkDir('dataDir', config.dataDir));
  items.push(checkDir('backupDir', config.backupDir));
  items.push(checkDir('vectorDir', getVectorDir(config)));

  // 5. apiKey：仅取配置 embedding.apiKey（明文 / ${ENV_VAR}），不做隐式 env 回退。
  // MCP 启动时缺少 key 只告警；doctor/API 默认仍按硬失败诊断。
  const embeddingFailureStatus = options.embeddingFailure ?? 'fail';
  const embForKey = getEmbeddingConfig(config);
  if (embForKey.apiKey) {
    items.push({ name: 'apiKey', status: 'pass', detail: '已从配置 embedding.apiKey 解析' });
  } else {
    items.push({
      name: 'apiKey',
      status: embeddingFailureStatus === 'warn' ? 'warn' : 'fail',
      detail: '未配置 embedding.apiKey（明文或 ${VAR_NAME} 引用）',
    });
  }

  // 6~8. embedding 连通性 / 密钥 / 维度（三合一请求）
  {
    const probe = options.embeddingProbe
      ?? { timeoutMs: EMBED_PROBE_TIMEOUT_MS, retries: EMBED_PROBE_RETRIES };
    const embeddingResult = await checkEmbedding(config, probe);
    const normalizedEmbeddingItems = embeddingFailureStatus === 'warn' && embeddingResult.degradable
      ? embeddingResult.items.map((item) => item.status === 'fail' ? { ...item, status: 'warn' as const } : item)
      : embeddingResult.items;
    items.push(...normalizedEmbeddingItems);
  }

  // 9. zvec collection（存在性为目录判定；可选维度诊断会打开 Collection）
  const collectionsRoot = getCollectionsRoot(config);
  let collectionScopes: string[] = [];
  try {
    collectionScopes = fs.existsSync(collectionsRoot)
      ? fs.readdirSync(collectionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [];
  } catch {
    collectionScopes = [];
  }
  if (collectionScopes.length > 0) {
    items.push({ name: 'zvec collection', status: 'pass', detail: 'collection 已创建' });
  } else {
    items.push({
      name: 'zvec collection',
      status: 'warn',
      detail: '按 scope 的 Collection 尚未创建（执行 ki store/import 后自动创建）',
    });
  }
  // provider 输出与配置一致，不能证明旧 Collection schema 也一致。
  for (const scope of options.checkCollectionDimensions === false ? [] : collectionScopes) {
    try {
      const status = await runWithConfigSnapshot(config, () => getVectorDimensionStatus(scope));
      items.push({
        name: `Collection 维度 (${scope})`,
        status: status.compatible ? 'pass' : (options.collectionDimensionFailure ?? 'fail'),
        detail: status.compatible
          ? `配置 ${status.configured} 维，集合 ${status.persisted ?? '未创建'}`
          : `配置 ${status.configured} 维，集合 ${status.persisted} 维；请执行 ki restore ${scope} --rebuild-vector --yes`,
      });
    } catch (error) {
      items.push({ name: `Collection 维度 (${scope})`, status: 'warn', detail: `暂无法读取集合维度：${(error as Error).message}` });
    }
  }

  // 10. scopes.default
  if (config.scopes && Object.prototype.hasOwnProperty.call(config.scopes, 'default')) {
    items.push({ name: 'scopes.default', status: 'pass', detail: '已配置' });
  } else {
    items.push({
      name: 'scopes.default',
      status: 'warn',
      detail: '未配置 default scope（未传 --scope 时仍会使用 default，数据落在 dataDir/default）',
    });
  }

  const pass = items.filter((i) => i.status === 'pass').length;
  const warn = items.filter((i) => i.status === 'warn').length;
  const fail = items.filter((i) => i.status === 'fail').length;

  return { items, pass, warn, fail };
}

/** 状态图标 */
export function statusIcon(status: HealthStatus): string {
  return status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : '❌';
}

/** 渲染报告为多行文本（doctor stdout / mcp stderr 共用） */
export function renderHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push('kisearch 配置诊断');
  lines.push('━━━━━━━━━━━━━━━━');
  const nameWidth = Math.max(...report.items.map((i) => i.name.length), 8);
  for (const item of report.items) {
    const pad = item.name.padEnd(nameWidth, ' ');
    lines.push(`${statusIcon(item.status)} ${pad}  ${item.detail}`);
  }
  lines.push('');
  lines.push(`诊断结果: ${report.pass} 通过, ${report.warn} 警告, ${report.fail} 失败`);
  return lines.join('\n');
}
