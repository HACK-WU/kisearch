# S-06：MCP Server 改造

> 覆盖 REQ-02 扩展（server 服务 CLI + 启动预检）+ 所有 MCP 工具适配。共享术语见父文档 §3.2。

## 1. 术语

| 术语 | 含义 | 引用 |
|------|------|------|
| `--serve` 模式 | `ki mcp --serve` 以子进程模式运行，供 CLI 在**无持久 server** 时通过 stdio 通道调用（兜底） | 见 S-04 |
| 常驻 `ki server`（独立守护，模型 Y） | 单一持有 zvec rw 句柄，**暴露单一 HTTP 通道（StreamableHTTP）同时服务 CLI 与 Agent**（`ki mcp --serve` stdio 仅作无 daemon 兜底） | 见 S-04 §3.1–§3.4（方案甲·模型 Y，2026-07-21 决策） |
| 启动预检 | `ki mcp` 启动时调用 `runStartupCheck`，❌ 拒绝启动 | 见 S-02 |
| health check | 配置诊断函数集 | 见父文档 §3.2 |

## 2. 现状（AS-IS）

### 2.1 现状描述

`scripts/mcp-server.ts` 使用 `McpServer` + `StdioServerTransport` 启动常驻 server，注册 8 个工具（query-group / get-module-info / sync-relation / manage-index / search / store / bulk-store / delete-relation）。工具内部调用 `mem-client.ts` 函数。启动时无配置预检。

> **方案甲约束 · 部署模型 Y（2026-07-21 决策）**：需新增 `ki server` **独立守护进程**形态——单一持有 zvec rw 句柄，暴露**单一 HTTP 通道（StreamableHTTP）同时服务 CLI 与 AI Agent**（二者都是该 daemon 的 HTTP 客户端，Agent 不再 spawn `--serve` 子进程、不再用 stdio）。`ki mcp --serve` 的 stdio 模式保留为「无 daemon 时」的 CLI 兜底，但 Agent 在此模式下不可用、须提示先 `ki server start`。详见 `design/REF_S04_CLI_Server_Channel_DESIGN.md` §3.1–§3.4。

8 个 MCP 工具文件（`scripts/lib/mcp-tools/`）：
- `search.ts` — 调用 `memSearch`，返回 `{ ok, results: [] }` 扁平结构
- `store.ts` — 调用 `memStore`
- `bulk-store.ts` — 调用 `memBulkStore`
- `sync-relation.ts` — 调用 `memStoreAsync` + `memSearch`
- `query-group.ts` — 调用 `memSearch`（tags: ki-path）
- `get-module-info.ts` — 调用 `searchPath`（间接 mem）
- `manage-index.ts` — 调用 `ensureMemAvailable`
- `delete-relation.ts` — 调用 `memSearch`

### 2.2 痛点

- 痛点 1：工具内部调 `mem-client.ts`（sync），换引擎后需改 async
- 痛点 2：search 工具返回扁平 `{ results: [] }`，需改为 `{ partitions: {} }`（S-05）
- 痛点 3：启动时无预检，embedding 不可用等问题延迟到首次请求才暴露
- 痛点 4：不支持 `--serve` 模式（CLI 子进程调用需要）

## 3. 方案（TO-BE）

### 3.1 方案概述

MCP Server 改造三点：①启动时调用 `runStartupCheck` 预检（S-02）；②工具内部从 `mem-client.ts` 改为 Vector Adapter（S-03）；③支持 `--serve` 模式（S-04）。search 工具返回 partitions 结构（S-05）。

