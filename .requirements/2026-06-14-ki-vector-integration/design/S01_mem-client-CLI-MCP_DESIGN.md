# S-01 mem-client 共享模块 + search/store/bulk_store CLI + MCP 工具

> 状态：草案
> 依赖：无（第一期）

## 术语

| 术语 | 定义 |
|------|------|
| mem-client | 本模块：封装 mem CLI 调用的共享层，提供 PATH 注入、stdout 清洗、JSON 解析、超时控制 |
| thin wrapper | ki 仅做接口聚合和协议适配，不持有向量状态 |
| ki-search tag | `ki-search` 命令使用的 mem tags，与现有 `ki-path`/`ki-relation` 物理隔离 |

## 现状（AS-IS）

**现有 mem 调用分散在两处**：

1. `scripts/lib/path-vectorize.ts` — 直接使用 `execFileSync('mem', ...)` 调用 `mem store` / `mem bulk-store` / `mem search` / `mem delete`。内含 PATH 注入逻辑、stdout 解析、Memory ID 提取。
2. `scripts/scan-kb.ts` — import 流程中直接调用 `mem store` 做向量化。

**问题**：
- mem CLI 调用逻辑重复（PATH 注入、stdout 清洗）在多处实现
- 没有统一的 `mem search` 封装（path-vectorize 中的 search 是为 ki-path/ki-relation 兜底服务的，不是通用语义搜索）
- 没有面向用户的 `ki search` / `ki store` / `ki bulk_store` 命令

**关键文件**：
- `scripts/lib/path-vectorize.ts`（第 128-174 行：bulk-store 调用，第 190-226 行：单条 store）
- `bin/ki.mjs`（命令路由表，需新增 search/store/bulk_store 入口）
- `scripts/mcp-server.ts`（MCP 工具注册入口，需新增 3 个工具）
- `scripts/lib/mcp-tools/`（MCP 工具实现目录，需新增 3 个文件）

## 方案（TO-BE）

### 3.1 新增 `scripts/lib/mem-client.ts` — mem CLI 调用统一封装

从 `path-vectorize.ts` 中提取 mem CLI 调用模式，抽象为通用模块。

