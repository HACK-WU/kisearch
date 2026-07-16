# 代码调研：memory-lancedb-pro 接口与能力文档

> 调研来源：项目记忆索引 ✗ | 知识库记忆索引 ✗ | 代码搜索 ✓ | 语义检索 ✗
> 调研范围：`memory-lancedb-pro` 暴露给 OpenClaw 的接口、参数、使用方式（含底层引擎）
> 仓库版本：`1.1.0-beta.10`（package.json），入口 `index.ts`（仓库根目录，非 `src/` 下）
> 标注约定：所有结论来源均为「代码搜索」

---

## 1. 概述

`memory-lancedb-pro` 是一个 **OpenClaw 长期记忆插件**（kind: `"memory"`），基于 LanceDB 提供向量 + BM25 混合检索、交叉编码器重排、Weibull 衰减、多 scope 隔离、智能抽取等能力。

- **入口**：`index.ts` 默认导出对象 `memoryLanceDBProPlugin`，含 `register(api)` 方法。
- **能力暴露方式**：运行时通过 `api.registerTool(name, schema, handler)` 把能力注册为 OpenClaw 工具（共约 14 个）。调用方（OpenClaw 或 `memory-lancedb-mcp` 的 FakeOpenClawApi）通过 `callTool(name, params, ctx)` 调用。
- **底层引擎可进程内直用**：核心能力（`MemoryStore` / `MemoryRetriever` / `ScopeManager` / `Embedder`）也可绕过工具层直接 import 使用。

---

## 2. 插件注册与运行时契约

### 2.1 `register(api)` 做了什么（index.ts）

1. `parsePluginConfig(api.pluginConfig)` 解析校验配置。
2. `api.resolvePath(...)` 解析 DB 路径（默认 `~/.openclaw/memory/lancedb-pro`）。
3. 初始化核心组件：`MemoryStore`、`createEmbedder`、`createDecayEngine`、`createTierManager`、`createRetriever`、`createScopeManager`、`createMigrator`、`SmartExtractor`。
4. `registerAllMemoryTools(api, context, options)` 注册工具集。
5. `api.registerCli(...)` 注册 CLI。
6. 注册生命周期钩子（`api.on` + `api.registerHook`）和后台服务（`api.registerService`）。

### 2.2 `api`（OpenClawPluginApi）需提供的接口

插件初始化时实际依赖：

| api 成员 | 用途 |
|---|---|
| `api.pluginConfig` | 插件原始配置对象（传给 `parsePluginConfig`） |
| `api.resolvePath(path)` | 解析路径（含 env 变量解析） |
| `api.logger` | `.info / .warn / .debug`（可选链 `?.`） |
| `api.config` | 运行时总配置（`api.config.agents.list` 多 agent 映射） |
| `api.registerTool(...)` | 注册单个工具（tools.ts 内 13 处调用） |
| `api.registerCli(...)` | 注册 CLI 命令树 |
| `api.on(event, handler)` | 订阅生命周期事件 |
| `api.registerHook(event, handler, opts)` | 注册带元数据的钩子（command:new / command:reset / agent:bootstrap） |
| `api.registerService({id, start, stop})` | 注册后台服务 |

类型来源：`import type { OpenClawPluginApi } from "openclaw/plugin-sdk"`。

### 2.3 生命周期事件（插件订阅，宿主需 emit）

> **关键修正**：`memory-lancedb-pro` 本身**不调用 `api.emit(...)`**。它是被动订阅者。所谓"emit `gateway_start` 触发副作用"是 `memory-lancedb-mcp` 那一层的封装行为（FakeOpenClawApi 自行 emit）。两层须区分。

插件订阅的事件：
- `api.on("message_received", ...)` — 自动捕获用户消息
- `api.on("before_message_write", ...)` — 写入日志
- `api.on("before_prompt_build", ...)` — 回合计数 + 自适应检索门控 + 自动 recall 注入
- `api.on("agent_end", agentEndAutoCaptureHook)` — 会话结束自动捕获
- `api.on("after_tool_call", ...)` — 反思/抽取副作用
- `api.on("session_end", ...)` — 会话结束处理
- `api.registerHook("command:new" | "command:reset" | "agent:bootstrap", ...)` — 反思/压缩/自我改进笔记

后台副作用（压缩自检等）由 `api.registerService` 的 `start()` 内 `setTimeout`/`setInterval` 触发，不阻塞网关启动。

