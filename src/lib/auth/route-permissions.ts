/**
 * route-permissions.ts —— `/api/*` 能力注册表（REQ-20261103-001 · S-03）
 *
 * 白名单 + 默认拒绝：
 * - 只有本表命中的路径才会进入 handler；
 * - 命中但 principal 缺少 capability → 403；
 * - 未命中 → 404（与既有“路径不存在”语义一致）。
 *
 * 新增 `/api` 路由必须同时在本表登记；覆盖率测试会枚举 handler 路由字面量并断言覆盖。
 */

import type { Capability } from './capabilities.js';

export type RouteKind = 'public' | 'authenticated' | 'permission';

export interface RouteMatch {
  kind: RouteKind | 'unknown';
  capability?: Capability;
  /**
   * 会触发**上游模型调用**的路由（#96 · 与 `/mcp` 的 `TOKEN_MODEL_FORBIDDEN` 同口径）。
   *
   * 与「写能力」是两条正交的维度：发起 AI 追问不写数据，但会消耗模型额度并外发知识库片段，
   * 只读 Token 一律拒绝。标记挂在路由上而不是能力上 —— `knowledge.ask` 同时覆盖
   * 「发起 / 停止 / 读记录」，只有**发起**两个（含 SSE）消耗模型，按能力判会连停止与读记录一起拦掉。
   */
  modelConsuming?: true;
}

interface Rule {
  method: string;
  test: (path: string) => boolean;
  kind: RouteKind;
  capability?: Capability;
  modelConsuming?: true;
}

function exact(method: string, path: string, kind: RouteKind, capability?: Capability): Rule {
  return { method, test: (p) => p === path, kind, ...(capability ? { capability } : {}) };
}

function pattern(method: string, regex: RegExp, kind: RouteKind, capability?: Capability): Rule {
  return { method, test: (p) => regex.test(p), kind, ...(capability ? { capability } : {}) };
}

/** 模型消耗型路由：`permission` + 指定能力 + `modelConsuming` 标记 */
function modelRoute(method: string, regex: RegExp, capability: Capability): Rule {
  return {
    method,
    test: (p) => regex.test(p),
    kind: 'permission',
    capability,
    modelConsuming: true,
  };
}

