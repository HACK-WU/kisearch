/**
 * doc-link.ts —— 把「某篇文档」换算成 Web 端的可点开地址（REQ-20261123-003 · S-01）。
 *
 * 产出形如 `http://127.0.0.1:7433/browse?scope=..&group=..&relation=..`，读取侧契约见
 * `web/src/pages/BrowsePage.tsx`（scope 必需；group + relation 必须成对；relation 是**名称**）。
 *
 * ═══ 四条硬约定（改本文件前先读）═══
 * 1. 编码**只准**走 `URLSearchParams`：中文 / `#` / `&` / 空格 / `+` 都由它处理，
 *    手工拼串会让 `#` 截断、`?` 注入。
 * 2. URL **不含任何凭证**：只有 scope / group / relation，不带 Token、会话或用户标识。
 * 3. 生成失败一律**吞掉**返回 undefined：调用它的写操作已经成功落盘，
 *    不能因为「算不出链接」把成功结果变成失败。
 * 4. 取不到可靠地址时**不输出字段**（调用方用 `withUrl` 合并），绝不产出空串或占位地址。
 *
 * ═══ 取址顺序与理由 ═══
 * - 配了 `mcp.http.publicUrl` → 整段以它为准（显式覆盖）。理由：`Host` 头几乎总存在，
 *   若把它当「兜底」，反代场景（Host 存在但地址错）永远走不到配置分支。
 * - 否则用请求头：`Host` 为主；**仅当 Host 是回环**（说明请求经过同机反代）才采信
 *   `X-Forwarded-Host` —— 无条件信任转发头等于让客户端自带一个头就能伪造任意域名。
 * - 子路径走 `basePath`：`base` 恒无路径，避免 `new URL(base).pathname = '/browse'`
 *   把 `/ki` 整段覆盖掉（真实踩坑，见错误库同名条目）。
 */

import { getWebRuntime, type WebRuntime } from '../mcp-runtime.js';

export interface DocTarget {
  scope: string;
  group: string;
  relation: string;
}

/** SDK 下发的请求上下文（`extra.requestInfo`）；stdio 会话为 undefined */
export interface DocLinkContext {
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
}

/** 取址结果：`base` 恒无路径，`basePath` 为空串或 `/xxx`（去尾 `/`） */
export interface ResolvedBase {
  base: string;
  basePath: string;
}

/**
 * 生成可点开的绝对地址。无法确定时返回 `undefined` —— 调用方**不得**输出空串或占位地址。
 *
 * @param runtime 可选：覆盖进程级快照（仅测试用，避免并行测试互相污染）
 */
export function docUrl(
  target: DocTarget,
  ctx: DocLinkContext,
  runtime?: WebRuntime,
): string | undefined {
  try {
    const { scope, group, relation } = target;
    // 三者任一为空都拼不出可打开的地址（group 为空说明没归一，根目录应是 __root__）
    if (!scope || !group || !relation) return undefined;
    const resolved = resolveBase(ctx, runtime);
    if (!resolved) return undefined;
    const url = new URL(resolved.base);
    url.pathname = `${resolved.basePath}/browse`;
    url.search = new URLSearchParams({ scope, group, relation }).toString();
    return url.toString();
  } catch {
    // 任何异常（非法 Host 字符、URL 构造失败）都按「没有链接」处理
    return undefined;
  }
}

/** 便捷合并：`url` 为 undefined 时结果里不出现该字段 */
export function withUrl<T extends object>(result: T, url: string | undefined): T & { url?: string } {
  return url ? { ...result, url } : result;
}

/**
 * 解析取址根。**仅供单测**直接验证判据（生产代码经 `docUrl` 使用）。
 *
 * @param runtime 可选：覆盖进程级快照（仅测试用）
 */
export function resolveBase(
  ctx: DocLinkContext,
  runtime?: WebRuntime,
): ResolvedBase | null {
  const rt = runtime ?? getWebRuntime();
  // ① 没有前端页面就不可能有可打开的**页面**链接，连头都不用看。
  if (!rt.webEnabled) return null;

  // ② 显式覆盖：整段以配置为准（含子路径），不再看请求头
  if (rt.publicUrl) {
    try {
      const url = new URL(rt.publicUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return { base: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
    } catch {
      return null;
    }
  }

  // ③ 走请求头
  const headers = ctx.requestInfo?.headers;
  if (!headers) return null;

  const hostHeader = header(headers, 'host');
  const forwardedHost = header(headers, 'x-forwarded-host');
  let rawHost = '';
  if (hostHeader) {
    const { hostname } = splitHostPort(hostHeader);
    // Host 是回环 ⇒ 请求经过同机反代（Host 已被改写成后端地址），此时转发头更可信；
    // 否则以 Host 为准，避免客户端自带 X-Forwarded-Host 伪造域名。
    rawHost = isLoopbackHostname(hostname) && forwardedHost ? forwardedHost : hostHeader;
  } else if (forwardedHost) {
    rawHost = forwardedHost;
  }
  if (!rawHost) return null;

  const { hostname, port } = splitHostPort(rawHost);
  if (!hostname) return null;
  const safeHost = isWildcardHostname(hostname) ? '127.0.0.1' : hostname;
  const authority = port ? `${formatHostname(safeHost)}:${port}` : formatHostname(safeHost);
  const proto = normalizeProto(header(headers, 'x-forwarded-proto'));
  return { base: `${proto}://${authority}`, basePath: normalizePrefix(header(headers, 'x-forwarded-prefix')) };
}

// ─── 内部工具 ──────────────────────────────────────────

/** 取首个非空头值（头名大小写不敏感；同名多值取第一个非空） */
function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === 'string' ? value.trim() : '';
}

/** 拆主机与端口；`[::1]:7433` / `127.0.0.1:7433` / `ki.example.com` 都能处理 */
function splitHostPort(value: string): { hostname: string; port: string } {
  const raw = value.trim();
  if (!raw) return { hostname: '', port: '' };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return { hostname: raw, port: '' };
    const rest = raw.slice(end + 1);
    return { hostname: raw.slice(1, end), port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const idx = raw.lastIndexOf(':');
  if (idx === -1) return { hostname: raw, port: '' };
  const maybePort = raw.slice(idx + 1);
  // 冒号后不是纯数字 ⇒ 当整串是主机名（不带括号的 IPv6，交给 URL 构造去报错）
  if (!/^\d+$/.test(maybePort)) return { hostname: raw, port: '' };
  return { hostname: raw.slice(0, idx), port: maybePort };
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

function isWildcardHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === '0.0.0.0' || h === '::' || h === '*' || h === '';
}

/** IPv6 需要方括号才能拼进 URL */
function formatHostname(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

/** 只接受 http/https，其余按 http 处理（daemon 本身是明文） */
function normalizeProto(raw: string): string {
  const value = raw.trim().toLowerCase();
  return value === 'https' ? 'https' : 'http';
}

/** 前缀必须是 `/xxx` 形式；不以 `/` 开头、或只剩 `/` 一律视为无前缀 */
function normalizePrefix(raw: string): string {
  let value = raw.trim();
  if (!value.startsWith('/')) return '';
  value = value.replace(/\/+$/, '');
  return value === '' ? '' : value;
}