> **N9 决策（2026-07-21）：daemon 用 Node 自研，不复用官方 Python server**。模型 Y 的 `ki server` 守护进程基于本项目 Node zvec 绑定（`zvec-probe-node`）实现——复用 `scripts/mcp-server.ts` 基础，改用 `StreamableHTTPServerTransport` 暴露单一 HTTP 通道服务 CLI + Agent；`ki mcp --serve` 的 stdio 模式仅作无 daemon 兜底。官方 `zvec-mcp-server`（Python/FastMCP，17 工具）**仅作移植规范参考**：其 17 个工具的语义/输入 schema 是 `ki server` 工具面的对齐基准，`ki` 现有 8 工具为 MVP，缺口工具按需补齐（见 §3.4）。N5③（StreamableHTTP 并发多 client）的验证对象相应改为 **MCP TypeScript SDK**。

### 3.2 关键决策点

| 决策 | 选择 | 理由 | 备选方案 | 否决原因 |
|------|------|------|---------|---------|
| `--serve` 模式实现 | 复用 `startMcpServer()`，跳过启动预检的阻塞流程 | 工具注册逻辑完全复用 | 独立 serve 入口 | 代码重复 |
| `--serve` 模式是否预检 | 跳过（CLI 调用前可先 `ki doctor`） | CLI per-call spawn 已有 ~1s 开销，预检再加 ~2s 太慢 | 仍做预检 | CLI 路径延迟过高 |
| 工具注册位置 | 保持在 `mcp-tools/` 目录 | 结构不变，只改内部实现 | 集中注册 | 改动面大 |

### 3.3 行为差异对照表

| 场景 | AS-IS | TO-BE | 影响 |
|------|-------|-------|------|
| 启动流程 | 直接注册工具 + connect | 先 `runStartupCheck` → 通过 → 注册工具 + connect | 增强预检 |
| search 工具返回 | `{ ok, results: [] }` | `{ ok, partitions: {} }` | 破坏性（结构变更） |
| 工具内部调用 | `mem-client.ts`（sync） | Vector Adapter（async） | 内部变更 |
| `--serve` 模式 | 不支持 | 支持（CLI 子进程调用） | 新增 |

### 3.4 守护进程实现要点（N9 / N3–N8）

模型 Y 的 `ki server` 守护进程基于 Node（复用 `scripts/mcp-server.ts`，改用 `StreamableHTTPServerTransport`）实现。以下把 v4 复审的 N3–N8 决策落点归集于此：

