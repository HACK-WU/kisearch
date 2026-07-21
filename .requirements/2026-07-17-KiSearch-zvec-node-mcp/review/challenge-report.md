# 设计文档质疑报告

> 质疑对象：`refactor-requirement-mining.md`（KiSearch 重构需求挖掘报告）
> 质疑模式：设计文档二次质疑
> 日期：2026-07-21

## 设计上下文确认

### 设计目标
- **核心目标**：把 ki 从「无状态薄封装 + 外部 mem 进程」改造为「自持有向量状态的常驻服务」
- **衡量标准**：CLI 接口不变、备份/恢复不受影响、查询毫秒级、多标签分区显示
- **目标优先级**：用户无感（P0）> 引擎替换（P0）> 多标签分区（P1）> scope 简化（P2）

### 设计范围
- **覆盖范围**：4 个新 REQ（配置独立化、CLI↔server 通道、多标签分区、scope 运行时化）+ 10 个现有 REQ 扩展
- **排除范围**：基座模块（已完成）、MCP 生命周期监管（REQ-09 不变）
- **系统边界**：基座模块 ZvecEngine 之上、MCP 协议之下

### 约束与假设
- **技术约束**：zvec 0.6.0 Node 绑定、单集合 + metadata 过滤、jieba FTS 分词器
- **隐含假设**：
  - MCP client SDK 支持 CLI→server 通信模式（**未验证**）
  - `scopes` 配置仅用于向量隔离（**实际还承载 KB 目录映射，见反对意见 1**）
  - server 进程稳定运行，不会在 CLI 请求过程中崩溃（**未设计超时恢复**）

### 确认状态
- ✅ 设计目标明确
- ⚠️ 隐含假设有 2 项未验证

---

## 反对意见

### 意见 1：移除 `scopes` 配置会破坏 KB 目录映射

- **反对理由**：文档 REQ-14 说「config.json 不再有 scopes 字段」，REQ-11 的目标配置结构也完全没有 scopes。但当前 `config.ts` 的 `KiConfig.scopes: Record<string, ScopeConfig>` 承载 **两类配置**：
  1. 向量 scope 隔离（本次要移除——正确）
  2. **KB 目录映射**：`kbDir`（KB 数据目录）、`sourceDir`（源文件目录）、`rootName`（Group 树根名）、`wikiSync`（Wiki 同步配置）——**这些与向量无关，不能移除**

  代码证据（4 个 config.ts 函数 + 3 个消费方）：
  - `getScopeDataDir(config, scope)`（config.ts:177）→ 用 `scopes[scope].kbDir` 定位 KB 数据目录，fallback 到 `dataDir/{scope}`
  - `getScopeSourceDir(config, scope)`（config.ts:193）→ 用 `scopes[scope].sourceDir` 定位源文件目录，**无 fallback**
  - `getScopeRootName(config, scope)`（config.ts:200）→ 用 `scopes[scope].rootName` 获取 Group 树根名，**无 fallback**
  - `getScopeWikiSync(config, scope)`（config.ts:207）→ 用 `scopes[scope].wikiSync` 获取 Wiki 同步配置，**无 fallback**
  - `scope.ts:31` getKbDir()、`store.ts:217` 旧数据检测、`wiki-sync.ts:44` Wiki 同步均依赖 scopes 配置

  完全移除 scopes 后，`sourceDir`/`rootName`/`wikiSync` 丢失，wiki-sync、diff、import 的 scope 级配置全部失效。

- **严重程度**：🔴 致命
- **替代方案**：不要移除整个 `scopes` 字段，而是 **拆分语义**：
  - 向量 scope 隔离 → 移除（由 zvec metadata 过滤替代，REQ-14 的「自动创建」仅适用于此层）
  - KB 目录映射 → **保留** `scopes` 字段中的 `kbDir`/`sourceDir`/`rootName`/`wikiSync`
  - 或者：如果用户确实想简化 config，将 KB 目录映射改为 per-command 参数（`--source-dir`/`--root-name`，import-kb 已支持 `sourceDirOverride`/`rootNameOverride`），但 wikiSync 需要另行处理
- **验证方法**：移除 scopes 后跑 `ki scan-kb import --scope test`，检查 sourceDir/rootName 是否正确解析

### 意见 2：MCP client SDK CLI↔server 通信可行性未验证

- **反对理由**：REQ-12 的核心架构——「CLI 使用 MCP client SDK 连本地 server」——是一个 **未验证的技术假设**。当前 MCP server 使用 `StdioServerTransport`（mcp-server.ts:29），设计为单客户端（AI agent）通过 stdin/stdout 连接。CLI 要连同一个 server，面临：
  1. stdio 传输已被 AI agent 占用，CLI 无法再通过 stdio 连接
  2. 需要额外开 HTTP/SSE/Unix socket 传输通道，但 MCP SDK 是否支持同一 server 同时监听多种传输？
  3. 文档自己也说「取决于 MCP SDK 支持度，设计阶段定」——这是一个可能阻断整个 REQ-12 的未决问题

  如果 MCP SDK 不支持多传输/多客户端，REQ-12 的选项 C 就退化为选项 B（per-call spawn），CLI 永远走兜底路径（~1s），<5ms 承诺落空。

- **严重程度**：🔴 致命
- **替代方案**：
  - 方案 A：server 同时开 stdio（给 AI agent）+ HTTP/Unix socket（给 CLI），需验证 MCP SDK 多传输支持
  - 方案 B：不走 MCP 协议，CLI↔server 用简单的 JSON-RPC over Unix socket，自实现轻量协议（不依赖 MCP SDK client）
  - 方案 C：server 开 HTTP health check + REST API，CLI 用 fetch 调用（最简单，但脱离 MCP 生态）
