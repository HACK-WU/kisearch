# S-05：多标签分区检索

> 覆盖 REQ-13（多标签默认检索 + 统一分区输出）。共享术语见父文档 §3.2。

## 1. 术语

| 术语 | 含义 | 引用 |
|------|------|------|
| partitions | 统一分区输出结构 `{ ok, partitions: Record<string, SearchResult[]> }` | 见父文档 §3.2 |
| 默认标签集 | 不传 `--tags` 时默认查询 `[ki-search, ki-path, ki-relation]` | — |
| 顶层调用 | `ki search` CLI 命令 / MCP search 工具，走分区封装 | — |
| 内部调用 | path-search / query-group 等内部模块，走底层 `vectorSearch` 获取扁平结果 | — |

## 2. 现状（AS-IS）

### 2.1 现状描述

`ki search --tags` 默认 `ki-search`（单值），输出 `{ ok: true, results: MemSearchResult[] }` 扁平数组。标签过滤靠 `content.includes('【标签:xxx】')` 客户端文本 hack（`mem-client.ts:170`）。内部调用（path-search 查 `ki-path`、query-group 查 `ki-path`）也是单标签扁平结果。

### 2.2 痛点

- 痛点 1：默认只查 `ki-search`，漏掉 `ki-path` 和 `ki-relation` 的结果
- 痛点 2：tag 过滤靠 content 文本 hack，性能差且不可靠
- 痛点 3：结果扁平数组无法区分 tag 来源，用户/Agent 看到的结果混在一起

## 3. 方案（TO-BE）

### 3.1 方案概述

`ki search` 不传 `--tags` 时默认查 `[ki-search, ki-path, ki-relation]`，传 `--tags` 时查指定标签。无论传不传，输出统一为 `partitions` 结构。分区封装仅在顶层 `ki search` / MCP search 工具应用，内部调用走底层 `vectorSearch` 获取扁平结果。

### 3.2 关键决策点

| 决策 | 选择 | 理由 | 备选方案 | 否决原因 |
|------|------|------|---------|---------|
| 输出结构 | 统一 partitions（传不传都分组） | 用户拍板；消费方不需判断结构类型 | 传了扁平/不传分组 | 消费方需判断两种结构，复杂 |
| 默认标签集 | `[ki-search, ki-path, ki-relation]` | 覆盖三层标签全貌 | 仅 `[ki-search]` | 漏掉 path 和 relation |
| 分区封装位置 | 仅顶层 search.ts / MCP search 工具 | 内部调用需扁平结果，不应封装 | 全部封装 | path-search/query-group 需提取单标签结果，封装后要拆包 |
| 多标签查询方式 | 逐标签并发查询（Promise.all） | 各标签独立 hybridSearch，结果天然隔离 | 单次查询 + 客户端分组 | zvec metadata 过滤是 OR 逻辑，单次查询返回混合结果需客户端再分组 |

### 3.3 行为差异对照表

| 场景 | AS-IS | TO-BE | 影响 |
|------|-------|-------|------|
| 不传 `--tags` | 查 `ki-search`，返回 `{ results: [] }` | 查 `[ki-search, ki-path, ki-relation]`，返回 `{ partitions: {} }` | 破坏性（结构变更） |
| 传 `--tags ki-search` | 查 `ki-search`，返回 `{ results: [] }` | 查 `ki-search`，返回 `{ partitions: { "ki-search": [] } }` | 破坏性（结构变更） |
| 内部调用（path-search） | `memSearch({ tags: 'ki-path' })` → 扁平 | `vectorSearch({ tags: 'ki-path' })` → 扁平 | 兼容（结构不变） |

## 4a. 接口设计

### 4a.1 对外接口

```typescript
// scripts/search.ts — 顶层 CLI search 命令

interface PartitionSearchResult {
  ok: true;
  partitions: Record<string, SearchResult[]>;  // key = tag
}

// 顶层 search 命令返回 partitions（无论 --tags 传不传）
async function search(params: {
  scope: string;
  query: string;
  limit?: number;
  tags?: string | string[];   // 不传 → 默认 [ki-search, ki-path, ki-relation]
}): Promise<PartitionSearchResult>;
```