| 决策点 | 选择 | 理由 / 备注 |
|--------|------|------------|
| 传输（N9 / N5③） | `StreamableHTTPServerTransport`（HTTP，单进程服务 CLI + Agent 多 client） | TS SDK 的 StreamableHTTP 为 HTTP 承载，单进程可并发多会话；N5③ 用 TS SDK 双 client 烟雾测试确认。stdio 仅保留 `--serve` 兜底 |
| 多项目 daemon 绑定（N3，2026-07-21 统一·消解 N10） | **单一全局 daemon 绑定单一 `config.yaml` + 单一 collection（由 `vectorDir` 决定，非 3 个）**，单一端口（默认 18789），pidfile 按 `vectorDir` 哈希（仍支持同机多 config 的高级多 daemon）。**多项目 = `scope` 元数据区隔，而非多个 daemon**：单一 collection 内经 `scope` metadata 区分项目（见「工具目标寻址」行），Agent 静态端点永远指向同一 daemon，切换项目 = 改 `scope` 参数，不换端口、不重配端点 | 消除 N10「固定端点 × 多 daemon 端口」冲突：常见形态只有 1 个 daemon，端点静态配置永不失效、无跨项目串味；`scope` 是既有的三层 fallback 继承机制（S-01），本就是项目/KB 命名空间 |
| Agent 端点与项目切换（N10 解决） | Agent 在 IDE 静态登记 **单一** HTTP 端点 `http://127.0.0.1:<httpPort>/mcp`（默认 18789）；项目切换**不切 daemon**，由 Agent 在工具调用里传 `scope`（= 当前项目 scope 名）实现。仅「同机多 ki 配置」高级场景才需多端点，此时各 daemon 端点显式不同、由用户/IDE 分别登记 | N10 原「静态端点无法随 cwd 切换」化解：端点恒为全局 daemon，项目切换下沉为 `scope` 参数（无状态 HTTP 下天然支持，每次调用自带 scope） |
| 工具目标寻址（N13 澄清 · scope×tag，复用 S-03/S-05） | 无状态 StreamableHTTP 下，目标落点由 **单 collection 内二维 metadata 过滤** 决定：**level1 `scope`**（项目/KB 命名空间，默认 default，S-01 三层 fallback，S-03 已定义为 zvec metadata）；**level2 `tags`**（内容类别 ki-search/ki-path/ki-relation，S-05 `DEFAULT_TAGS`，亦为 metadata）。worker open **单一** collection（vectorDir）；工具按 `scope`×`tags` 过滤，`tags` 默认按工具角色。详见 §3.5 | N13 实为「契约澄清」非「设计冲突」：S-03(scope)+S-05(tags) 已定义完整寻址，工具本就有 scope+tags；本行只点明无状态 HTTP 下须显式带。注：ki-search/ki-path/ki-relation 是 tag 非独立 collection |
| stop 阻塞期语义（N4） | `ki server stop` 发 SIGTERM → 拒绝新请求、等待在途 zvec 调用完成（上限 ~5s）→ 释放锁退出；在途 CLI/Agent 请求收到 503「daemon shutting down」，客户端可重试/回退 | **修正（zvec-probe-node 实测）**：`@zvec/zvec` v0.5.0 写入 API 全 Sync-only，若 zvec 调用跑在主线程，长 bulk insert 会**硬阻塞整个事件循环**，连 stop 信号都得等其跑完——比「软串行」严重。故 zvec 调用必须下沉到 worker 线程（见下「写入线程模型」），主线程永不直调 Sync 写入，stop 信号才能及时响应 |
| 写入线程模型（N4 衍生 / zvec-probe-node 实测） | **单一 zvec worker（actor 模型）**：`ZvecEngine` 实例跑在 dedicated `worker_threads`；worker 启动时 `ZVecOpen` 一次持有唯一句柄；主线程持 `ZvecEngineProxy`，所有方法 async 签名、经 `postMessage` 转发到 worker；embedding（SiliconFlow）在 worker 内闭环 | ①消解「同进程再 open 锁冲突」(read_only 也冲突→查询也得进 worker)；②主线程事件循环/HTTP 服务不被 bulk 写入冻结、stop 信号可及时响应；③async 契约(S-03)靠 worker 兑现（绑定无 async 写 API）；④worker 崩溃→主线程重 spawn 并重 `ZVecOpen` 恢复。代价：查询多一次 postMessage 往返(~0.1ms)，可接受。详见 `review/fix-plan.md` §1 |
| HTTP 鉴权（N5①） | 默认 `127.0.0.1` loopback 仅本机可达；可选 `server.httpToken` bearer token（Agent 与 CLI 均须带） | 不暴露到 `0.0.0.0`；loopback 下 token 可选 |
| 端口冲突（N5②） | `start` 时若 `server.httpPort` 被**非 ki 进程**占用 → 拒绝启动并报「端口 X 被占用，请更换 server.httpPort 或先释放」；被**本 ki daemon** 占用 → 报告「已在运行（pid Y）」 | 区分自身/他人占用，避免误杀 |
| daemonize（N6） | `ki server start` 用 `child_process.spawn(..., { detached: true, stdio: 'ignore' })` + 写 pidfile（`~/.ki/<vectorDir-hash>.pid`）；Windows 无 fork 但 `detached` 可用，需注意无 `setsid`（用 `process.title` + pidfile 管理） | 跨平台 detached 机制 |
| Agent 端点配置（N7） | 固定默认端口 `18789`，Agent 读 `config.yaml server.httpPort`（缺省 18789）或环境变量 `KI_MCP_HTTP_URL`；文档固化该端点 | Agent 预配置，无需动态发现 |
| isLocked 语义（N8） | 路由层 probe **走 pidfile 存活 + HTTP `/health`**，不调 `ZvecEngine.isLocked`；daemon 自身不判定「是否被自己持有」 | 对齐 S06_Engine §57 的「isLocked = 其他进程持锁」语义 |