**对 KiSearch 重构的含义**：通过 `memory-lancedb-mcp` 的 `createMemoryRuntime()` → `callTool()` 调用时，emit 由 mcp 壳子负责；KiSearch 只需关心 `callTool` 输入/输出，无需自行 emit 生命周期事件（除非要复用自动捕获/自动召回）。

### 2.4 工具注册清单（registerAllMemoryTools）

| 工具 | 注册条件 |
|---|---|
| `memory_store` / `memory_recall` / `memory_forget` / `memory_update` | 始终启用（核心工具） |
| `memory_stats` / `memory_list` / `memory_promote` / `memory_archive` / `memory_compact` / `memory_explain_rank` | `enableManagementTools: true` 时启用 |
| `self_improvement_log` | `enableSelfImprovementTools !== false` 时启用 |
| `self_improvement_extract_skill` / `self_improvement_review` | 管理工具开启时再加 |

---

## 3. 工具接口详表

> 以下 name 即为 `callTool(name, params, ctx)` 的第一个参数。返回值重点关注 `details` 字段（结构化，KiSearch 可直接消费，无需解析 stdout）。

### 3.1 memory_store
- **说明**：将信息存入长期记忆。
- **参数**：
  - `text` (string, 必填): 要记住的信息
  - `importance` (number, 可选, 默认 0.7, 0–1): 重要性
  - `category` (enum, 可选, 默认 `"other"`): 工具层 schema 固定为 `stringEnum(MEMORY_CATEGORIES)` = `profile | preferences | entities | events | cases | patterns`（6 类）；`"other"` 是 store 默认值但不在枚举内。底层 `store()` 接受任意字符串，不强制归一化
  - `scope` (string, 可选, 默认 agent scope): 作用域
- **返回 `details`**：`{ action: "created", id, scope, category, importance }`（重复/噪声时为对应 action；失败 `error:"store_failed"`）
- **handler 关键点**：噪声过滤 → `embedder.embedPassage()` 向量化 → 重复预检（相似度 >0.98 视为重复）→ `store.store()` 写入。

### 3.2 memory_recall
- **说明**：混合检索（向量+关键词）搜索长期记忆。
- **参数**：
  - `query` (string, 必填)
  - `limit` (number, 可选, 默认 3, 软上限 6 / 全文上限 20)
  - `includeFullText` (boolean, 可选, 默认 false)
  - `maxCharsPerItem` (number, 可选, 默认 180, 60–1000)
  - `scope` (string, 可选): 检索范围
  - `category` (enum, 可选): 类别过滤，工具层固定 6 类（`profile/preferences/entities/events/cases/patterns`）；检索时按 `entry.category === category` **精确匹配**（不归一化，大小写敏感）
- **返回 `details`**：`{ count, memories: [...], query, scopes, retrievalMode }`（`memories` 已 sanitize；空 `count:0`；失败 `error:"recall_failed"`）
- **handler 关键点**：解析 scope 过滤 → `retrieveWithRetry()` → 更新访问元数据 → 序列化输出。
- **类型（category）过滤与自定义**：
  - **支持过滤**：`memory_recall` 与 `memory_list` 均支持 `category` 过滤，底层为 `entry.category === category` 精确字符串匹配（store.list 用 SQL `category = '...'`）。
  - **标准路径不能自定义**：`category` 在工具 schema 层为 `stringEnum(MEMORY_CATEGORIES)`，只允许 6 个固定值 `profile/preferences/entities/events/cases/patterns`，传入其他值会被参数校验拒绝。
  - **底层可任意**：`MemoryStore.store()` 的 `category` 字段接受任意字符串（`category as any`），若绕过工具层直写自定义值，用相同字符串 recall/list 仍能精确匹配——但此路径绕过 schema 校验，且代码内部存在两套不一致的 category 定义（工具层 6 类 vs `MemoryEntry` 类型标注的 `preference/fact/decision/entity/other/reflection`），不推荐依赖。
  - **对 KiSearch 的启示**：三层标签 `ki-search/ki-path/ki-relation` 应继续走"文本前缀 + scope"方案（已在 mcp 验证），**不要**依赖自定义 category，因为工具层 enum 不允许。

### 3.3 memory_list
- **说明**：列出近期记忆，可按 scope/category 过滤。
- **参数**：
  - `limit` (number, 可选, 默认 10, 1–50)
  - `scope` (string, 可选)
  - `category` (enum, 可选)
  - `offset` (number, 可选, 默认 0, 0–1000)
