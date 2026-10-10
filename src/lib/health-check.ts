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
import { getVectorDimensionStatus, runWithVectorFastFail } from './vector-client.js';
import { DEFAULT_EMBEDDING_SCHEDULER, parseProviderBatchLimit } from '../zvec-engine/embedding/batch-scheduler.js';

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
 *
 * @param batchProbeTimeoutMs 批大小探测的额外预算；调用方传 0（或不跑该探测）时不计入。
 */
export function healthCheckWorstCaseMs(
  timeoutMs = EMBED_PROBE_TIMEOUT_MS,
  retries = EMBED_PROBE_RETRIES,
  batchProbeTimeoutMs = 0,
): number {
  let total = timeoutMs * (retries + 1) + Math.max(0, batchProbeTimeoutMs);
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
  /**
   * 逐 Collection 维度诊断的数量上限。
   *
   * 该诊断是 **O(scope)** 操作（每个 scope 要开一次 Collection，被占用时还要等探测超时），
   * 放在启动/重启路径上会让 1000 个 scope 的实例"启动即阻塞数分钟"。因此：
   *   - 启动/重启预检：不传（配合 checkCollectionDimensions:false 全跳过）；
   *   - 诊断命令（ki doctor）：传一个小值做抽样，并在报告里显式说明被截断；
   *   - 不传时保持旧语义（全量逐项），仅用于确实需要全量诊断的调用方。
   */
  collectionDimensionScopeLimit?: number;
  /** 启动预检提示维度冲突，但允许全文搜索与迁移命令继续可用。 */
  collectionDimensionFailure?: 'fail' | 'warn';
  /**
   * 是否按配置 batchSize 发一次真实批量请求（默认 true）。
   * 高频轮询型调用方（/api/health）应显式关闭：它既没有诊断语境，也吃不起这次网络往返。
   */
  checkEmbeddingBatchSize?: boolean;
  /**
   * 逐项进度回调（done/total/label）。长耗时阶段（embedding 批量探测、逐 Collection
   * 维度诊断）通过它输出进度，避免 `ki mcp restart` 这类前台命令静默数分钟像卡死。
   */
  onProgress?: (done: number, total: number, label: string) => void;
}

interface EmbeddingCheckResult {
  items: HealthItem[];
  /** 缺少 apiKey 或可重试的网络/HTTP 故障，可在 MCP 启动预检中降级。 */
  degradable: boolean;
}

/** 目录存在且可写检查 */
/** 人类可读容量；用于数据目录剩余空间提示（demo 同款「剩余 42.6 GB」口径）。 */
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** 磁盘剩余/总量；statfs 不可用（老内核、特殊文件系统）时返回 undefined，不让检查失败。 */
function freeSpaceHint(dir: string): string | undefined {
  try {
    const stat = fs.statfsSync(dir);
    return `剩余 ${formatBytes(stat.bavail * stat.bsize)} / ${formatBytes(stat.blocks * stat.bsize)}`;
  } catch {
    return undefined;
  }
}