**工具面与官方 17 工具的对齐**

`ki server` 复用 ki 现有 8 工具为 MVP；官方 `zvec-mcp-server` 的 17 工具作为语义/输入 schema 参考，缺口按需补齐：

| 官方 17 工具（参考） | ki 现状 / 补齐策略 |
|---------------------|-------------------|
| `open_collection` / `list_cached_collections` / `remove_collection_from_cache` | daemon 启动按 config 预开集合 + 进程内缓存；不直接暴露为 MCP 工具（内部状态） |
| `create_collection` / `destroy_collection` | 由 `ki import-kb` / `ki restore`（本地独占重建）覆盖，不在常驻 daemon 暴露写竞争 |
| `get_collection_info` | 可并入 `get-module-info` 扩展或新增 MVP 后补齐 |
| `insert_records` / `upsert_records` / `bulk_insert` | → `store` / `bulk-store` |
| `query` / `search` | → `search` / `query-group` |
| `delete_by_id` / `delete_by_predicate` | → `delete-relation`（by_id 优先；predicate 按需） |
| `update_by_id` | 按需补齐（MVP 暂由 upsert 覆盖） |
| `create_index` / `drop_index` / `list_indexes` | → `manage-index`（create/list 优先；drop 按需） |

> 实现前须先确认 Node zvec 绑定（`zvec-probe-node`）是否提供与官方 server 等价的 API（`create_and_open` / `open` / `insert` / `upsert` / `query` / `search` / `delete` / `manage_index` 等）；若缺项，先在 S-03 补齐绑定封装。

### 3.5 工具目标寻址（scope × tag · 解决 N10/N13，复用 S-03/S-05）

**背景**：官方 `zvec-mcp-server` 靠**每会话 `open_collection(name)`** 建立集合上下文；本 daemon 改为「worker 启动时 open **单一** collection、常驻缓存」，故无状态 StreamableHTTP 下须显式定义「一次工具调用落到哪条数据」。v5 复审（N10/N13）的本意由此统一回答。

**事实校准（2026-07-21 评估复核 S-03/S-05/`src/zvec-engine`）**：`ki-search`/`ki-path`/`ki-relation` **不是 3 个独立 collection，而是 S-05 定义的 `tag`**（`DEFAULT_TAGS`，`partitions` 输出按 tag 分组）；`src/zvec-engine` 持**单一** `collection` 句柄（`ZvecEngineConfig.collection` 为单对象）。故寻址是「单 collection 内的 metadata 过滤」，**不是**「多 collection 路由」。`scope` 与 `tags` 均为 S-03 §3 已定义的 zvec metadata 字段（`vectorStore/Search/BulkStore/Delete` 全带 scope）。

**核心模型：单一 collection + scope × tag 二维 metadata 寻址**

```
        单一全局 daemon（单一 config.yaml · 单一端口 18789）
                      │
                      │ worker ZVecOpen 一次 → 持单一 collection 句柄（vectorDir）
                      ▼
        ┌──────────────────────────────────────────────┐
        │        单一 zvec collection（vectorDir）       │
        │  每条 doc 携带两个 metadata 维度：              │
        │   • scope = 项目/KB 命名空间（默认 default）    │  ← level1（S-01 三层 fallback）
        │   • tags  = ki-search | ki-path | ki-relation  │  ← level2（S-05 DEFAULT_TAGS）
        └──────────────────────────────────────────────┘
```

- **level1 `scope`** = 项目/KB 命名空间，metadata 字段（S-03 §3 已定义），默认 `"default"`，按 S-01 三级 fallback 继承。插入写入该 metadata、查询按其过滤。**多项目 = scope 区隔，不是多 daemon**（回答 N10，见 §3.4 N3 修订）。
- **level2 `tags`** = 内容类别，metadata 字段（S-03 §3 / S-05 已定义，数组），`DEFAULT_TAGS = [ki-search, ki-path, ki-relation]`。每工具有确定性默认 tag（见下表）；`search` 缺省=跨三 tag 并发查询返回 `partitions`（S-05 `searchWithPartitions`）。

