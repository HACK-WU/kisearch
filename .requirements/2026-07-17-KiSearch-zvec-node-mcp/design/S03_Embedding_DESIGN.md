# S-03 Embedding 提供方 · 设计

> 父文档：`ZVEC_ENGINE_DESIGN.md`
> 子需求编号：S-03
> 对应文件：`src/zvec-engine/embedding/{provider.ts, siliconflow.ts}`

---

## 1. 术语

| 术语 | 含义 | 引用 |
|---|---|---|
| `EmbeddingProvider` | 可注入的 embedding 抽象接口 | 本文件 §4a |
| `EmbedOptions` | embed 调用的可选参数（retries/batchSize/timeoutMs/onProgress） | 本文件 §4a |
| `SiliconFlowProvider` | `EmbeddingProvider` 的 SiliconFlow 参考实现（Qwen3-Embedding-8B，4096 维） | 本文件 §4a |
| 小批 | 按 `batchSize` 切分的嵌入最小单元，失败粒度 | 本文件 §3.2 |
| 主线程 embed | 方案 X：embedding 在主线程执行，向量经 Transferable 传 worker | 父文档 §4 R-02 |

---

## 2. 现状（AS-IS）

### 2.1 现状描述

v5 §4.6 已定义 `EmbeddingProvider` 接口（`dimension` + `embed(texts, opts): Promise<number[][]>`）与 `EmbedOptions`，并承诺"附 SiliconFlowProvider 参考实现"。但：
- **跨 worker 归属未决**：v5 §5 声称"embedding 在 worker 内闭环"，但可注入的 provider 实例（含函数）**无法 postMessage 到 worker**（v3 推演 #2）
- **失败粒度矛盾**：v5 §4.4 称"预计算 vector 不受 embed 失败影响"，§4.6 又称"小批同成败"，二者对混合小批中预计算 vector 文档的命运给出相反结论（v3 推演 #3）
- 未定义 SiliconFlow 的具体 HTTP 调用形态（URL/headers/重试退避）

### 2.2 痛点

- 若 embedding 进 worker，调用方无法注入 mock provider 做单测，也无法替换为本地模型
- 若 embedding 出 worker，4096 维向量跨线程传输曾被视为性能顾虑（已被 Transferable 证伪）
- 失败粒度若不统一，S-06 engine 无法实现 v5 §4.4 的 `EMBEDDING_FAILED` 承诺

---

## 3. 方案（TO-BE）

### 3.1 方案概述

**锁定方案 X**：`EmbeddingProvider.embed()` 在**主线程**执行；向量产出后由 S-06 engine 转成 `Float32Array` 经 `postMessage(..., [buffer])` Transferable 零拷贝传 S-04 worker；worker 完全不感知 `EmbeddingProvider`，只接受"已 embed 好的向量 + 原文 + fields"。

**统一失败粒度**：embed 失败以 `batchSize` 小批为最小单元，但 engine 在调 embed 前**先按"是否需 embed"切分**——预计算 `vector` 的 DocInput 不参与 embed，其写入不受 embed 失败影响。

### 3.2 关键决策点

| 决策 | 选择 | 理由 | 备选方案 | 否决原因 |
|---|---|---|---|---|
| embed 执行位置 | **主线程** | 保留任意 provider 注入能力；Transferable 已证 16KB/条零拷贝可忽略 | worker 内 | 函数对象不可 postMessage；牺牲注入灵活性 |
| 向量跨线程形式 | `Float32Array` + transfer list | 零拷贝 | `number[]` structuredClone | 4096×8B×N 条拷贝成本高 |
| 失败切分时机 | engine 调 embed **前**按"是否需 embed"切分 | 兑现"预计算 vector 不受影响"承诺 | embed 内部切分 | provider 不知道 DocInput 上下文 |
| 小批失败策略 | 小批内全部 `text` 文档标 `EMBEDDING_FAILED` | 小批为最小失败单元 | 单条失败区分 | OpenAI 兼容 API 整批返回，无法单条区分 |
| 重试退避 | 指数退避：`1s, 2s, 4s`（retries=3） | 对齐 SiliconFlow 抖动场景 | 固定间隔 | 抖动时长不确定 |
| 超时 | 单批 30s（默认） | v5 §4.6 定义 | 60s | 30s 已覆盖 4096 维 100 条批 |
| HTTP 客户端 | 全局 `fetch`（Node ≥18 原生） | 无额外依赖 | axios/node-fetch | 引入依赖 |
| `baseURL` 默认值 | `https://api.siliconflow.cn/v1` | 与基准对齐 | `https://api.openai.com/v1` | KiSearch 主用 SiliconFlow |
| `model` 默认值 | `Qwen/Qwen3-Embedding-8B` | 与基准 4096 维对齐 | `text-embedding-3-small` | 维度 1536 不符 |
| `dimension` 字段 | 必填，构造时校验 `>0` | 与 ZvecEngineConfig 校验对齐 | 可选，首次 embed 后回填 | 无法在 create 前校验 |

### 3.3 请求/响应结构

**请求**（OpenAI 兼容）：
```http
POST {baseURL}/embeddings
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "Qwen/Qwen3-Embedding-8B",
  "input": ["text1", "text2", ...]   // 小批 ≤ batchSize
  // 注：不传 `dimensions` 字段——并非所有 OpenAI 兼容 provider 都支持该参数；
  // 维度一致性完全由响应 embedding.length 校验保证（见下）
}
```

**响应**：
```json
{
  "data": [
    { "index": 0, "embedding": [0.1, 0.2, ...] },
    { "index": 1, "embedding": [...] }
  ]
}
```

