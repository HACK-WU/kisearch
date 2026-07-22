/**
 * health-check.ts —— ki 配置健康诊断（REQ-16）
 *
 * 供 `ki doctor` 命令与 `ki mcp` 启动预检共用同一套只读检查逻辑。
 *
 * 设计要点：
 *   - 纯只读：不修改任何配置或数据
 *   - embedding 检查用 1 条最短文本（"test"）发一次真实请求，三合一验证
 *     URL 连通性 + 密钥有效性 + 维度匹配（复用 SiliconFlowProvider 现成错误语义）
 *   - 超时 5s（timeoutMs），不重试（retries:0），避免网络不通时长时间卡住
 *   - zvec collection 用目录非空判定（不 open，避开与常驻 server 的文件锁冲突）
 */

import fs from 'fs';
import { SiliconFlowProvider } from '../../dist/zvec-engine/index.js';
import type { KiConfig } from './config.js';
import { getVectorDir, getEmbeddingConfig } from './config.js';

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
async function checkEmbedding(config: KiConfig): Promise<HealthItem[]> {
  const emb = getEmbeddingConfig(config);
  const nameConn = 'URL 连通性';
  const nameKey = '密钥有效性';
  const nameDim = '维度匹配';

  // apiKey 缺失时无法发起请求，三项均标失败（根因见 apiKey 检查项）
  if (!process.env.SILICONFLOW_API_KEY) {
    const detail = 'SILICONFLOW_API_KEY 未设置，跳过检查';
    return [
      { name: nameConn, status: 'fail', detail },
      { name: nameKey, status: 'fail', detail },
      { name: nameDim, status: 'fail', detail },
    ];
  }

  let provider: SiliconFlowProvider;
  try {
    provider = new SiliconFlowProvider({
      baseURL: emb.baseURL,
      model: emb.model,
      dimension: emb.dimension,
    });
  } catch (err) {
    // 构造期错误（EmbeddingConfigError）：apiKey / baseURL 非法
    const detail = (err as Error).message;
    return [
      { name: nameConn, status: 'fail', detail },
      { name: nameKey, status: 'fail', detail },
      { name: nameDim, status: 'fail', detail },
    ];
  }

  try {
    const vectors = await provider.embed(['test'], { timeoutMs: 5000, retries: 0 });
    const actualDim = vectors[0]?.length ?? 0;
    const dimOk = actualDim === emb.dimension;
    return [
      { name: nameConn, status: 'pass', detail: `${emb.baseURL}/embeddings 可达` },
      { name: nameKey, status: 'pass', detail: `embedding 请求成功（维度 ${actualDim}）` },
      {
        name: nameDim,
        status: dimOk ? 'pass' : 'fail',
        detail: `config=${emb.dimension}, 实际=${actualDim}`,
      },
    ];
  } catch (err) {
    const e = err as Error & { code?: string; data?: Record<string, unknown> };
    const code = e.code ?? '';
    const msg = e.message;

    // 维度不匹配：请求到达且鉴权通过，仅维度不符
    if (e.data && e.data.actualDim !== undefined) {
      return [
        { name: nameConn, status: 'pass', detail: `${emb.baseURL}/embeddings 可达` },
        { name: nameKey, status: 'pass', detail: 'embedding 请求成功' },
        {
          name: nameDim,
          status: 'fail',
          detail: `config=${e.data.expectedDim ?? emb.dimension}, 实际=${e.data.actualDim}`,
        },
      ];
    }

    // 401 / 403：连通但密钥无效
    if (code === 'HTTP_401' || code === 'HTTP_403') {
      return [
        { name: nameConn, status: 'pass', detail: `${emb.baseURL}/embeddings 可达` },
        { name: nameKey, status: 'fail', detail: `密钥无效（${code}）` },
        { name: nameDim, status: 'fail', detail: '未获取到向量，无法校验维度' },
      ];
    }

    // 其余（HTTP_* / TIMEOUT / NETWORK）：连通性失败
    const connDetail = code === 'TIMEOUT'
      ? `连接超时（>5s）：${emb.baseURL}/embeddings`
      : code === 'NETWORK'
        ? `网络不可达 / DNS 解析失败：${emb.baseURL}`
        : `请求失败（${code || 'ERROR'}）：${msg}`;
    return [
      { name: nameConn, status: 'fail', detail: connDetail },
      { name: nameKey, status: 'fail', detail: '连通性失败，跳过' },
      { name: nameDim, status: 'fail', detail: '连通性失败，跳过' },
    ];
  }
}

/**
 * 执行完整健康检查，返回结构化报告。
 * 注：调用方需保证 config 已成功 loadConfig（解析失败会在 loadConfig 抛出）。
 */
export async function runHealthCheck(config: KiConfig): Promise<HealthReport> {
  const items: HealthItem[] = [];

  // 1. 配置文件存在且可解析
  if (config._configPath) {
    items.push({ name: '配置文件', status: 'pass', detail: `${config._configPath} 格式正确` });
  } else {
    items.push({
      name: '配置文件',
      status: 'fail',
      detail: '未找到配置文件（使用内置默认值），建议执行 ki config init',
    });
  }

  // 2~4. 目录存在且可写
  items.push(checkDir('dataDir', config.dataDir));
  items.push(checkDir('backupDir', config.backupDir));
  items.push(checkDir('vectorDir', getVectorDir(config)));

  // 5. apiKey 环境变量
  if (process.env.SILICONFLOW_API_KEY) {
    items.push({ name: 'apiKey', status: 'pass', detail: 'SILICONFLOW_API_KEY 已设置' });
  } else {
    items.push({ name: 'apiKey', status: 'fail', detail: 'SILICONFLOW_API_KEY 未设置' });
  }

  // 6~8. embedding 连通性 / 密钥 / 维度（三合一请求）
  const embItems = await checkEmbedding(config);
  items.push(...embItems);

  // 9. zvec collection（目录非空判定，不 open）
  const vectorDir = getVectorDir(config);
  let collectionCreated = false;
  try {
    collectionCreated = fs.existsSync(vectorDir) && fs.readdirSync(vectorDir).length > 0;
  } catch {
    collectionCreated = false;
  }
  if (collectionCreated) {
    items.push({ name: 'zvec collection', status: 'pass', detail: 'collection 已创建' });
  } else {
    items.push({
      name: 'zvec collection',
      status: 'warn',
      detail: '首次使用，未创建（执行 ki store 后自动创建）',
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
  lines.push('KiSearch 配置诊断');
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