**工具 → 默认 tag 映射（与 S-05 / 现有代码一致，复用既有 `tags` 参数，不新造 partition）**

| 工具 | 默认 `tags` | 读写 | `scope` 默认 | 说明 |
|------|------------|------|-------------|------|
| `store` | ki-search | 写 | default | 记笔记/片段；可带 `tags` 覆盖 |
| `bulk-store` | ki-search | 写 | default | 批量写入 ki-search |
| `search` | 全部（返回 partitions） | 读 | default | `tags` 缺省=跨三 tag 返回 partitions map（S-05）；给定则只查该 tag |
| `query-group` | ki-path | 读 | default | 按路径/Group 树检索 |
| `sync-relation` | ki-relation | 写+读 | default | 关系抽取与写入 |
| `delete-relation` | ki-relation | 删 | default | 按 id/predicate 删除关系 |
| `manage-index` | — | 索引 | default | 索引操作作用于单一 collection（无 tag 维度） |
| `get-module-info` | ki-path | 读 | default | 模块信息（自动受益） |

**worker open 规则**：daemon 启动（worker `ZVecOpen(rw)`）open **单一 collection**（由 `config.vectorDir` 决定），常驻句柄；scope/tag 数量不影响 open（二者皆 metadata，非独立 collection）。官方 `open_collection`/`list_cached_collections` 在本架构退化为「单集合常驻」，不暴露为 MCP 工具（内部状态，见 §3.4 工具面对齐表）。

**边界**：`tags` 取值不在 DEFAULT_TAGS 或 `scope` 未声明于 config 时 → 返回 `{ ok:false, error:"unknown tag/scope" }`，不静默落错（杜绝多 scope 歧义，即 N13 的真实诉求）。

> **N13 定性修正（2026-07-21 评估）**：N13 非「设计冲突」，而是「契约澄清」——S-03(scope metadata) + S-05(tags+partitions) 已定义完整寻址，工具本就有 `scope`+`tags` 参数。本节只是把「无状态 HTTP 下每次调用须显式带 scope/tags」点明为契约。原 v5 把 N13 列为 🟡 设计冲突属过度定性。

> **⚠️ N19（新增 · N10 残留真问题）**：本节把 N10 的「端点切换」转为「scope 传参」，但**未定义谁负责 cwd/项目 → scope 的映射**。无状态 StreamableHTTP 下 daemon 拿不到 Agent 的 cwd；若 LLM 默认传 `scope="default"`，多项目数据会混入 default —— N10 串味风险仅被推迟、未被根除。须另定：单项目用户(默认 default)安全；多项目须 IDE 侧按项目配置 scope、或 daemon 支持 `X-Ki-Scope` 请求头由 Agent 注入、或文档强约束。**N19 = 🟡，待解，优先级高于原 N13。**

## 4a. 接口设计

### 4a.1 对外接口

