/**
 * HTTP 层：`/open/v1` 的唯一出口。
 *
 * 三条纪律：
 * 1. **只打 `/open/v1`**：`/api/*` 是浏览器语义（Cookie / 本机免登录），没有对外契约
 *    稳定性承诺，客户端不得依赖它。
 * 2. **服务端错误码原样透出**：`OPEN_API_*` 是给程序分支用的稳定标识，不要靠文案匹配。
 * 3. **网络错误必须区分**：连不上要 `REMOTE_UNREACHABLE` 并给出「先 ping / 查地址」的出路，
 *    不能和其他失败混成一句"请求失败"。
 */

import { ClientError } from './errors.js';
import type { ResolvedRemote } from './remote.js';

export interface PingInfo {
  /** 契约版本；服务端字段缺失（旧版本）视为 0 */
  contractVersion: number;
  capabilities: {
    asset: boolean;
    doc: boolean;
    maxAssetSize: number | null;
  };
  /** 原始返回体，`--json` 时原样输出 */
  raw: Record<string, unknown>;
}

/** 拼 URL：基地址可能含子路径（反代 `/ki`），path 以 `/` 开头 */
export function joinUrl(base: string, pathname: string, query?: Record<string, string | undefined>): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${trimmedBase}${trimmedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | undefined>;
  /** 二进制响应（下载）；JSON 请求自动序列化 */
  body?: unknown;
  headers?: Record<string, string>;
}

async function request(remote: ResolvedRemote, pathname: string, opts: RequestOptions = {}): Promise<Response> {
  const url = joinUrl(remote.url, pathname, opts.query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${remote.token}`,
    Accept: 'application/json',
    ...opts.headers,
  };
  // 只发 JSON 字符串（multipart 上传走单独实现，避免把表单拼装混进通用请求）
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    });
  } catch (err) {
    throw new ClientError(
      'REMOTE_UNREACHABLE',
      `连不上 ${remote.name}（${remote.url}）：${(err as Error).message}`,
      '先跑 ki-client ping --remote <名字> 验证地址与端口；跨机请确认防火墙',
    );
  }

  if (res.ok) return res;
  return raiseForError(res, remote);
}

/** 把非 2xx 响应翻成 `ClientError`（携带服务端的 `OPEN_API_*` 码与 hint） */
async function raiseForError(res: Response, remote: ResolvedRemote): Promise<never> {
  let code = '';
  let message = '';
  let hint = '';
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown; hint?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.error === 'string') message = body.error;
    if (typeof body.hint === 'string') hint = body.hint;
  } catch {
    // 非 JSON（如 404 被反代拦截返回 HTML）：保持空，用状态码兜底
  }

  if (res.status === 401 && !code) code = 'OPEN_API_TOKEN_REQUIRED';
  const detail = [code, message].filter(Boolean).join('：') || `HTTP ${res.status}`;
  throw new ClientError(
    'SERVER_ERROR',
    `${remote.name} 返回 ${res.status}（${detail}）`,
    hint || defaultHintFor(res.status),
  );
}

/**
 * 上传 multipart。**不能自己设 `Content-Type`** —— 必须让 fetch 生成带 boundary 的头，
 * 手写会导致 boundary 与 body 不一致（服务端报 `OPEN_API_BAD_MULTIPART`）。
 */
export async function postMultipart<T = Record<string, unknown>>(
  remote: ResolvedRemote,
  pathname: string,
  form: FormData,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const url = joinUrl(remote.url, pathname, query);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${remote.token}`, Accept: 'application/json' },
      body: form,
    });
  } catch (err) {
    throw new ClientError(
      'REMOTE_UNREACHABLE',
      `连不上 ${remote.name}（${remote.url}）：${(err as Error).message}`,
      '先跑 ki-client ping --remote <名字> 验证地址与端口',
    );
  }
  if (!res.ok) return raiseForError(res, remote);
  return (await res.json()) as T;
}

function defaultHintFor(status: number): string {
  if (status === 401) return '核对 token：ki mcp token list / 重新签发；本机访问也必须带 token';
  if (status === 403) return '该 token 未被授权访问这个库，或路径越界；核对 scope 授权范围';
  if (status === 404) return '路径或资源不存在；若确认存在，检查服务端是否关闭了对应接口（downloadApi / uploadApi）';
  return '查看服务端日志定位；若为反向代理拦截，先确认代理放行了该路径与请求体大小';
}