**校验（维度一致性唯一来源）**：
- `data.length === input.length`，不符抛 `EmbeddingError`（小批整体失败）
- 每条 `embedding.length === this.dimension`（构造时声明的 4096），不符抛 `EmbeddingError`
- 若 provider 不支持 `dimensions` 参数而我们却传了，可能被静默忽略（返回模型默认维度）→ 触发上一条校验失败，错误信息清晰指向根因；**故 v1 不传 `dimensions`**（🟡8 修复）

### 3.4 重试触发条件

| 错误类型 | 是否重试 |
|---|---|
| 网络错误（fetch reject / ECONNRESET / ETIMEDOUT） | ✅ |
| HTTP 5xx | ✅ |
| HTTP 429（限流） | ✅（Retry-After 优先） |
| HTTP 4xx（除 429） | ❌（参数错误，重试无意义） |
| 响应结构不符 | ❌ |

---

## 4. 接口设计

### 4a.1 对外接口

```typescript
// embedding/provider.ts
export interface EmbeddingProvider {
  readonly dimension: number;
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

export interface EmbedOptions {
  retries?: number;                       // 默认 3
  batchSize?: number;                     // 默认 64
  timeoutMs?: number;                     // 默认 30000
  onProgress?: (done: number, total: number) => void;
}

// embedding/siliconflow.ts
export interface SiliconFlowProviderConfig {
  /** 可选；缺省从 `process.env.SILICONFLOW_API_KEY` 读；二者都无则构造时抛 `EmbeddingConfigError` */
  apiKey?: string;
  baseURL?: string;                       // 默认 https://api.siliconflow.cn/v1
  model?: string;                         // 默认 Qwen/Qwen3-Embedding-8B
  dimension?: number;                     // 默认 4096
  fetchImpl?: typeof fetch;               // 单测可注入 mock fetch
}

export class SiliconFlowProvider implements EmbeddingProvider {
  readonly dimension: number;
  constructor(config: SiliconFlowProviderConfig);
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}
```

| 接口 | 输入 | 输出 | 异常 |
|---|---|---|---|
| `EmbeddingProvider.embed` | texts + opts | vectors | `EmbeddingError`（小批失败） |
| `SiliconFlowProvider.constructor` | config | 实例 | `EmbeddingConfigError`（apiKey 缺失/dimension ≤0） |

### 4a.2 内部协作接口

- **S-06 engine.upsert(docs)**：
  1. 按 `docs` 分两组：`needsEmbed = docs.filter(d => d.text !== undefined && d.vector === undefined)`、`noEmbed = docs.filter(d => d.vector !== undefined)`
  2. `needsEmbed` 按 `batchSize` 切小批，逐批 `provider.embed(batch)`
  3. 小批失败 → 该批 doc 进 `WriteResult.errors[]`（`EMBEDDING_FAILED`）；`noEmbed` 组**不受影响**，直接进入下一步
  4. embed 成功的 doc + `noEmbed` 组合并 → 转 `Float32Array` → 经 S-04 proxy 发 upsert 消息

### 4a.3 契约变更声明

| 变更类型 | 接口 | 变更内容 | 影响的子需求 |
|---|---|---|---|
| 新增 | `EmbeddingProvider` | 主线程 embed 抽象 | S-06 |
| 新增 | `SiliconFlowProvider` | 参考实现 | S-06 |
| 修改（对 v5 §5 措辞） | "embedding 在 worker 内闭环" → "embedding 在主线程，向量经 Transferable 进 worker" | 方案 X 锁定 | S-04, S-06 |

---

## 5. 异常处理

| 场景 | 行为 | 是否对外暴露 |
|---|---|---|
| `apiKey` 缺失且 env 也无 | 构造时抛 `EmbeddingConfigError` | 是 |
| `dimension ≤ 0` | 构造时抛 `EmbeddingConfigError` | 是 |
| 小批 HTTP 4xx（非 429） | 不重试，该小批标 `EMBEDDING_FAILED`，附状态码 | 是（经 WriteResult） |
| 小批 HTTP 5xx/429/网络错 | 指数退避重试，耗尽后该小批标 `EMBEDDING_FAILED` | 是（经 WriteResult） |
| 响应 `data.length !== input.length` | 不重试，该小批标 `EMBEDDING_FAILED` | 是 |
| 响应向量维度 ≠ `dimension` | 不重试，该小批标 `EMBEDDING_FAILED` | 是 |
| `texts` 为空数组 | 立即返回 `[]`，不调 HTTP | 否 |

---

## 6. 性能 & 安全

### 性能

- 预期量级：单批 64 条 × 4096 维，HTTP RTT 约 300~800ms（SiliconFlow）
- 关键瓶颈：SiliconFlow 网络；批间**串行**（避免触发限流），不并发
- 不做的优化：批间并发（429 风险）、向量压缩（Transferable 已零拷贝）

### 安全

- `apiKey` 仅经 HTTPS 头部传输，不写日志
- `baseURL` 校验必须是 `https://` 开头（防 SSRF 降级到 http）
- `onProgress` 回调异常不传播（catch 后静默）

---

## 7. 测试方案

| 类型 | 范围 | 工具 |
|---|---|---|
| 单元测试 | mock fetch 正常路径 | node:test |
| 单元测试 | 429 重试 + Retry-After 解析 | node:test |
| 单元测试 | 5xx 重试 3 次后失败 | node:test |
| 单元测试 | 4xx（非 429）不重试 | node:test |
| 单元测试 | 响应结构不符 / 维度不符 | node:test |
| 单元测试 | 空 texts 立即返回 | node:test |
| 单元测试 | 缺 apiKey / 非法 dimension 构造失败 | node:test |

不在测试范围内：
- 真实 SiliconFlow HTTP 调用（属集成测试，实现后手动跑）

---

## 8. 待定问题

无。