- **返回 `details`**：`{ count, memories: [{id, text, category, rawCategory, scope, importance, timestamp}], filters: {...} }`

### 3.4 memory_forget
- **说明**：删除记忆，支持按 ID 或按搜索删除。
- **参数**：
  - `query` (string, 可选): 搜索定位
  - `memoryId` (string, 可选): 指定 ID 删除
  - `scope` (string, 可选)
- **返回 `details`**：`{ action: "deleted", id }`（未找到 `error:"not_found"`；候选时 `action:"candidates", candidates`；缺参 `error:"missing_param"`）

### 3.5 memory_update
- **说明**：更新记忆。改文本对 preference/entity 等触发 supersede 新版本（保留历史）；仅改元数据原地更新。
- **参数**：
  - `memoryId` (string, 必填, 完整 UUID 或 8+ 字符前缀)
  - `text` (string, 可选): 触发重新向量化
  - `importance` (number, 可选, 0–1)
  - `category` (enum, 可选)
- **返回 `details`**：`{ action: "updated", id, scope, category, importance, fieldsUpdated }`（supersede 时 `action:"superseded", oldId, newId`；失败 `error:"update_failed"`）

### 3.6 memory_stats
- **说明**：记忆统计（总数/scope/category 计数）。
- **参数**：`scope` (string, 可选)
- **返回 `details`**：`{ stats: {totalCount, scopeCounts, categoryCounts}, scopeManagerStats, retrievalConfig, hasFtsSupport }`

### 3.7 memory_promote
- **说明**：提升记忆治理状态（confirmed/durable 等）。
- **参数**：`memoryId` (可选) / `query` (可选) 二选一、`scope` (可选)、`state` (默认 `"confirmed"`)、`layer` (默认 `"durable"`)
- **返回 `details`**：`{ action: "promoted", id, state, layer }`

### 3.8 memory_archive
- **说明**：归档记忆（移除默认召回但保留历史）。
- **参数**：`memoryId` / `query` 二选一、`scope`、`reason` (默认 `"manual_archive"`)
- **返回 `details`**：`{ action: "archived", id, reason }`

### 3.9 memory_compact
- **说明**：压缩重复低价值记忆。
- **参数**：`scope` (可选)、`dryRun` (默认 true)、`limit` (默认 200, 20–1000)
- **返回 `details`**：`{ action: "compact_preview"|"compact_applied", scanned, duplicates, archived, sample }`

### 3.10 memory_explain_rank
- **说明**：解释召回排序原因（含治理元数据/子分数）。
- **参数**：`query` (必填)、`limit` (默认 5, 1–20)、`scope` (可选)
- **返回 `details`**：`{ action: "explain_rank", query, count, results }`

### 3.11 self_improvement_* （独立治理线）
- `self_improvement_log(type, summary, details?, suggestedAction?, category?, area?, priority?)` → `details: {action:"logged", id, filePath}`。写入 `.learnings/LEARNINGS.md` 或 `ERRORS.md`。
- `self_improvement_extract_skill(learningId, skillName, sourceFile?, outputDir?)` → `details: {action:"skill_extracted", skillPath}`。
- `self_improvement_review()` → `details: {action:"review", stats:{pending,high,promoted,total}}`。

---

## 4. 核心引擎接口（进程内直接调用）

> 若 KiSearch 未来要绕过 mcp 壳子直用底层，以下是关键签名。当前重构（REQ-20260716-001）走 `memory-lancedb-mcp` 的 `createMemoryRuntime`，本节供参考与排障。

### 4.1 MemoryStore（store.ts）
- `store(entry: Omit<MemoryEntry,"id"|"timestamp">): Promise<MemoryEntry>`
  - `entry`：`{ text, vector:number[], category:string, scope, importance, metadata?:string(JSON字符串) }`。注：`store.ts` 类型标注 `MemoryEntry.category` 为旧 6 类（`preference/fact/decision/entity/other/reflection`），但工具层 schema 实际约束为 `MEMORY_CATEGORIES`（`profile/preferences/entities/events/cases/patterns`），两套不一致；`store()` 运行时接受任意字符串（`category as any`），不做归一化，过滤侧同样按字符串精确匹配。
  - **⚠️ `store()` 不自动 embedding**：`vector` 必须由调用方预先算好传入。
  - id 由内部 `randomUUID()` 生成，`store()` 直接返回完整 `fullEntry`（含 `id`）。
  - 单条写入，无内置批量；批量需调用方外循环。