```typescript
// scripts/mcp-server.ts — 改造后

async function startMcpServer(options?: { mode?: 'stdio' | 'serve' | 'daemon' }): Promise<void>;
// mode = 'stdio'（默认，ki mcp）→ 启动预检 → 注册工具 → connect(StdioServerTransport)
// mode = 'serve'（ki mcp --serve）→ 跳过预检 → 注册工具 → connect(StdioServerTransport)，无 daemon 时 CLI 兜底
// mode = 'daemon'（ki server start）→ 启动预检 → ZvecEngine.open(rw) → 注册工具 → connect(StreamableHTTPServerTransport, httpPort) → 写 pidfile，常驻（N9）

// 启动流程（stdio 模式，ki mcp）:
// 1. loadConfig()
// 2. runStartupCheck(config) → ❌ 则 console.error + process.exit(1)
// 3. ZvecEngine.open(vectorDir) → 持有 collection 句柄
// 4. 注册 MCP 工具（工具内部用 Vector Adapter）
// 5. server.connect(new StdioServerTransport())

// 启动流程（--serve 模式，ki mcp --serve）:
// 1. loadConfig()
// 2. ZvecEngine.open(vectorDir)
// 3. 注册 MCP 工具
// 4. server.connect(new StdioServerTransport())
// 5. 等待 stdio 请求，处理后随 stdin 关闭退出

// 启动流程（daemon 模式，ki server start，N9）:
// 1. loadConfig() → 解析 server.httpPort（缺省 18789）与 vectorDir
// 2. 端口占用校验（N5②）：被非 ki 占用 → 拒绝并报错；被自身占用 → 报「已在运行(pid Y)」
// 3. runStartupCheck(config) → ❌ 则 console.error + process.exit(1)
// 4. ZvecEngine.open(vectorDir, rw) → 唯一持有 rw 锁（模型 Y 单锁持有者）
// 5. 按 config 预开集合 + 进程内缓存（对齐官方 open_collection）
// 6. 注册 MCP 工具（工具内部用 Vector Adapter，复用 daemon 句柄）
// 7. server.connect(new StreamableHTTPServerTransport({ port: httpPort, ... }))
// 8. 写 pidfile（~/.ki/<vectorDir-hash>.pid，N3/N6）→ detached 常驻，服务 CLI + Agent
// 9. 收到 SIGTERM（ki server stop）→ 拒新请求、等待在途 zvec 调用（≤5s，N4）→ 释放锁退出
```

### 4a.2 MCP 工具适配清单

| 工具文件 | 原调用 | 新调用 | 返回结构变更 |
|---------|--------|--------|:----------:|
| `mcp-tools/search.ts` | `memSearch` | `searchWithPartitions`（S-05） | 是（→ partitions） |
| `mcp-tools/store.ts` | `memStore` | `vectorStore` | 否 |
| `mcp-tools/bulk-store.ts` | `memBulkStore` | `vectorBulkStore` | 否 |
| `mcp-tools/sync-relation.ts` | `memStoreAsync` + `memSearch` | `vectorStoreAsync` + `vectorSearch` | 否 |
| `mcp-tools/query-group.ts` | `memSearch`（ki-path） | `vectorSearch`（ki-path，扁平） | 否 |
| `mcp-tools/get-module-info.ts` | `searchPath`（间接） | `searchPath`（间接，自动受益） | 否 |
| `mcp-tools/manage-index.ts` | `ensureMemAvailable` | `ensureVectorAvailable` | 否 |
| `mcp-tools/delete-relation.ts` | `memSearch` | `vectorSearch` | 否 |

> 各工具读写的目标落点由 §3.5 的 **scope×tags 二维寻址** 决定（每工具 `tags` 默认值：store/bulk-store→ki-search；query-group→ki-path；sync-relation/delete-relation→ki-relation；search→全部；manage-index→无 tag 维度），输入 schema 见 §4a.3。

### 4a.3 MCP 工具 schema（改后 · scope×tags 寻址，复用 S-05）

> 所有读写工具携带 `scope`（默认 "default"，S-01 三级 fallback）+ `tags`（S-05 既有，默认按工具角色，见 §3.5 映射表）两个寻址字段；无状态 HTTP 下每次调用自带 scope/tags，目标落点零歧义。**不新造 `partition` 字段**——ki-search/ki-path/ki-relation 是 `tags`（metadata），非独立 collection。