**核心职责**：
- PATH 环境变量显式注入（解决 spawnSync ENOENT 问题）
- stdout 前导日志清洗（`[mem:info]` 等前缀 → 提取纯 JSON）
- JSON 解析防御（trim + 校验首字符 `{`/[`）
- 超时控制（默认 30s，可按调用类型调整）
- 错误归一化（ENOENT / timeout / JSON parse error → 统一错误结构）

**导出接口签名**（返回值类型详见 §数据模型）：

```typescript
function memSearch(params: {
  scope: string;
  query: string;
  limit?: number;        // 默认 10
  tags?: string;         // 可选 tag 过滤
  threshold?: number;    // 可选相似度阈值
}): MemSearchResult[];

function memStore(params: {
  scope: string;
  text: string;
  tags?: string;
  keywords?: string[];
  category?: string;     // 默认 'other'
  importance?: number;   // 默认 0.5
}): MemStoreResult;

function memBulkStore(params: {
  scope: string;
  entries: { text: string; tags?: string; keywords?: string[] }[];
}): MemBulkStoreResult;

function checkMemAvailable(): { available: boolean; reason?: string };
```

**实现要点**：
- PATH 注入：读取 `process.env.PATH`，追加 `~/.nvm/versions/node/*/bin`、`/usr/local/bin` 等常见路径
- stdout 清洗：从输出末尾反向查找最后一个 JSON 对象（复用 `path-vectorize.ts` 的 `parseBulkStoreJson` 策略）
- 所有方法同步执行（spawnSync），与现有 ki 脚本执行模型一致

### 3.2 新增 `scripts/search.ts` — ki search CLI

```bash
ki search --scope <scope> --query "自然语言查询" [--limit 10] [--threshold 0.0]
```

**参数**：

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--scope` | 是 | — | 项目隔离标识 |
| `--query` | 是 | — | 自然语言查询文本 |
| `--limit` | 否 | 10 | 返回条数上限 |
| `--threshold` | 否 | 0.0 | 相似度阈值（0-1） |

**输出**（JSON）：

```json
{
  "ok": true,
  "results": [
    {
      "memoryId": "xxx",
      "content": "知识内容...",
      "score": 0.92,
      "tags": ["ki-search"]
    }
  ]
}
```

**降级行为**：mem 不可用时返回 `{ ok: false, error: "向量检索暂不可用", degraded: true }`

**导出纯函数**（供 MCP 和其他模块调用）：

```typescript
export function executeSearch(params: {
  scope: string; query: string; limit?: number; threshold?: number;
}): { ok: true; results: MemSearchResult[] } | { ok: false; error: string; degraded?: boolean };
```

### 3.3 新增 `scripts/store.ts` — ki store CLI

```bash
ki store --scope <scope> --text "存储内容" [--keywords "词1,词2"] [--tags "tag1,tag2"]
```

**参数**：

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--scope` | 是 | — | 项目隔离标识 |
| `--text` | 是 | — | 待向量化文本 |
| `--keywords` | 否 | — | 逗号分隔关键词 |
| `--tags` | 否 | `ki-search` | 逗号分隔 tags |

**输出**：`{ ok: true, memoryId: "xxx" }` 或 `{ ok: false, error: "..." }`

**导出纯函数**：

```typescript
export function executeStore(params: {
  scope: string; text: string; keywords?: string[]; tags?: string;
}): { ok: true; memoryId: string } | { ok: false; error: string };
```

### 3.4 新增 `scripts/bulk-store.ts` — ki bulk_store CLI

```bash
ki bulk_store --scope <scope> --input /path/to/batch.json
```

**batch.json 格式**：

```json
[
  { "text": "内容1", "keywords": "词1,词2", "tags": "ki-search" },
  { "text": "内容2", "keywords": "词3" }
]
```

**输出**：

```json
{
  "ok": true,
  "total": 2,
  "succeeded": 2,
  "failed": 0,
  "results": [
    { "index": 0, "memoryId": "xxx", "success": true },
    { "index": 1, "memoryId": "yyy", "success": true }
  ]
}
```

**失败处理**：单条失败不阻塞其余条目，在 results 中标记 `success: false` + `error`。

**导出纯函数**：

```typescript
export function executeBulkStore(params: {
  scope: string; inputFile: string;
}): { ok: true; total: number; succeeded: number; failed: number; results: BulkStoreItemResult[] }
  | { ok: false; error: string };
```

### 3.5 MCP 工具注册

新增 3 个 MCP 工具，文件位置：`scripts/lib/mcp-tools/`

**ki-search**（`scripts/lib/mcp-tools/search.ts`）：

```typescript
server.tool('ki_search', '语义检索知识库内容', {
  scope: z.string(),
  query: z.string(),
  limit: z.number().int().positive().optional().default(10),
  threshold: z.number().min(0).max(1).optional(),
}, handler);
```

**ki_store**（`scripts/lib/mcp-tools/store.ts`）：

```typescript
server.tool('ki_store', '存储文本到向量索引', {
  scope: z.string(),
  text: z.string(),
  keywords: z.string().optional(),   // 逗号分隔
  tags: z.string().optional().default('ki-search'),
}, handler);
```

**ki_bulk_store**（`scripts/lib/mcp-tools/bulk-store.ts`）：

```typescript
server.tool('ki_bulk_store', '批量存储文本到向量索引', {
  scope: z.string(),
  input: z.string(),   // JSON 文件路径
}, handler);
```

**安全约束**（延续现有 ki MCP 原则）：
- 零破坏性：不含 delete/force/overwrite
- scope 校验：复用 `validateScope()` 函数
- 输入长度限制：`text` 字段最大 50000 字符。超出时**拒绝并报错**（而非截断），由调用方自行控制文本长度。理由：硬截断会破坏语义完整性，不符合薄封装的透传原则

### 3.6 bin/ki.mjs 命令注册

在 `COMMANDS` 映射表中新增：

```javascript
'search': 'scripts/search.ts',
'store': 'scripts/store.ts',
'bulk_store': 'scripts/bulk-store.ts',
```

在 `--help` 输出中补充说明。

### 3.7 mcp-server.ts 注册

```typescript
import { registerSearchTool } from './lib/mcp-tools/search.js';
import { registerStoreTool } from './lib/mcp-tools/store.js';
import { registerBulkStoreTool } from './lib/mcp-tools/bulk-store.js';

// 在 startMcpServer() 中新增：
registerSearchTool(server);
registerStoreTool(server);
registerBulkStoreTool(server);
```

## 接口设计

### CLI 接口总览

| 命令 | 必填参数 | 可选参数 | 输出 |
|------|----------|----------|------|
| `ki search` | `--scope`, `--query` | `--limit`, `--threshold` | JSON: results 数组 |
| `ki store` | `--scope`, `--text` | `--keywords`, `--tags` | JSON: `{ok, memoryId}` |
| `ki bulk_store` | `--scope`, `--input` | — | JSON: 批量结果 |

### MCP 工具总览

| 工具 | 必填参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `ki_search` | scope, query | limit, threshold | `{ok, results}` |
| `ki_store` | scope, text | keywords, tags | `{ok, memoryId}` |
| `ki_bulk_store` | scope, input | — | `{ok, total, succeeded, failed, results}` |

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| mem CLI 不存在（ENOENT） | 返回 `{ok: false, error: "mem CLI 未安装", degraded: true}` | 是（降级提示） |
| mem CLI 超时（>30s） | 返回 `{ok: false, error: "向量服务超时"}` | 是 |
| mem stdout 非 JSON | 返回 `{ok: false, error: "mem 输出解析失败"}` | 是 |
| scope 未注册 | mem 返回 "Access denied" → 透传错误信息 | 是 |
| bulk_store 部分条目失败 | 继续处理，在 results 中标记 `success: false` | 否（正常返回） |
| text 超长（>50000字符） | 拒绝并返回错误 `{ok: false, error: "text 超过 50000 字符限制"}` | 是 |

## 数据模型

### mem-client 返回值类型

```typescript
// memSearch 返回
interface MemSearchResult {
  memoryId: string;      // mem 返回的唯一标识
  content: string;       // 向量化的原文内容
  score: number;         // 相似度 0-1
  tags?: string[];       // mem 中存储的 tags
  metadata?: Record<string, unknown>;  // 额外元数据
}

// memStore 返回
interface MemStoreResult {
  memoryId: string;      // 新创建的 memoryId
}

// memBulkStore 返回（与 CLI 输出结构一致，扁平 results 数组）
interface BulkStoreItemResult {
  index: number;         // 批次中的序号
  memoryId?: string;     // 成功时返回
  success: boolean;
  error?: string;        // 失败时的错误信息
}

interface MemBulkStoreResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkStoreItemResult[];
}
```

## 测试方案

- **单元测试**：mock `execFileSync`，验证 PATH 注入、stdout 清洗、JSON 解析、超时处理
- **集成测试**：需要 mem CLI 可用，端到端验证 search → store → search 闭环
- **降级测试**：移除 mem CLI 后验证优雅降级输出

## 风险 & 待定问题

| 问题 | 状态 | 备选方案 |
|------|------|----------|
| path-vectorize.ts 是否迁移到 mem-client？ | 已确定：短期不迁移 | 保留现有实现，mem-client 作为新模块独立存在。理由：迁移需回归测试全部现有向量链路，风险大于收益；远期在 path-vectorize 有变更需求时再统一 |
| mem CLI 的 `--json` 输出格式稳定性 | 需确认 | 如果 mem 升级改变输出格式，需适配 |
| MCP 工具 ki_bulk_store 的 input 参数是文件路径还是 JSON 内容 | 已确定：文件路径 | 与 CLI 行为一致 |