- 其他方法：`getById(id, scopeFilter?)`、`vectorSearch(vector, limit, minScore, scopeFilter?)`、`bm25Search(query, limit, scopeFilter?)`、`list(scopeFilter?, category?, limit, offset)`、`delete(id, scopeFilter?)`、`update(id, updates, scopeFilter?)`、`bulkDelete(scopeFilter, beforeTimestamp?)`。
- **scope 默认回退**：`store()` 本身不回退，直接用传入 `scope`；读取路径中 `scope` 为 null 时按 `"global"` 回退。

### 4.2 MemoryRetriever（retriever.ts）
- `createRetriever(store: MemoryStore, embedder: Embedder, config?: Partial<RetrievalConfig>, options?: {decayEngine?}): MemoryRetriever`
- `retrieve(context: RetrievalContext): Promise<RetrievalResult[]>`
  - `RetrievalContext`: `{ query, limit(1–20), scopeFilter?:string[], category?, source?: "manual"|"auto-recall"|"cli" }`
  - 检索时引擎**内部自动** `embedder.embedQuery()`，调用方无需传向量。
- `RetrievalResult`：`{ entry: MemoryEntry(含id/text/score/scope/tags/metadata/createdAt), score, sources:{vector?,bm25?,fused?,reranked?} }`
- **混合检索逻辑**：
  1. `embedder.embedQuery()` 生成查询向量
  2. 并行：`vectorSearch`(cosine) + `bm25Search`(LanceDB FTS，sigmoid 归一化)
  3. RRF 融合：`fusedScore = vector*vectorWeight + bm25*bm25Weight`
  4. **0.75 阈值语义**：BM25 分 ≥0.75 时 `fusedScore = max(weightedFusion, bm25*0.92)`，保留精确关键词命中（API Key/工单号等）
  5. `minScore` 过滤（默认 0.3）
  6. Cross-encoder rerank：`blendedScore = 0.6*rerank + 0.4*fused`（失败回退 cosine 兜底）
  7. 后处理：recency boost → importance → length norm → hardMinScore(0.35) → time decay → noise filter → MMR 多样性去重 → 截断 limit
- **标签前缀路由**：query 命中 `tagPrefixes`（默认 `proj/env/team/scope`）时切换为 BM25-only + mustContain，**标签前缀不剥离**，仅作检索路由。

### 4.3 ScopeManager（scopes.ts）
- 内置 scope 模式：`global` / `agent:<agentId>` / `custom:<name>` / `project:<projectId>` / `user:<userId>` / `reflection:agent:<agentId>`
- **隔离**：存储层所有读写接受 `scopeFilter?: string[]`，SQL `where scope='X' OR scope IS NULL` + 应用层二次校验，物理隔离不串扰。
- **agentId bypass**：`SYSTEM_BYPASS_IDS = {"system","undefined"}`。`getScopeFilter(agentId)`：
  - 返回 `undefined` → 全 bypass（仅 system/undefined）
  - 返回 `[]` → 显式 deny-all
  - 返回 `["global",...]` → 仅限这些 scope
- `isAccessible(scope, agentId)` / `getDefaultScope(agentId)`（bypass id 禁止调用，要求显式 scope）
- **对 KiSearch 的含义**：store/recall 统一传 `agentId:"system"` 即可全 bypass 读写（这正是 `memory-lancedb-mcp` cli 的做法），scope 由参数显式指定（默认 `global`）。

### 4.4 Embedder（embedder.ts）
- `createEmbedder(config: EmbeddingConfig): Embedder`
- `EmbeddingConfig`：`provider: "openai-compatible"|"azure-openai"`、`apiKey: string|string[]`（多 key 轮询容错）、`model`、`baseURL?`、`dimensions?`、`apiVersion?`、`taskQuery?`、`taskPassage?`、`normalized?`、`chunking?(默认true)`
- 支持 OpenAI 兼容 / Azure / Jina / Voyage / 本地 Ollama（`http://127.0.0.1:11434/v1` 视为 openai-compatible）
- 对外 API：`embedQuery(text)` / `embedPassage(text)` / `embedBatchQuery(texts)` / `embedBatchPassage(texts)`（含 LRU 缓存、10s 超时、超长自动 chunk 切片取平均）
- **维度来源**：优先 `config.dimensions` 覆写，否则查内置表（text-embedding-3-small=1536 等）；未知模型必须显式配 `dimensions`。

