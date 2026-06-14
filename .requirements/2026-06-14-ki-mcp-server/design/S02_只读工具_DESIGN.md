# S-02: 只读工具实现

> 状态：草案
> 依赖：S-01（MCP Server 框架）
> 创建日期：2026-06-14
> 注：`ki_get_module_info` 含隐式写入（评分更新 recordUse + writeJson），非严格只读

## 术语表

| 术语 | 定义 |
|------|------|
| Group 树 | group-index.json 中的嵌套 JSON 对象，表示知识分类层级 |
| Relations 缓存 | relations-cache.json，每个 Group 下的 hot_relations 数组 |
| 词云 (keywords) | Group 级别的关键词列表，FIFO 策略管理 |
| 向量兜底 | 精确匹配失败时通过 mem CLI 向量搜索模糊定位路径 |

## 现状分析（AS-IS）

### query-group.ts 可复用函数（`scripts/query-group.ts`）

| 函数 | 行数 | 职责 |
|------|------|------|
| `loadGroupIndex(scope)` | L45-47 | 读取 group-index.json |
| `loadRelationsCache(scope)` | L49-51 | 读取 relations-cache.json |
| `collectAllGroupPaths(groups)` | L55-73 | 递归收集所有 Group 路径 |
| `getGroupAggregateScores(...)` | L77-90 | 计算 Group 聚合评分 |
| `partitionGroups(...)` | L104-133 | 按评分分区 hot/warm/cold/emerging |
| `formatGroupRelations(...)` | L392-452 | 格式化单个 Group 的 Relations + 词云 |
| `formatHotRelations(...)` | L203-229 | 格式化热门 Relations 列表 |
| `renderTree(...)` | L233-273 | 渲染完整 Group 树 |
| `computeStats(...)` | L456-467 | 统计各分区数量 |
| `filterRelationsByMode(...)` | L538-554 | 按 mode 过滤 Relations |
| `parseCliOpts(opts)` | L488-515 | **CLI 耦合**，需解耦 |
| `.action()` | L578-690 | **CLI 耦合**，包含 console.log + process.exit |

**耦合点**：`resolveGroupPath()` 调用在 `.action()` 内（L614-616），输出提示用 `console.log`（L640），错误用 `process.exit(1)`（L686-688）。

### get-module-info.ts 逻辑（`scripts/get-module-info.ts`）

逻辑完全在 `.action()` 回调内（L57-199），包含：
- Group 路径补全：`resolveGroupPath()`（L83）
- Relation 查找：精确匹配 + 向量兜底 `searchPath()`（L120-132）
- 评分更新：`recordUse()` + `calculateScore()`（L178-191）
- Markdown 读取：`readJson()` local KB（L150）

**耦合点**：错误用 `process.exit(1)` + `output()` 混合，提示用 `console.error`（L96, L128），Markdown 直接 `console.log`（L194）。

## 方案设计（TO-BE）

### 策略：提取纯函数，MCP Handler 包装返回

将 `.action()` 中的业务逻辑提取为 `executeXxx()` 函数，保留在原脚本文件中。MCP Handler 通过 `executeXxx()` 调用，不直接引用 `scripts/lib/` 基础设施。

```typescript
// scripts/lib/mcp-tools/query-group.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// 通过 executeXxx 封装函数调用，不跨层引用 lib/ 基础设施
import { executeQueryGroup } from '../../query-group.js';

export function registerQueryGroupTool(server: McpServer): void {
  server.tool(
    'ki_query_group',
    '查询 Group 树 + Relations + 词云，支持向量语义兜底',
    {
      scope: z.string().describe('项目隔离标识'),
      groups: z.string().optional().describe('逗号分隔的 Group 路径列表（支持模糊匹配）'),
      hot_count: z.number().int().positive().optional().default(5).describe('热门展示个数'),
      depth: z.number().int().min(1).max(10).optional().default(4).describe('索引层级深度'),
      mode: z.string().optional().default('hot')
        .describe('展示分区：hot|warm|cold|emerging|full（支持逗号分隔）'),
    },
    async (args) => {
      try {
        const result = executeQueryGroup({
          scope: args.scope,
          groups: args.groups,
          hotCount: args.hot_count ?? 5,
          depth: args.depth ?? 4,
          modes: (args.mode ?? 'hot').split(',').map(m => m.trim()),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );
}
```

### 核心改造点

1. **query-group.ts**：将 `.action()` 中的业务逻辑提取为 `executeQueryGroup(params)` 函数，返回结构化结果而非 console.log
2. **get-module-info.ts**：将 `.action()` 中的逻辑提取为 `executeGetModuleInfo(params)` 函数
3. **CLI 入口**：改为调用提取的函数 + console.log/process.exit