const RULES: Rule[] = [
  // ── 认证（gate 之前已处理；登记用于覆盖率与 public 语义）──
  exact('POST', '/auth/login', 'public'),
  exact('GET', '/auth/me', 'public'),
  exact('POST', '/auth/logout', 'public'),
  exact('POST', '/auth/password', 'authenticated'),

  // ── 任务（动态路径先于通配）──
  exact('GET', '/tasks', 'permission', 'tasks.read'),
  pattern('GET', /^\/tasks\/[^/]+\/log$/, 'permission', 'tasks.read'),
  pattern('GET', /^\/tasks\/[^/]+$/, 'permission', 'tasks.read'),
  pattern('DELETE', /^\/tasks\/[^/]+$/, 'permission', 'tasks.delete'),

  // ── 自己的 MCP Token（所有登录角色可用；Token principal 不在能力表内）──
  { method: '*', test: (p) => p === '/me/tokens' || p.startsWith('/me/tokens/'), kind: 'permission', capability: 'tokens.self' },

  // ── 用户管理（S-04 实现；当前 admin 命中后由分发器 404）──
  { method: '*', test: (p) => p === '/users' || p.startsWith('/users/'), kind: 'permission', capability: 'users.manage' },

  // ── 对话：全局提示词配置 admin-only；清空全部会话 admin-only；其余 chat 路由 chat.use ──
  exact('PUT', '/chat/prompt-config', 'permission', 'ops.write'),
  exact('DELETE', '/chat/conversations', 'permission', 'ops.write'),
  { method: '*', test: (p) => p === '/chat' || p.startsWith('/chat/'), kind: 'permission', capability: 'chat.use' },

  // ── 知识读 ──
  exact('GET', '/health', 'permission', 'knowledge.read'),
  exact('GET', '/search-config', 'permission', 'knowledge.read'),
  exact('GET', '/tags', 'permission', 'knowledge.read'),
  exact('GET', '/doc/list', 'permission', 'knowledge.read'),
  exact('GET', '/doc/get', 'permission', 'knowledge.read'),
  exact('GET', '/doc/edit', 'permission', 'knowledge.read'),
  exact('GET', '/asset', 'permission', 'knowledge.read'),
  exact('GET', '/import/config', 'permission', 'knowledge.read'),
  exact('GET', '/import/upload-status', 'permission', 'knowledge.read'),
  exact('GET', '/import/status', 'permission', 'knowledge.read'),
  exact('GET', '/import/incomplete', 'permission', 'knowledge.read'),
  exact('GET', '/vector/status', 'permission', 'knowledge.read'),
  // 图集（REQ-20261120-003）：一期只读两端点；写入口是 CLI（不经 HTTP）。
  // 未登记即 404 —— 漏这两行的表现是「页面一直空态 + 路由覆盖率单测转红」。
  exact('GET', '/atlas/status', 'permission', 'knowledge.read'),
  exact('GET', '/atlas/view', 'permission', 'knowledge.read'),
  exact('GET', '/embedding/summary', 'permission', 'knowledge.read'),
  exact('POST', '/vector/status/refresh', 'permission', 'knowledge.read'),

  // ── 知识写 ──
  exact('POST', '/doc/edit', 'permission', 'knowledge.write'),
  // 文档移动（REQ-20261112-002）：与写入同级。未登记的路由默认 404，漏登记既是"功能不可用"
  // 也会让路由覆盖率单测转红。
  exact('POST', '/doc/move', 'permission', 'knowledge.write'),
  // 文档删除（2026-11-13）：写操作，与写入/移动同级。预检也走同一路由（body.dryRun），
  // 因为它读的是「这篇文档的当前状态」，与 `knowledge.read` 的语义不同（且调用方一定有写权限）。
  exact('POST', '/doc/delete', 'permission', 'knowledge.write'),
  // 图集（REQ-20261120-003 S-06）：分片上传与卸载都属写入；scope 判定在 handler 内按 body/query 做
  exact('POST', '/atlas/package', 'permission', 'knowledge.write'),
  exact('DELETE', '/atlas/package', 'permission', 'knowledge.write'),
  exact('POST', '/import/upload', 'permission', 'knowledge.write'),
  exact('POST', '/import/run', 'permission', 'knowledge.write'),
  exact('POST', '/import/preflight', 'permission', 'knowledge.write'),
  exact('POST', '/import/retry-incomplete', 'permission', 'knowledge.write'),

  // ── 数据源 ──
  exact('GET', '/datasource/list', 'permission', 'datasource.read'),
  exact('GET', '/datasource/detail', 'permission', 'datasource.read'),
  exact('POST', '/datasource/sync', 'permission', 'datasource.write'),
  exact('POST', '/datasource/schedule', 'permission', 'datasource.write'),
  exact('POST', '/datasource/add-remote', 'permission', 'datasource.write'),
  exact('POST', '/datasource/update', 'permission', 'datasource.write'),
  exact('POST', '/datasource/remove', 'permission', 'datasource.delete'),
  exact('POST', '/datasource/prune', 'permission', 'datasource.delete'),
  exact('POST', '/import/prune', 'permission', 'datasource.delete'),

  // ── 知识视图（REQ-20261104-004 / D2、D6）──
  // 读：所有登录角色（团队共享，D1）；写：所有登录角色，**创建者过滤在 handler 里做**。
  // ⚠ 写不能用 knowledge.write：viewer 也要能建自己的视图（D6）。
  exact('GET', '/views', 'permission', 'views.read'),
  exact('GET', '/views/impact', 'permission', 'views.read'),
  exact('POST', '/views', 'permission', 'views.write'),
  pattern('PATCH', /^\/views\/[^/]+$/, 'permission', 'views.write'),
  pattern('DELETE', /^\/views\/[^/]+$/, 'permission', 'views.write'),

  // ── 知识治理（REQ-20261113-004 · S-06）：30 条，读用 knowledge.read / 写用 knowledge.write ──
  exact('GET', '/governance/lifecycle/list', 'permission', 'knowledge.read'),
  exact('POST', '/governance/lifecycle/apply', 'permission', 'knowledge.write'),
  exact('POST', '/governance/lifecycle/batch-apply', 'permission', 'knowledge.write'),
  exact('GET', '/governance/lifecycle/presets', 'permission', 'knowledge.read'),
  exact('POST', '/governance/lifecycle/presets', 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/lifecycle\/presets\/[^/]+$/, 'permission', 'knowledge.write'),
  exact('GET', '/governance/event-types', 'permission', 'knowledge.read'),
  exact('POST', '/governance/event-types', 'permission', 'knowledge.write'),
  pattern('PATCH', /^\/governance\/event-types\/[^/]+$/, 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/event-types\/[^/]+$/, 'permission', 'knowledge.write'),
  exact('GET', '/governance/events', 'permission', 'knowledge.read'),
  exact('POST', '/governance/events', 'permission', 'knowledge.write'),
  // 子路径必须先于单段短路（否则 /events/:id 会先命中）
  // 正在跑分析的事件 id 清单（2026-11-19）：列表行「分析中」标记；漏登记同样是 404
  exact('GET', '/governance/events/running', 'permission', 'knowledge.read'),
  // 关联文档增删（REQ-20261116-004）：漏登记会直接 404（matchRoute 未命中 = unknown = 404）
  // 置顶 / 取消置顶（2026-11-19）：漏登记同样是 404，不是 403
  pattern('POST', /^\/governance\/events\/[^/]+\/pin$/, 'permission', 'knowledge.write'),
  pattern('POST', /^\/governance\/events\/[^/]+\/members$/, 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/events\/[^/]+\/members$/, 'permission', 'knowledge.write'),
  pattern('POST', /^\/governance\/events\/[^/]+\/refs\/search$/, 'permission', 'knowledge.read'),
  pattern('POST', /^\/governance\/events\/[^/]+\/stage$/, 'permission', 'knowledge.write'),
  pattern('POST', /^\/governance\/events\/[^/]+\/reopen$/, 'permission', 'knowledge.write'),
  pattern('GET', /^\/governance\/events\/[^/]+\/refs$/, 'permission', 'knowledge.read'),
  pattern('POST', /^\/governance\/events\/[^/]+\/refs$/, 'permission', 'knowledge.write'),
  // 上传文件并挂为参考文档（REQ-20261118-001）：写操作；漏登记 = 404
  pattern('POST', /^\/governance\/events\/[^/]+\/refs\/upload$/, 'permission', 'knowledge.write'),
  // 「AI 查找」结论的固定 / 回读（2026-11-19）：漏登记同 upload —— 曾静默 404「总结未能固定」
  pattern('GET', /^\/governance\/events\/[^/]+\/refs\/find-summary$/, 'permission', 'knowledge.read'),
  pattern('POST', /^\/governance\/events\/[^/]+\/refs\/find-summary$/, 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/events\/[^/]+\/refs$/, 'permission', 'knowledge.write'),
  pattern('POST', /^\/governance\/events\/[^/]+\/analyze$/, 'permission', 'knowledge.write'),
  pattern('POST', /^\/governance\/events\/[^/]+\/analysis\/cancel$/, 'permission', 'knowledge.write'),
  pattern('GET', /^\/governance\/events\/[^/]+\/analysis$/, 'permission', 'knowledge.read'),
  // 追问（B2）：提问与读记录都要 knowledge.ask（viewer 有该能力）；
  // 清空是写操作，要求 knowledge.write。
  // 发起追问是**模型消耗型**（#96）：不写数据但会调上游模型 + 外发库内片段，只读 Token 拒绝，
  // 与 `/mcp` 对 `ki_ask` 返回 `TOKEN_MODEL_FORBIDDEN` 同口径。
  modelRoute('POST', /^\/governance\/events\/[^/]+\/analysis\/ask$/, 'knowledge.ask'),
  // 流式追问（SSE）：与普通 POST 同权限，同属模型消耗型
  modelRoute('POST', /^\/governance\/events\/[^/]+\/analysis\/ask\/stream$/, 'knowledge.ask'),
  /*
   * 停止追问（2026-11-24）：与**发起**同权限，而不是跟分析停止一样要 `knowledge.write`。
   * 理由：能发起就能收回 —— viewer 有 `knowledge.ask`，若这里要写权限，
   * 他发起的追问就只能等超时。分析停止之所以要 write，是因为发起分析本身就要 write。
   * ★ 不标 `modelConsuming`：停止不调模型（#96 只拦"发起"，否则连收回都做不到）。
   */
  pattern('POST', /^\/governance\/events\/[^/]+\/analysis\/ask\/cancel$/, 'permission', 'knowledge.ask'),
  // 读追问记录：纯读，不调模型
  pattern('GET', /^\/governance\/events\/[^/]+\/analysis\/ask$/, 'permission', 'knowledge.ask'),
  pattern('DELETE', /^\/governance\/events\/[^/]+\/analysis\/ask$/, 'permission', 'knowledge.write'),
  pattern('POST', /^\/governance\/events\/[^/]+\/analysis\/confirm$/, 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/events\/[^/]+\/analysis\/draft$/, 'permission', 'knowledge.write'),
  // 人工校正三块产物（2026-11-23 · REQ-20261123-001）：整块提交，写操作 → knowledge.write。
  // 与 GET /analysis 同路径不同方法，正则不冲突。
  pattern('PATCH', /^\/governance\/events\/[^/]+\/analysis$/, 'permission', 'knowledge.write'),
  // 整份重置分析（2026-11-23）：清草稿 + 已确认位置 + 断点 + 追问记录，属写操作。
  // 与上面 `/analysis/draft` 并列，正则互斥（一个带 `/draft` 段、一个不带），顺序无关。
  pattern('DELETE', /^\/governance\/events\/[^/]+\/analysis$/, 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/events\/[^/]+\/analysis\/confirmed\/[^/]+$/, 'permission', 'knowledge.write'),
  pattern('GET', /^\/governance\/events\/[^/]+$/, 'permission', 'knowledge.read'),
  pattern('PATCH', /^\/governance\/events\/[^/]+$/, 'permission', 'knowledge.write'),
  pattern('DELETE', /^\/governance\/events\/[^/]+$/, 'permission', 'knowledge.write'),
  exact('GET', '/governance/docs', 'permission', 'knowledge.read'),
  exact('GET', '/governance/docs/search', 'permission', 'knowledge.read'),
  exact('GET', '/governance/trash', 'permission', 'knowledge.read'),
  // 回收站条目的正文快照（2026-11-23）：读操作，与列表同档；漏登记 = 404「接口不存在」
  exact('GET', '/governance/trash/content', 'permission', 'knowledge.read'),
  exact('POST', '/governance/trash/restore', 'permission', 'knowledge.write'),
  exact('POST', '/governance/trash/purge', 'permission', 'knowledge.write'),
  exact('POST', '/governance/trash/sweep', 'permission', 'knowledge.write'),
  exact('GET', '/governance/trash/settings', 'permission', 'knowledge.read'),
  exact('PUT', '/governance/trash/settings', 'permission', 'knowledge.write'),
  exact('GET', '/governance/diagnostics', 'permission', 'knowledge.read'),
  exact('GET', '/governance/counts', 'permission', 'knowledge.read'),

  // ── 运维 / 任务取消 ──
  exact('POST', '/restore/run', 'permission', 'ops.write'),
  exact('GET', '/restore/status', 'permission', 'tasks.read'),
  exact('POST', '/restore/cancel', 'permission', 'tasks.cancel'),
  exact('POST', '/vector/optimize', 'permission', 'ops.write'),
  exact('POST', '/import/cancel', 'permission', 'tasks.cancel'),
];

export function matchRoute(method: string, path: string): RouteMatch {
  const upper = method.toUpperCase();
  for (const rule of RULES) {
    if (rule.method !== '*' && rule.method !== upper) continue;
    if (!rule.test(path)) continue;
    return {
      kind: rule.kind,
      ...(rule.capability ? { capability: rule.capability } : {}),
      ...(rule.modelConsuming ? { modelConsuming: true as const } : {}),
    };
  }
  return { kind: 'unknown' };
}