function checkDir(name: string, dir: string, options: { freeSpace?: boolean } = {}): HealthItem {
  if (!fs.existsSync(dir)) {
    return { name, status: 'fail', detail: `${dir} 不存在` };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { name, status: 'fail', detail: `${dir} 无写权限` };
  }
  const free = options.freeSpace ? freeSpaceHint(dir) : undefined;
  return { name, status: 'pass', detail: `${dir} 存在且可写${free ? `，${free}` : ''}` };
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
 * 批大小探测：按配置的 `embedding.scheduler.batchSize` 发一次真实批量请求。
 *
 * 为什么必须单独探：三合一检查只发 1 条 `"test"`，**永远发现不了服务商的单请求条数上限**。
 * 实测故障（2026-09-29）：batchSize=32 而服务商上限 25，每个满批都 400
 * `invalid_parameter_error: batch size is invalid, it should not be larger than 25`，
 * 而 `ki doctor` 报 ✅ embedding —— 用户只看到导入/重建"部分条目向量化失败"或
 * 跨维度迁移整体回滚，看不到真实原因。
 */
async function checkEmbeddingBatchSize(
  config: KiConfig,
  probe: { timeoutMs: number },
  failureStatus: HealthStatus,
): Promise<HealthItem> {
  const name = '批大小探测';
  const emb = getEmbeddingConfig(config);
  const batchSize = emb.scheduler?.batchSize ?? DEFAULT_EMBEDDING_SCHEDULER.batchSize;
  if (!emb.apiKey) {
    return { name, status: 'warn', detail: `未配置 embedding.apiKey，跳过（配置值 batchSize=${batchSize}）` };
  }
  if (batchSize <= 1) {
    return { name, status: 'pass', detail: `batchSize=${batchSize}（逐条请求，无批次上限风险）` };
  }
  let provider: SiliconFlowProvider;
  try {
    provider = new SiliconFlowProvider({
      baseURL: emb.baseURL,
      model: emb.model,
      dimension: emb.dimension,
      apiKey: emb.apiKey,
    });
  } catch (err) {
    return { name, status: failureStatus, detail: `无法构造 provider，跳过批大小探测：${(err as Error).message}` };
  }
  // 上限探到 100 条即止：足够暴露常见服务商上限（10/20/25/64），又不至于把探测本身变成压测。
  const inputs = Array.from({ length: Math.min(batchSize, 100) }, (_, i) => `batch-size probe ${i + 1}`);
  try {
    // 探测本身不重试：这是配置类问题，重试只会把同一个 400 再打一遍。
    const vectors = await provider.embed(inputs, { batchSize: inputs.length, timeoutMs: probe.timeoutMs, retries: 0 });
    if (vectors.length !== inputs.length) {
      return { name, status: failureStatus, detail: `batchSize=${batchSize} 请求返回数量不匹配（期望 ${inputs.length}，实际 ${vectors.length}）` };
    }
    return { name, status: 'pass', detail: `batchSize=${batchSize} 的单请求被服务商接受（返回 ${vectors.length} 条向量）` };
  } catch (err) {
    const message = (err as Error).message;
    const declared = parseProviderBatchLimit(err as Error);
    if (declared !== undefined) {
      return {
        name,
        status: failureStatus,
        detail: `batchSize=${batchSize} 超过服务商单请求上限 ${declared}（${message}）；`
          + `修复：把 embedding.scheduler.batchSize 下调到 ≤ ${declared}（或删除该字段使用默认 ${DEFAULT_EMBEDDING_SCHEDULER.batchSize}），`
          + '然后重跑导入/重建。注：运行时已能自动降批自愈，但显式配置正确可避免每轮多一次失败请求',
      };
    }
    return { name, status: failureStatus, detail: `按配置 batchSize=${batchSize} 的批量请求失败：${message}` };
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
  items.push(checkDir('dataDir', config.dataDir, { freeSpace: true }));
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

  // 8b. 批大小探测：单条 "test" 探不到服务商单请求条数上限（batchSize=32 vs 上限 25 的实测故障）
  if (options.checkEmbeddingBatchSize !== false) {
    const probe = options.embeddingProbe
      ?? { timeoutMs: EMBED_PROBE_TIMEOUT_MS, retries: EMBED_PROBE_RETRIES };
    options.onProgress?.(1, 1, '批大小探测');
    items.push(await checkEmbeddingBatchSize(config, { timeoutMs: probe.timeoutMs }, embeddingFailureStatus));
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
  const allDimensionScopes = options.checkCollectionDimensions === false ? [] : collectionScopes;
  const dimensionLimit = options.collectionDimensionScopeLimit ?? allDimensionScopes.length;
  const dimensionScopes = allDimensionScopes.slice(0, Math.max(0, dimensionLimit));
  const daemonOwner = process.env.KI_DAEMON_OWNER === '1';
  for (let i = 0; i < dimensionScopes.length; i++) {
    const scope = dimensionScopes[i];
    options.onProgress?.(i + 1, dimensionScopes.length, `Collection 维度 (${scope})`);
    try {
      // 诊断路径关闭撞锁重试（runWithVectorFastFail）：被占用的 Collection 一次探测即判占用，
      // 旧行为每 scope 白等 ≈15s（3s 探测 + 2s 间隔 ×3），8 个 scope ≈2 分钟静默输出。
      const status = await runWithVectorFastFail(
        () => runWithConfigSnapshot(config, () => getVectorDimensionStatus(scope)),
      );
      items.push({
        name: `Collection 维度 (${scope})`,
        status: status.compatible ? 'pass' : (options.collectionDimensionFailure ?? 'fail'),
        detail: status.compatible
          ? `配置 ${status.configured} 维，集合 ${status.persisted ?? '未创建'}`
            // REQ-20261009-003 S-02：暴露索引完成度（0 = 未建索引、检索走暴力扫描）
            + (status.indexCompleteness && Object.values(status.indexCompleteness).some((v) => Number.isFinite(v))
              ? `；索引完成度 ${Object.entries(status.indexCompleteness)
                .filter(([, v]) => Number.isFinite(v))
                .map(([f, v]) => `${f}=${v.toFixed(2)}`).join(', ')}`
                + (Object.values(status.indexCompleteness).some((v) => Number.isFinite(v) && v < 1) ? '（未完全建索引）' : '')
              : '')
          : `配置 ${status.configured} 维，集合 ${status.persisted} 维；请执行 ki restore ${scope} --rebuild-vector --yes`,
      });
    } catch (error) {
      const err = error as Error & { name?: string };
      const locked = err.name === 'CollectionLockedException' || /被其他进程占用/.test(err.message);
      // 撞锁文案里可能已反查到真实持锁进程（见 lib/lock-holder.ts）——附在后面，
      // 省掉"用户自己 ps/lsof 找谁占着"这一跳；查不到时保持原样。
      const holderLine = locked
        ? err.message.split('\n').find((line) => line.includes('持锁进程：'))?.trim().replace(/^●\s*/, '')
        : undefined;
      items.push({
        name: `Collection 维度 (${scope})`,
        status: 'warn',
        detail: locked
          ? daemonOwner
            ? '向量库被占用（本进程是 daemon owner，说明存在残留 LOCK），本次跳过维度诊断；建议 ki mcp restart 后重试'
              + (holderLine ? `；${holderLine}` : '')
            : '向量库被运行中的 kisearch 实例占用，本次跳过维度诊断（停止该实例后重跑本命令即可；不影响全文检索）'
              + (holderLine ? `；${holderLine}` : '')
          : `暂无法读取集合维度：${err.message}`,
      });
    }
  }
  // 抽样截断必须显式说明：否则"报告全绿"会被误读为"所有 scope 都体检过"
  if (allDimensionScopes.length > dimensionScopes.length) {
    items.push({
      name: 'Collection 维度 (抽样)',
      status: 'warn',
      detail: `共 ${allDimensionScopes.length} 个 scope，本次只诊断前 ${dimensionScopes.length} 个`
        + '（逐 scope 诊断是 O(scope) 操作，启动/重启路径不做全量）；'
        + '其余 scope 在写入/检索时会按需拦截并给出 ki restore <scope> --rebuild-vector 指引',
    });
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
