/**
 * `ki-client ping` —— 连通性、鉴权、契约版本与能力位自检。
 *
 * 取件前先 ping 是刻意设计的一步：它能在**动手之前**回答三件事
 * 「地址通不通 / token 有没有效 / 服务端有没有开读出口」，
 * 而不是让用户在下载到一半时撞 401 或 404。
 */

import { ClientError } from '../errors.js';
import { pingRemote, type PingInfo } from '../http.js';
import type { ParsedArgs } from '../args.js';
import type { ResolvedRemote } from '../remote.js';

export async function runPing(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  const scope = args.string('scope');
  const info: PingInfo = await pingRemote(remote, scope);

  if (args.bool('json')) {
    console.log(JSON.stringify({
      ok: true,
      remote: { name: remote.name, url: remote.url, source: remote.source },
      ping: info.raw,
    }, null, 2));
    return 0;
  }

  const raw = info.raw;
  console.log(`源：      ${remote.name}${remote.source === 'env' ? '（来自 KI_URL）' : ''}`);
  console.log(`地址：    ${remote.url}`);
  if (Array.isArray(raw.scopes)) console.log(`授权库：  ${(raw.scopes as string[]).join(', ') || '(无)'}`);
  console.log(`只读：    ${raw.readOnly === true ? '是' : '否'}`);
  console.log(`契约版本：${info.contractVersion}${info.contractVersion === 0 ? '（服务端过旧，不支持取件）' : ''}`);

  const caps = info.capabilities;
  console.log(`取件能力：附件 ${caps.asset ? '开' : '关'} / 文档 ${caps.doc ? '开' : '关'}`);
  if (caps.maxAssetSize !== null) console.log(`单附件上限：${caps.maxAssetSize} 字节`);

  const limits = raw.limits as { maxFileSize?: number; maxRequestBody?: number } | undefined;
  if (limits) {
    if (typeof limits.maxFileSize === 'number') console.log(`单文件上限：${limits.maxFileSize} 字节`);
    if (typeof limits.maxRequestBody === 'number') console.log(`请求体上限：${limits.maxRequestBody} 字节`);
  }
  if (raw.uploadApi === false) console.log('上传接口：已关闭');

  if (info.contractVersion === 0 && (caps.asset || caps.doc)) {
    // 理论不可达（缺失视为 0），保留以防服务端只加了能力位却漏了版本号
    throw new ClientError('CONTRACT_TOO_OLD', '服务端返回了能力位却没有契约版本，无法安全取件', '升级服务端');
  }
  return 0;
}
