# S-03: 写入工具实现

> 状态：草案
> 依赖：S-01（MCP Server 框架）
> 创建日期：2026-06-14

## 术语表

| 术语 | 定义 |
|------|------|
| sync-relation | 写入 Relation + 关键词校验 + 本地 KB 更新 |
| WAL | Write-Ahead Log，writeJson 的原子写入机制 |
| evict | Group 满员时淘汰 score 最低的 Relation |
| 向量索引 | 通过 mem CLI 写入 ki-path / ki-relation tags 的向量数据 |

## 现状分析（AS-IS）

### sync-relation.ts 可复用函数（`scripts/sync-relation.ts`）

| 函数 | 行数 | 职责 |
|------|------|------|
| `generateNextId(cache)` | L75-87 | 生成 rel_xxx ID |
| `ensureGroupPath(scope, path)` | L98-120 | 自动补建 Group 树缺失节点 |
| `validateKeywords(kws, info)` | L131-171 | 关键词校验（硬拒则 + 软拒则） |
| `syncSingleRelation(...)` | L175-288 | 核心：查找/创建 Relation + 淘汰 + 写本地 KB |
| `syncBatch(scope, file)` | L292-370 | **MCP 不暴露**（批量模式） |
| `.action()` | L385-469 | **CLI 耦合**，含 commander 参数解析 + 向量写入 |

**耦合点**：
- 向量写入在 `.action()` 内（L456-459）：`storeOnePath({ text, tag: 'ki-relation', scope })`
- Group 路径补全提示用 `console.error`（L429-432）
- `process.exit(1)` 多处

### manage-index.ts 可复用函数（`scripts/manage-index.ts`）

| 函数 | 行数 | 职责 |
|------|------|------|
| `findContainer(groups, parentPath)` | L26-50 | 按路径查找树节点容器 |
| `isEmptyNode(node)` | L55-57 | 检查节点是否为空 |
| `create` case | L125-177 | **MCP 暴露**（ki_manage_index_create） |
| `delete` case | L181-259 | **MCP 不暴露** |
| `list-scopes` case | L83-98 | **MCP 暴露**（ki_manage_index_list） |

## 方案设计（TO-BE）

### 策略：提取纯函数，MCP Handler 包装返回

与 S-02 相同策略，将 `.action()` 业务逻辑提取为 `executeXxx()` 函数，保留在原脚本文件中。MCP Handler 通过 `executeXxx()` 调用。

### 关键决策点

#### 决策 1：批量模式是否通过 MCP 暴露

| 方案 | 优势 | 劣势 | 决定 |
|------|------|------|------|
| 不暴露批量模式 | MCP 工具集简洁，Agent 可循环调用单条 | Agent 无法一次提交多条 | **采用** |
| 暴露批量模式（ki_sync_batch） | Agent 可一次提交多条 | 增加工具复杂度，参数 Schema 复杂 | 否决 |

**否决理由**：MCP 工具的参数 Schema 对 JSON 数组嵌套支持较弱，且 Agent 可通过循环调用 `ki_sync_relation` 实现相同效果。

#### 决策 2：向量写入是否在 MCP Handler 内执行

| 方案 | 优势 | 劣势 | 决定 |
|------|------|------|------|
| 在 executeSyncRelation 内执行 | 与 CLI 行为一致，向量索引完整 | 向量写入失败可能影响主流程 | **采用**（静默降级） |
| 不在 MCP 内执行向量写入 | 主流程更快 | 向量索引不完整，影响后续兑底查询 | 否决 |

**否决理由**：向量索引不完整会导致后续 `ki_query_group` 的向量兑底无法命中新写入的 Relation，影响 Agent 查询体验。采用静默降级策略：向量写入失败不阻塞主流程。

```typescript
// scripts/sync-relation.ts（改造后）
export function executeSyncRelation(params: {
  scope: string;
  group: string;
  relation: string;
  moduleInfo: string;
  keywords: string[];
}): SyncRelationResult;

// scripts/manage-index.ts（改造后）
export function executeManageCreate(params: {
  scope: string;
  name: string;
  parent?: string;
}): ManageCreateResult;

export function executeListScopes(): ListScopesResult;
```

