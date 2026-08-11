/**
 * 网络地址判定工具。
 * 用于 MCP HTTP 鉴权：本地（回环）来源免鉴权，远程来源需 Bearer Token。
 */

/** 判断是否为绑定地址回环（用于决定服务是否配置 token / 是否需要远程鉴权） */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]';
}

/**
 * 判断请求来源（remoteAddress）是否为本地回环地址。
 * Node 的 req.socket.remoteAddress 可能为：
 *  - '127.0.0.1'（IPv4 回环）
 *  - '::1'（IPv6 回环）
 *  - '::ffff:127.0.0.1'（IPv4 映射到 IPv6）
 *  - '::ffff:192.168.1.10'（IPv4 映射到 IPv6 的非回环）
 */
export function isLoopbackAddr(addr?: string): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  // IPv4 直连回环
  if (a === '127.0.0.1' || a === 'localhost') return true;
  // IPv6 直连回环
  if (a === '::1' || a === '[::1]') return true;
  // IPv4 映射到 IPv6：提取最后 4 段，若为 127.x 则回环。
  // 注意：127.0.0.0/8 整段均为回环保留地址（RFC 1122），故 mapped.startsWith('127.') 将整段判为本地是安全的。
  if (a.startsWith('::ffff:')) {
    const mapped = a.slice('::ffff:'.length);
    return mapped === '127.0.0.1' || mapped.startsWith('127.');
  }
  return false;
}
