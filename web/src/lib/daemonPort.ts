/**
 * daemonPort.ts —— 「MCP 端口」显示口径（侧栏页脚等处的唯一来源）
 *
 * 为什么不能写死 7423，也不能只看地址栏：
 *   · 生产（`ki mcp --http --web` 直接服务页面）：页面端口 = daemon 端口，用地址栏就对；
 *   · 开发 / 预览（vite :5173 或 preview :4173 经 proxy → daemon :7433）：
 *     **页面端口 ≠ daemon 端口**，显示 5173/4173 会让人去连一个不存在的 MCP 服务；
 *   · 反向代理（`https://host/`，地址栏无端口）：外部可达端口只能从地址栏拿。
 *
 * 因此口径是「按访问来源选证据 + 逐级回落」，永不硬编码：
 *   回环（本机访问）→ `/healthz.port`（proxy 目标真实端口）→ 地址栏 → 协议默认
 *   非回环（其他设备 / 代理）→ 地址栏端口 → `/healthz.port` → 协议默认
 *
 * 纯逻辑，可零依赖单测（`web/test/daemon-port.test.mjs`）；取数在 `lib/hooks.ts`。
 */

/** 判定端口的输入证据 */
export interface PortProbe {
  /** `/healthz` 返回的 daemon 监听端口（未取到 / 旧版本缺省时为 undefined） */
  healthzPort?: number | string | null;
  /** `window.location.port`（地址栏省略端口时为空串） */
  locationPort?: string | null;
  /** `window.location.protocol`（决定缺省端口 80/443） */
  protocol?: string | null;
  /**
   * 页面是否经回环地址访问（`isLoopbackHost(window.location.hostname)`）。
   *
   * ★ 用**运行期事实**而不是 `import.meta.env.DEV`：dev（vite :5173）与 preview
   *   （生产构建、vite :4173 预览 dist）**都是回环、都不是 daemon 自己服务页面**，
   *   而 DEV 在两个场景取值不同 —— 拿它当判据会让 preview 显示 4173（又一个错值）。
   */
  isLoopback?: boolean;
}

/** 去掉空值与非法的端口，统一成字符串；非法一律 null（回落给下一级证据） */
export function normalizePort(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return String(port);
}

/** 协议默认端口：https → 443，其余（http / ws / 未知）→ 80 */
export function defaultPortFor(protocol: string | null | undefined): string {
  return String(protocol ?? '').toLowerCase().startsWith('https') ? '443' : '80';
}

/**
 * 解析「MCP 端口」用于展示。
 *
 * 返回**非空字符串**：所有证据都缺失时给协议默认端口，而不是显示 `undefined`
 * （侧栏页脚 `MCP —` 反而让人以为服务挂了）。
 */
export function resolveMcpPort(probe: PortProbe): string {
  const healthz = normalizePort(probe.healthzPort);
  const location = normalizePort(probe.locationPort);
  const fallback = defaultPortFor(probe.protocol);
  // 回环（本机）：页面端口常是代理入口（dev :5173 / preview :4173），daemon 端口才是真相
  if (probe.isLoopback) return healthz ?? location ?? fallback;
  // 其他设备 / 反向代理：地址栏端口是外部实际可达入口，优先于 daemon 内部端口
  return location ?? healthz ?? fallback;
}