```json
// search：tags 缺省 = 跨 [ki-search,ki-path,ki-relation] 查询返回 partitions（S-05）；给定则只查该 tag
{
  "name": "search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "scope": { "type": "string", "default": "default" },
      "limit": { "type": "number", "default": 10 },
      "tags": { "type": "array", "items": { "type": "string" }, "description": "缺省=DEFAULT_TAGS，返回 partitions" }
    },
    "required": ["query"]
  }
}

// store：tags 默认 ki-search（记笔记/片段），可覆盖
{
  "name": "store",
  "inputSchema": {
    "type": "object",
    "properties": {
      "content": { "type": "string" },
      "scope": { "type": "string", "default": "default" },
      "tags": { "type": "string", "default": "ki-search" }
    },
    "required": ["content"]
  }
}

// query-group(tags=ki-path) / sync-relation、delete-relation(tags=ki-relation) 同理，默认见 §3.5 映射表

// 工具返回（变更：results → partitions）
{
  "ok": true,
  "partitions": {
    "ki-search": [
      { "id": "...", "score": 0.95, "content": "...", "scope": "default" }
    ],
    "ki-path": [
      { "id": "...", "score": 0.88, "content": "...", "scope": "default" }
    ],
    "ki-relation": [
      { "id": "...", "score": 0.82, "content": "...", "scope": "default" }
    ]
  }
}
```

### 4a.4 契约变更声明

| 变更类型 | 接口 | 变更内容 | 影响的子需求 |
|---------|------|---------|------------|
| 修改 | `startMcpServer()` | 新增 `options.serve` 参数 + 启动预检 | S-04（--serve 模式）、S-02（预检调用） |
| 修改 | MCP search 工具返回 | `{ results: [] }` → `{ partitions: {} }` | S-05（partitions 结构） |
| 修改 | 8 个 MCP 工具内部调用 | mem-client → Vector Adapter | S-03（Adapter 接口） |

## +10. 影响范围

| 影响对象 | 影响类型 | 影响描述 | 破坏性 |
|---------|---------|---------|:------:|
| `scripts/mcp-server.ts` | 接口变更 | + `--serve` 模式 + 启动预检 + ZvecEngine 初始化 | 否 |
| `scripts/lib/mcp-tools/search.ts` | 接口变更 | 返回 partitions 结构 | 是 |
| `scripts/lib/mcp-tools/store.ts` | 行为变更 | memStore → vectorStore（async） | 否 |
| `scripts/lib/mcp-tools/bulk-store.ts` | 行为变更 | memBulkStore → vectorBulkStore | 否 |
| `scripts/lib/mcp-tools/sync-relation.ts` | 行为变更 | memStoreAsync → vectorStoreAsync | 否 |
| `scripts/lib/mcp-tools/query-group.ts` | 行为变更 | memSearch → vectorSearch | 否 |
| `scripts/lib/mcp-tools/get-module-info.ts` | 行为变更 | 随 path-search 自动受益 | 否 |
| `scripts/lib/mcp-tools/manage-index.ts` | 行为变更 | ensureMemAvailable → ensureVectorAvailable | 否 |
| `scripts/lib/mcp-tools/delete-relation.ts` | 行为变更 | memSearch → vectorSearch | 否 |
| `bin/ki.mjs` | 配置变更 | `mcp` 命令支持 `--serve` 参数 | 否 |

## +6. 异常处理

| 场景 | 行为 | 对外暴露 |
|------|------|---------|
| 启动预检 ❌（apiKey 缺失 / URL 不通） | `console.error` 输出失败项 + `process.exit(1)` | 是（CLI stderr） |
| 启动预检 ⚠️（zvec collection 未创建） | `console.warn` 输出警告 + 正常启动 | 是（CLI stderr，不阻断） |
| ZvecEngine.open 失败（锁冲突） | `console.error` + `process.exit(1)` | 是 |
| 工具调用 embedding 失败 | 返回 `{ ok: false, error: "embedding failed: ..." }` | 是（MCP 响应） |
| 工具调用 zvec 错误 | 返回 `{ ok: false, error: "..." }` | 是 |
| `--serve` 模式 stdin 关闭 | 子进程正常退出（`process.exit(0)`） | 否 |
| `--serve` 模式 30s 无请求 | 超时退出（避免僵尸进程） | 否 |