/** 取 JSON（服务端契约返回 `{ ok, ... }`） */
export async function getJson<T = Record<string, unknown>>(
  remote: ResolvedRemote,
  pathname: string,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const res = await request(remote, pathname, { query });
  return (await res.json()) as T;
}

/** 取二进制 + 声明的 Content-Type */
export async function getBinary(
  remote: ResolvedRemote,
  pathname: string,
  query?: Record<string, string | undefined>,
): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await request(remote, pathname, { query });
  const ab = await res.arrayBuffer();
  return { bytes: Buffer.from(ab), contentType: res.headers.get('content-type') ?? '' };
}

/** POST JSON */
export async function postJson<T = Record<string, unknown>>(
  remote: ResolvedRemote,
  pathname: string,
  body: unknown,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const res = await request(remote, pathname, { method: 'POST', body, query });
  return (await res.json()) as T;
}

/**
 * 上传二进制（tar.gz）。服务端按 `Content-Type: application/gzip` 走解包分支。
 *
 * 与 multipart 相比：多一层压缩、少一层 boundary 开销，适合「文件多 / 总体积大」的批量；
 * 代价是服务端要解包，且解包后仍有体积与条目数闸门，所以超大目录还是要分批。
 */
export async function postBinary<T = Record<string, unknown>>(
  remote: ResolvedRemote,
  pathname: string,
  body: Buffer,
  contentType: string,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const url = joinUrl(remote.url, pathname, query);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${remote.token}`, Accept: 'application/json', 'Content-Type': contentType },
      // Buffer 本身就是 Uint8Array，**直接传**：`new Uint8Array(body)` 会把整个包再复制一份
      // （512MB 的归档因此多占 512MB 内存）。类型上不写 `BodyInit` 是为了不依赖全局类型名。
      body,
    });
  } catch (err) {
    throw new ClientError(
      'REMOTE_UNREACHABLE',
      `连不上 ${remote.name}（${remote.url}）：${(err as Error).message}`,
      '先跑 ki-client ping --remote <名字> 验证地址与端口',
    );
  }
  if (!res.ok) return raiseForError(res, remote);
  return (await res.json()) as T;
}

/**
 * 读能力位。
 *
 * 版本协商口径（契约的一部分）：**字段缺失视为 `contractVersion: 0` + 能力全 false**，
 * 即"服务端太旧，不支持取件"。绝不能按 undefined 继续尝试，那会把「版本不匹配」
 * 误报成「文档不存在」。
 */
export async function pingRemote(remote: ResolvedRemote, scope?: string): Promise<PingInfo> {
  const raw = await getJson<Record<string, unknown>>(remote, '/open/v1/ping', scope ? { scope } : undefined);
  const contractVersion = typeof raw.contractVersion === 'number' ? raw.contractVersion : 0;
  const caps = (raw.capabilities ?? {}) as { download?: { asset?: unknown; doc?: unknown }; maxAssetSize?: unknown };
  const download = caps.download ?? {};
  return {
    contractVersion,
    capabilities: {
      asset: download.asset === true,
      doc: download.doc === true,
      maxAssetSize: typeof caps.maxAssetSize === 'number' ? caps.maxAssetSize : null,
    },
    raw,
  };
}

/** 取件前先确认服务端确实开了这个能力（避免先下载再撞 404） */
export function assertCapability(info: PingInfo, need: 'asset' | 'doc', remoteName: string): void {
  if (info.contractVersion === 0) {
    throw new ClientError(
      'CONTRACT_TOO_OLD',
      `源 "${remoteName}" 的服务端不支持取件接口（契约版本 0）`,
      '升级 ki 服务端到包含 /open/v1/asset 与 /open/v1/doc 的版本',
    );
  }
  if (!info.capabilities[need]) {
    throw new ClientError(
      'CONTRACT_TOO_OLD',
      `源 "${remoteName}" 关闭了${need === 'asset' ? '附件' : '文档'}下载接口`,
      `让运维在服务端配置 mcp.http.downloadApi: true 后重启（当前 ping 显示 download.${need}=false）`,
    );
  }
}