- **验证方法**：在设计阶段先写 10 行 demo 验证 MCP SDK 多传输支持，或验证 Unix socket JSON-RPC 可行性

### 意见 3：server 生命周期中间态未覆盖

- **反对理由**：REQ-12 只设计了两种状态：「server 运行中」→ 走 server；「server 未运行」→ 走兜底。但实际还有：
  1. **server 启动中**（PID 已写但 zvec collection 尚未 open 完成，jieba 还在加载）→ CLI 连上但请求超时
  2. **server 崩溃中**（PID 存在但进程正在退出）→ CLI 连上但连接断开
  3. **server 持有锁但 socket 不通**（僵尸进程）→ 兜底路径也 open 失败（锁冲突）

  文档在风险表提到「锁冲突时引导用户检查 server」，但没有设计具体的超时时间、重试策略和用户引导消息。

- **严重程度**：🟡 重要
- **替代方案**：设计明确的生命周期状态机：
  - 连接超时：3s（server 启动中）→ 走兜底
  - 连接断开：立即走兜底 + 异步清理 PID
  - 兜底锁冲突：提示「server 可能僵尸，执行 `ki mcp kill` 清理」
- **验证方法**：模拟 server 启动中 / 崩溃中场景，验证 CLI 行为

### 意见 4：并发 CLI 请求未设计

- **反对理由**：多个 CLI 命令同时执行（如脚本中 `ki search & ki store`）时，都尝试连接 server。文档未说明：
  1. server 是否支持并发请求（MCP server 的 stdio transport 是单连接的）
  2. 如果用 HTTP/socket，并发请求是否排队还是并行
  3. 兜底路径并发时，多个 CLI 同时 `ZvecEngine.open()` 会锁冲突（zvec 文件锁排他）

- **严重程度**：🟡 重要
- **替代方案**：
  - server 路径：server 内部用队列串行化 zvec 操作（基座模块 worker 本就是 actor 模型，天然串行）
  - 兜底路径：多个 CLI 并发时，后续 CLI 检测到锁冲突后等待 + 重试（有上限），超时后报清晰错误
- **验证方法**：`ki search --query A & ki search --query B`，验证两个结果都正确返回

---

## 认可点

1. **三类消费方分类清晰**：修正后的 §6.1 将 14 个文件分为「直接 import mem-client（9）」「直接调 mem CLI（3）」「间接使用（2）」，适配策略明确
2. **content 文本格式保持不变**的约束识别到位——path-search 的 `extractPathFromContent` 和 relation 抽取都依赖 `【标签:xxx】` 前缀，tag 升为 metadata 但 content 格式不变是正确的兼容策略
3. **单标签显式传 --tags 时保持扁平**的折中设计好——既满足多标签分区需求，又不破坏内部单标签调用方
4. **存量迁移靠 restore 自然重建**的策略合理——不做额外 reindex 命令，复用现有恢复流程

---

## 补充场景与情况

1. **首次安装空库**：全新安装，无 config、无数据、无 server。`ki search` 应返回空结果分区（而非报错），`ki store` 应自动创建 collection
2. **空分区显示**：多标签检索时某个 tag（如 ki-relation）无结果，partition 中应返回空数组 `[]` 还是省略该 key？建议保留空数组，消费方可统一处理
3. **scope 名称含特殊字符**：`ki store --scope "my/scope"` 或 `--scope "test project"`，metadata 过滤是否正确处理？建议设计阶段约定 scope 命名规则
4. **server 升级时 schema 变更**：zvec collection schema 如果在未来版本变更（如新增 metadata 字段），运行中的 server 如何热升级？需设计 schema 演化策略
5. **ai-results 中的 tag 提取**：store/import 管线需要从 content 的 `【标签:xxx】` 前缀提取 tag 并设为 metadata 字段——这个提取逻辑在适配层还是在上层？文档提到「tag 升为 metadata」但未明确提取时机

---

## 风险评估与建议

### 识别的风险
- **风险 1**：移除 scopes 破坏 KB 目录映射 — 可能性：高 — 影响：高
- **风险 2**：MCP SDK 多传输不支持 — 可能性：中 — 影响：高
- **风险 3**：server 生命周期中间态导致 CLI 卡死 — 可能性：中 — 影响：中
- **风险 4**：并发 CLI 兜底路径锁冲突 — 可能性：低 — 影响：中
- **风险 5**：ai-results tag 提取逻辑未明确 — 可能性：中 — 影响：低

### 风险等级
- **总体风险**：🔴 高风险
- **风险分布**：高风险 2 个，中风险 2 个，低风险 1 个

### 行动建议

#### 必须处理
1. **修正 REQ-14 scope 配置移除范围**：保留 KB 目录映射（kbDir/sourceDir/rootName/wikiSync），仅移除向量 scope 隔离概念。或明确 KB 目录映射的替代方案（per-command 参数化）
2. **验证 MCP SDK 多传输支持**：在设计阶段前写最小 demo 验证 CLI→server 通信可行性，若不可行则切换替代方案（JSON-RPC over Unix socket）

#### 建议处理
3. **设计 server 生命周期状态机**：明确启动中/崩溃中/僵尸态的超时与恢复策略
4. **明确并发 CLI 行为**：server 路径串行化 + 兜底路径锁冲突重试策略

#### 可选处理
5. **明确 ai-results tag 提取时机**：在适配层统一提取还是上层各自处理
6. **约定 scope 命名规则**：避免特殊字符导致 metadata 过滤异常