---

## 5. 配置 Schema（JSON 结构）

> 来自 `PluginConfig` 接口 + `parsePluginConfig` 校验。

- 配置为空/数组 → 抛 `"memory-lancedb-pro config required"`
- `embedding` 缺失 → 抛 `"embedding config is required"`
- `embedding.apiKey`：支持 string/string[]；缺失回退 `process.env.OPENAI_API_KEY`；仍空 → 抛 `"embedding.apiKey is required..."`
- 支持 `${ENV_VAR}` 内联展开
- 默认值：`autoCapture=true`、`autoRecall=false`、`smartExtraction=true`、`extractMinMessages=4`、`extractMaxChars=8000`、embedding model 默认 `text-embedding-3-small`

**最小可用配置（KiSearch 重构可直接参照）**：
```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small",
    "baseURL": "https://api.openai.com/v1",
    "dimensions": 1536
  },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": false,
  "autoRecall": false,
  "smartExtraction": false,
  "enableManagementTools": true,
  "scopes": { "default": "global" }
}
```

**完整配置示例**（便于排查，实际由 `parsePluginConfig` 合并 DEFAULT 常量，非全部必填）：
```json
{
  "embedding": { "provider": "openai-compatible", "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small", "baseURL": "https://api.openai.com/v1", "dimensions": 1536, "taskQuery": "retrieval_query", "taskPassage": "retrieval_passage", "normalized": false, "chunking": false },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": true, "captureAssistant": false, "autoRecall": false,
  "autoRecallMinRepeated": 8, "autoRecallMaxItems": 3, "autoRecallMaxChars": 600, "autoRecallPerItemMaxChars": 180,
  "retrieval": { "mode": "hybrid", "vectorWeight": 0.5, "bm25Weight": 0.5, "minScore": 0.0, "rerank": "lightweight", "rerankProvider": "jina", "rerankApiKey": "${RERANK_KEY}", "rerankModel": "jina-reranker-v2", "candidatePoolSize": 50, "recencyHalfLifeDays": 30, "recencyWeight": 0.1, "filterNoise": true, "lengthNormAnchor": 200, "hardMinScore": 0.0, "timeDecayHalfLifeDays": 30, "reinforcementFactor": 1.0, "maxHalfLifeMultiplier": 4.0 },
  "decay": { "recencyHalfLifeDays": 30, "recencyWeight": 0.4, "frequencyWeight": 0.3, "intrinsicWeight": 0.3, "staleThreshold": 90, "searchBoostMin": 0.1, "importanceModulation": 1.0, "betaCore": 0.02, "betaWorking": 0.1, "betaPeripheral": 0.3, "coreDecayFloor": 0.6, "workingDecayFloor": 0.3, "peripheralDecayFloor": 0.1 },
  "tier": { "coreAccessThreshold": 5, "coreCompositeThreshold": 0.8, "coreImportanceThreshold": 0.7, "peripheralCompositeThreshold": 0.3, "peripheralAgeDays": 60, "workingAccessThreshold": 2, "workingCompositeThreshold": 0.5 },
  "smartExtraction": true,
  "llm": { "auth": "api-key", "apiKey": "${OPENAI_API_KEY}", "model": "openai/gpt-oss-120b", "baseURL": "", "oauthProvider": "", "oauthPath": ".memory-lancedb-pro/oauth.json", "timeoutMs": 30000 },
  "extractMinMessages": 4, "extractMaxChars": 8000,
  "scopes": { "default": "main", "definitions": { "main": { "description": "Default scope" } }, "agentAccess": {} },
  "enableManagementTools": false,
  "sessionStrategy": "memoryReflection",
  "sessionMemory": { "enabled": false, "messageCount": 50 },
  "selfImprovement": { "enabled": false, "beforeResetNote": true, "skipSubagentBootstrap": false, "ensureLearningFiles": true },
  "memoryReflection": { "enabled": true, "storeToLanceDB": true, "writeLegacyCombined": true, "injectMode": "inheritance+derived", "agentId": "main", "messageCount": 50, "maxInputChars": 20000, "timeoutMs": 120000, "thinkLevel": "medium", "errorReminderMaxEntries": 5, "dedupeErrorSignals": true },
  "mdMirror": { "enabled": false, "dir": "memory-md" },
  "workspaceBoundary": { "userMdExclusive": { "enabled": false, "routeProfile": true, "routeCanonicalName": true, "routeCanonicalAddressing": true } },
  "admissionControl": { }
}
```
> `sessionStrategy` ∈ `"memoryReflection"|"systemSessionMemory"|"none"`；`rerank` ∈ `"cross-encoder"|"lightweight"|"none"`；`rerankProvider` ∈ `jina/siliconflow/voyage/pinecone/dashscope/tei`。