```typescript
// scripts/lib/mcp-tools/search.ts — MCP search 工具

// MCP 工具 schema（输出统一 partitions）
{
  name: 'search',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'string', default: 'default' },
      limit: { type: 'number', default: 10 },
      tags: { type: 'array', items: { type: 'string' }, optional: true }
    }
  }
}
// 返回: { ok: true, partitions: { "ki-search": [...], "ki-path": [...], "ki-relation": [...] } }
```

### 4a.2 内部协作接口

```typescript
// 分区封装函数（仅顶层调用）
async function searchWithPartitions(params: {
  scope: string;
  query: string;
  limit?: number;
  tags?: string[];            // 已展开为数组，不传时用 DEFAULT_TAGS
}): Promise<PartitionSearchResult>;

const DEFAULT_TAGS = ['ki-search', 'ki-path', 'ki-relation'];

// 实现：逐标签并发 vectorSearch，结果按 tag 分组
async function searchWithPartitions(params) {
  const tags = params.tags ?? DEFAULT_TAGS;
  const results = await Promise.all(
    tags.map(tag => vectorSearch({ ...params, tags: tag }))
  );
  const partitions: Record<string, SearchResult[]> = {};
  tags.forEach((tag, i) => { partitions[tag] = results[i]; });
  return { ok: true, partitions };
}
```

```typescript
// 内部调用（path-search / query-group）— 不走分区封装
// 直接调用 vectorSearch，获取扁平 SearchResult[]
const results = await vectorSearch({ scope, query, tags: 'ki-path', limit: 5 });
// results: SearchResult[]（扁平，不封装）
```

### 4a.3 契约变更声明

| 变更类型 | 接口 | 变更内容 | 影响的子需求 |
|---------|------|---------|------------|
| 修改 | `search()` 返回类型 | `{ results: [] }` → `{ partitions: {} }` | S-06（MCP search 工具适配） |
| 新增 | `searchWithPartitions()` | 分区封装函数 | S-06 调用 |
| 不变 | `vectorSearch()` | 内部调用仍返回扁平 `SearchResult[]` | S-03 定义 |

## +6. 异常处理

| 场景 | 行为 | 对外暴露 |
|------|------|---------|
| 某标签查询失败（embedding 超时） | 该标签 partition 为空数组 `[]`，其他标签正常返回；stderr warn | 否（warn 日志） |
| 某标签 0 条结果 | partition 中该标签对应 `[]`（空数组，非省略 key） | 否（正常行为） |
| 传入不存在的标签（如 `--tags foo`） | 正常查询，返回 `{ partitions: { "foo": [] } }`（zvec 无匹配结果） | 否 |
| 所有标签均 0 条结果 | `{ ok: true, partitions: { "ki-search": [], "ki-path": [], "ki-relation": [] } }` | 否 |
| 内部调用 path-search 无结果 | 返回 `[]`，path-search 降级为精确匹配 | 否 |

## +10. 影响范围

| 影响对象 | 影响类型 | 影响描述 | 破坏性 |
|---------|---------|---------|:------:|
| `scripts/search.ts` | 接口变更 | 返回 `{ partitions: {} }` 替代 `{ results: [] }` | 是 |
| `scripts/lib/mcp-tools/search.ts` | 接口变更 | MCP search 工具返回 partitions 结构 | 是 |
| `scripts/lib/mcp-tools/query-group.ts` | 行为变更 | 内部调用走 `vectorSearch` 扁平结果（不走分区封装） | 否 |
| `scripts/lib/mcp-tools/get-module-info.ts` | 行为变更 | 同上（通过 path-search 间接） | 否 |
| `scripts/lib/path-search.ts` | 行为变更 | 内部调用走 `vectorSearch` 扁平结果 | 否 |

> **CLI 人类输出格式**：分区显示，每个分区有标题（`=== ki-search ===`）+ 结果列表。空分区显示 `（无结果）`。
