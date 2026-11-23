/**
 * mcp-runtime.ts —— MCP 进程级只读运行时快照。
 *
 * 为什么独立成模块：工具层（`src/lib/mcp-tools/*`）需要知道两个事实——
 *   ① 本进程是否真的在提供 Web 前端页面；
 *   ② 用户是否配了对外地址（`mcp.http.publicUrl`）。
 * 这两个事实只存在于 HTTP 启动流程里（`mcp-http.ts::startHttpMcpServer` 的局部变量与 opts）。
 * 若把状态直接放进 `mcp-http.ts`，工具层就要反向 import 传输层；而正向链已经是
 * `mcp-server.ts → mcp-server-factory → mcp-tools`，反向引用直接成环。故独立成一个零依赖
 * 模块，两个方向都能安全 import。
 *
 * 语义：**启动时写一次，之后只读**。`--web` / `publicUrl` 的变更与其它启动参数一样需要重启
 * （`ki mcp restart`）才生效，本模块不提供热更新。
 *
 * ⚠️ 并发提示：这是**进程级单例**，一个进程只有一份值。Node test runner 默认按文件并行，
 * 多个测试文件同时置位不同值会互相污染（表现为「偶发没有链接」）。单测优先用
 * `docUrl(target, ctx, runtime)` / `resolveBase(ctx, runtime)` 的 runtime 参数注入；
 * 只能用全局时，必须 before 置位、after 调 `resetWebRuntime()`。
 */

export interface WebRuntime {
  /**
   * `--web` 已指定 **且** `web/dist/index.html` 启动时存在。
   *
   * 注意不能等于「webDir 非空」：`mcp-http.ts` 在产物缺失时**仍会给 webDir 赋值**
   * （只为打印告警），据它判断会生成必然 404 的链接。
   */
  webEnabled: boolean;
  /** `mcp.http.publicUrl` 归一后（去尾斜杠）；未配置 / 非法为 null */
  publicUrl: string | null;
}

/** 无 Web 能力时的默认值（stdio 进程、未开 --web、产物缺失） */
const OFF: WebRuntime = { webEnabled: false, publicUrl: null };

let current: WebRuntime = OFF;

/** 启动时写一次；之后只读 */
export function setWebRuntime(next: WebRuntime): void {
  current = { webEnabled: next.webEnabled === true, publicUrl: next.publicUrl ?? null };
}

export function getWebRuntime(): WebRuntime {
  return current;
}

/** 仅测试用：恢复「无 Web」初始态 */
export function resetWebRuntime(): void {
  current = OFF;
}

/**
 * 归一 `mcp.http.publicUrl`：只接受 http/https，去掉尾部斜杠，丢弃 query / hash。
 *
 * 返回 null 表示「不可用」（未配置或非法）——调用方负责在配置非法时打一行告警，
 * 本函数不打印，因为它也被单测直接调用。
 */
export function normalizePublicUrl(raw?: string | null): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // 子路径必须保留（反代常部署在 /ki 下），只吃掉尾部斜杠
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}