```typescript
// scripts/query-group.ts（改造后）
export function executeQueryGroup(params: {
  scope: string;
  groups?: string;
  hotCount: number;
  depth: number;
  modes: string[];
}): { output: string; ok: boolean; error?: string } {
  // ... 现有业务逻辑，返回结构化结果
}

// CLI 入口（改造后）
program.action(async (opts) => {
  const result = executeQueryGroup(parseCliOpts(opts));
  if (!result.ok) {
    console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
    process.exit(1);
  }
  console.log(result.output);
});
```

### 返回结构设计

**ki_query_group** 无指定 groups 时（全局视图）：

```json
{
  "ok": true,
  "scope": "monitor",
  "hot_relations": [
    { "group_path": "BK-Monitor-Wiki/部署与运维", "text": "容器化部署", "score": 3.2 }
  ],
  "tree": "BK-Monitor-Wiki/ (score: 5.2) [热]\n├── 部署与运维 (score: 3.2) [热]",
  "stats": { "total": 42, "hot": 8, "emerging": 3, "warm": 15, "cold": 19 }
}
```

**ki_query_group** 指定 groups 时（Group 详情）：

```json
{
  "ok": true,
  "groups": [
    {
      "path": "BK-Monitor-Wiki/部署与运维",
      "hint": "💡 近似匹配：\"部署运维\" → \"BK-Monitor-Wiki/部署与运维\"（score: 0.89）",
      "relations": [
        { "text": "容器化部署", "score": 3.2, "label": "[热]" }
      ],
      "keywords": ["Kubernetes", "Docker", "容器编排"]
    }
  ]
}
```

**ki_get_module_info** 成功：

```json
{
  "ok": true,
  "group": "BK-Monitor-Wiki/部署与运维",
  "relation": "容器化部署",
  "content": "# 容器化部署\n\n## 概述\n..."
}
```

**ki_get_module_info** 失败：

```json
{
  "ok": false,
  "error": "Relation \"xxx\" 不存在于 Group \"...\" 中",
  "hint": "Group 中可用的 Relation：\n  - 容器化部署\n  - Kubernetes集群管理"
}
```

## 接口设计

```typescript
// 从 query-group.ts 提取的纯函数
export interface QueryGroupParams {
  scope: string;
  groups?: string;
  hotCount: number;
  depth: number;
  modes: string[];
}

export type QueryGroupResult =
  | { ok: true; scope: string; hot_relations?: HotItem[]; tree?: string; stats?: Stats }
  | { ok: true; groups: GroupDetail[] }
  | { ok: false; error: string };

export function executeQueryGroup(params: QueryGroupParams): QueryGroupResult;

// 从 get-module-info.ts 提取的纯函数
export interface GetModuleInfoParams {
  scope: string;
  group: string;
  relation: string;
}

export type GetModuleInfoResult =
  | { ok: true; group: string; relation: string; content: string; hint?: string }
  | { ok: false; error: string; hint?: string };

export function executeGetModuleInfo(params: GetModuleInfoParams): GetModuleInfoResult;
```

### MCP 工具 inputSchema

| 工具 | 参数 | 类型 | 必填 | 默认值 |
|------|------|------|:---:|--------|
| ki_query_group | scope | string | 是 | — |
| | groups | string | 否 | — |
| | hot_count | number(int) | 否 | 5 |
| | depth | number(int, 1-10) | 否 | 4 |
| | mode | string | 否 | "hot" |
| ki_get_module_info | scope | string | 是 | — |
| | group | string | 是 | — |
| | relation | string | 是 | — |

## 数据模型

MCP 返回的 `content` 字段为纯文本（`type: 'text'`），内容为上述 JSON 结构的 stringify。Agent 可直接 JSON.parse。

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| scope 不存在 | 返回 `{ ok: false, error: "scope 不存在" }` | 是 |
| group-index.json 不存在 | 返回 `{ ok: false, error: "group-index.json 不存在" }` | 是 |
| Group 路径向量兜底命中 | 返回结果 + hint 字段 | 是（Agent 可见匹配提示） |
| Relation 未找到 | 返回 `{ ok: false, error, hint: "可用 Relations 列表" }` | 是 |
| 向量兜底外部 API 超时 | 静默跳过兜底，返回无兜底错误 | 否 |
| local KB 文件不存在 | 返回 `{ ok: false, error, hint: "sync-relation 写入方法" }` | 是 |