### 返回结构设计

**ki_sync_relation** 成功：

```json
{
  "ok": true,
  "relation": "容器化部署最佳实践",
  "keywords": ["容器", "Docker", "编排"],
  "invalid_keywords": ["k8s/v1"],
  "evicted": null
}
```

**ki_sync_relation** 失败：

```json
{
  "ok": false,
  "error": "单条模式需要 group/relation/module-info/keywords 参数"
}
```

**ki_manage_index_create** 成功：

```json
{
  "ok": true,
  "path": "BK-Monitor-Wiki/新模块"
}
```

**ki_manage_index_create** 失败：

```json
{
  "ok": false,
  "error": "节点 \"新模块\" 已存在于 \"BK-Monitor-Wiki\" 下"
}
```

**ki_manage_index_list** 成功：

```json
{
  "ok": true,
  "scopes": [
    { "scope": "monitor", "topGroups": ["BK-Monitor-Wiki"] },
    { "scope": "user-profile", "topGroups": ["用户画像", "对话习惯"] }
  ],
  "total": 2
}
```

## 接口设计

### MCP 工具 inputSchema

| 工具 | 参数 | 类型 | 必填 | 默认值 |
|------|------|------|:---:|--------|
| ki_sync_relation | scope | string | 是 | — |
| | group | string | 是 | — |
| | relation | string | 是 | — |
| | module_info | string | 是 | — |
| | keywords | string[] | 是 | — |
| ki_manage_index_create | scope | string | 是 | — |
| | name | string | 是 | — |
| | parent | string | 否 | — |
| ki_manage_index_list | — | — | — | — |

### 纯函数签名

```typescript
export function executeSyncRelation(params: {
  scope: string;
  group: string;
  relation: string;
  moduleInfo: string;
  keywords: string[];
}): SyncRelationResult;

type SyncRelationResult =
  | { ok: true; relation: string; keywords: string[]; invalid_keywords: string[]; evicted: string | null }
  | { ok: false; error: string };

export function executeManageCreate(params: {
  scope: string;
  name: string;
  parent?: string;
}): ManageCreateResult;

type ManageCreateResult =
  | { ok: true; path: string; hint?: string }
  | { ok: false; error: string };

export function executeListScopes(): ListScopesResult;

type ListScopesResult = {
  ok: true;
  scopes: Array<{ scope: string; topGroups: string[] }>;
  total: number;
};
```

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| scope 不存在 | 返回 `{ ok: false, error: "scope 不存在" }` | 是 |
| module_info 为空 | 返回 `{ ok: false, error: "--module-info 内容不能为空" }` | 是 |
| 关键词全部无效 | 返回成功 + `keywords: [], invalid_keywords: [...]` | 是（Agent 可检查） |
| Group 已满需淘汰 | 返回成功 + `evicted: "被淘汰的 Relation 文本"` | 是（Agent 可感知） |
| 节点名称含 `/` | 返回 `{ ok: false, error: "节点名不能包含 /" }` | 是 |
| 节点已存在 | 返回 `{ ok: false, error: "节点已存在" }` | 是 |
| 向量写入失败 | 静默跳过，不影响主流程 | 否 |
| WAL 写入失败 | 返回 `{ ok: false, error: "写入失败: ..." }` | 是 |

## 安全约束

MCP 工具集通过**注册隔离**实现零破坏性：

```typescript
// lib/mcp-tools/manage-index.ts
export function registerManageIndexTools(server: McpServer): void {
  // ✅ 仅注册 create 和 list-scopes
  server.tool('ki_manage_index_create', ...);
  server.tool('ki_manage_index_list', ...);

  // ❌ 不注册 delete 工具 — Agent 无法通过 MCP 删除任何节点
  // delete 仅在 CLI 模式可用：ki manage-index --action delete
}
```

**隔离层级**：
- **工具注册层**：不注册 = Agent 不可见 = 不可调用
- **Handler 层**：即使未来扩展注册 delete，Handler 内可二次校验拒绝
- **CLI 不受影响**：`ki manage-index --action delete` 仍可通过终端使用