---

## 6. 模块地图（src 目录职责）

**存储 / 检索 / 向量**
- `store.ts` — LanceDB 封装：增删改查、schema、迁移入口、路径校验
- `embedder.ts` — OpenAI 兼容 embedding 客户端（多 key 轮询、维度探测）
- `retriever.ts` — 混合检索（向量+BM25）、rerank、衰减打分、自适应过滤
- `migrate.ts` — legacy 记忆向 smart 格式迁移

**范围 / 边界**
- `scopes.ts` — 多 scope 隔离管理、system bypass
- `workspace-boundary.ts` — workspace 边界与 user-md 独占召回路由
- `clawteam-scope.ts` — ClawTeam 环境变量扩展 scope
- `identity-addressing.ts` — 身份寻址（canonical name/address）

**智能抽取 / LLM**
- `smart-extractor.ts` — LLM 智能抽取（含噪声过滤）
- `llm-client.ts` / `llm-oauth.ts` — LLM 调用客户端 / OAuth 鉴权
- `extraction-prompts.ts` — 抽取提示词模板
- `noise-filter.ts` / `noise-prototypes.ts` — 噪声判定与原型库

**生命周期 / 衰减 / 分层**
- `decay-engine.ts` — Weibull/半衰期衰减打分
- `tier-manager.ts` — 记忆分层（core/working/peripheral）
- `smart-metadata.ts` — 智能元数据构建/解析/序列化
- `memory-upgrader.ts` — legacy 记忆升级
- `session-recovery.ts` — 会话恢复/搜索目录解析
- `adaptive-retrieval.ts` — 自适应检索门控

**反思 / 自我改进**
- `reflection-*.ts`（store/slices/event-store/item-store/metadata/mapped-metadata/ranking/retry）— 反思日志体系
- `self-improvement-files.ts` — 自我改进学习文件管理

**治理 / 准入 / 统计**
- `admission-control.ts` / `admission-stats.ts` — 准入控制与审计
- `access-tracker.ts` — 访问频率追踪
- `memory-categories.ts` — 类别枚举
- `preference-slots.ts` — 偏好槽位
- `tools.ts` — 工具注册聚合（`registerAllMemoryTools`）
- `chunker.ts` — 文档分块

---

## 7. 对 KiSearch 重构（REQ-20260716-001）的关键启示

1. **壳子路径正确**：直接依赖 `memory-lancedb-mcp` 的 `createMemoryRuntime()` → `callTool("memory_store"|"memory_recall"|"memory_list"|"memory_forget"|"memory_update"|...)`，绕开全局 `mem` CLI。
2. **结构化返回值**：所有工具返回 `details`（如 `details.id` / `details.memories` / `details.count`），KiSearch 应**直接消费 `details`**，删除现有的 `Memory ID` 正则、bulk `ok/errors/skipped`、search 双格式兼容等 stdout 解析。
3. **scope 语义**：统一传 `agentId:"system"` 全 bypass，scope 由参数显式指定（默认 `global`）；三层标签 `ki-search/ki-path/ki-relation` 可映射为 scope 或 `【标签:...】` 文本前缀（mcp 已验证此方案）。
4. **vector 由谁生成**：通过 `callTool` 路径时，embedding 由插件内部 `embedder` 处理（store 工具内自动 `embedPassage`）；KiSearch 只需在配置里提供 `embedding.apiKey`/`model`/`baseURL`，**无需自己持有 Embedder 算向量**（与"Embedder 配置照搬 mem"决策一致）。
5. **emit 事件澄清**：`memory-lancedb-pro` 不 `emit`；KiSearch 通过 mcp 壳子调用时，生命周期副作用的触发由 mcp 封装负责，KiSearch 无需自行 emit `before_prompt_build`/`gateway_start` 等。
6. **配置必填项**：`embedding` 段必填；`apiKey` 缺失回退 `OPENAI_API_KEY` 仍缺失则清晰报错——KiSearch 配置加载失败时应复用此清晰报错风格。
7. **批量写入**：`memory_store` 是单条；批量需循环 `callTool("memory_store")`，保留 ok/errors/skipped 汇总逻辑。
