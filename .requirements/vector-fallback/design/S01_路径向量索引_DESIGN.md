# S-01：路径向量索引基础设施

> 状态：草案
> 父文档：[DESIGN.md](./DESIGN.md)

---

## 术语

| 术语 | 定义 |
|------|------|
| 路径向量 | 以 Group 路径或 Relation 名称为语义文本的向量记录，区别于内容向量（kb-import） |
| 空格分隔 | 路径层级用空格连接存储，如 `告警系统设计 告警收敛机制`，禁止用 `/` 连接 |
| 补录 | 对已存在的 KB 数据补充路径向量，不重新向量化内容 |

---

## 现状（AS-IS）

### 当前向量写入链路
- `scripts/lib/batch-vectorize.ts`：封装 `mem store` / `mem bulk-store`，仅写入 `category=kb-import`，无 tags 参数
- `scripts/lib/import.ts`：Phase 2 调用 `bulkVectorize()`，只存储内容向量
- `scripts/lib/incremental.ts`：Phase 3 调用 `bulkVectorize()` + `deleteMemory()`，只处理内容向量
- `scripts/sync-relation.ts`：写入 relations-cache，不涉及向量操作

### 问题
路径信息（groupPath + relation text）只存在于 relations-cache.json 和 group-index.json 中，没有向量索引，无法做语义搜索。

---

## 方案（TO-BE）

### 新增模块：`scripts/lib/path-vectorize.ts`

独立的向量写入模块，专用于 ki-path / ki-relation 标签的向量操作。

#### 核心函数

```typescript
/**
 * 构建 Group 路径向量文本
 * 格式：路径层级用空格分隔 + 关键词
 * 示例："告警系统设计 告警收敛机制 | 告警收敛,告警去重,降噪"
 */
export function buildGroupPathContent(
  groupPath: string,
  keywords: string[]
): string

/**
 * 构建 Relation 向量文本
 * 格式：Relation 名称 + Group 路径（空格分隔） + 关键词
 * 示例："告警收敛服务 | Group: 告警系统设计 告警处理服务 | 收敛,去重,合并"
 */
export function buildRelationContent(
  relationText: string,
  groupPath: string,
  keywords: string[]
): string

/**
 * 批量存储路径向量
 * 使用 mem bulk-store，一次进程写入全部条目
 */
export function bulkStorePaths(
  entries: PathVectorizeEntry[],
  options?: PathVectorizeOptions
): PathVectorizeResult

/**
 * 单条存储路径向量（sync-relation / incremental 单条场景）
 */
export function storeOnePath(
  entry: PathVectorizeEntry,
  options?: PathVectorizeOptions
): { ok: true; memoryId: string } | { ok: false; error: string }

/**
 * 删除路径向量（增量 delete 场景）
 * 通过 text 搜索找到 memoryId 后删除
 */
export function deletePathVector(
  text: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  options?: PathVectorizeOptions
): { ok: boolean; error?: string }
```

#### 路径格式转换规则

```
输入 groupPath: "BK-Monitor-Wiki/告警系统设计/告警收敛机制"
→ 去掉根节点 "BK-Monitor-Wiki"（它是 Wiki 根，不是语义层级）
→ 空格分隔: "告警系统设计 告警收敛机制"
→ 拼接关键词: "告警系统设计 告警收敛机制 | 告警收敛,告警去重,降噪"
```

**根节点去除逻辑**：group-index.json 的第一层 key 是 Wiki 根节点名（如 `BK-Monitor-Wiki`），向量文本中去除该前缀以减少噪音。

### 改动文件清单

| 文件 | 改动类型 | 改动内容 |
|------|---------|---------|
| `scripts/lib/path-vectorize.ts` | **新增** | 路径向量写入模块 |
| `scripts/lib/import.ts` | 修改 | Phase 2 后新增 Phase 2.5：调用 `bulkStorePaths` 写入 ki-path + ki-relation 向量 |
| `scripts/lib/incremental.ts` | 修改 | Phase 3 后新增路径向量同步（add 写入、modify 先删后写、delete 删除） |
| `scripts/sync-relation.ts` | 修改 | 写入 relation 后调用 `storeOnePath` 写入 ki-relation 向量 |

---

## 接口设计

### bulkStorePaths

```typescript
interface PathVectorizeOptions {
  timeoutMs?: number;  // 默认 60000 + entries.length * 10000
}

interface PathVectorizeResult {
  ok: Map<string, string>;  // text → memoryId
  errors: { text: string; error: string }[];
}

function bulkStorePaths(
  entries: PathVectorizeEntry[],
  options?: PathVectorizeOptions
): PathVectorizeResult
```

调用方式：`mem bulk-store -f <tmpFile> --json --scope <scope>`

JSON 文件中每条记录：
```json
{
  "text": "告警系统设计 告警收敛机制 | 告警收敛,告警去重,降噪",
  "tags": "ki-path",
  "scope": "monitor",
  "category": "other",
  "importance": 0.5
}
```

### storeOnePath

```typescript
function storeOnePath(
  entry: PathVectorizeEntry,
  options?: PathVectorizeOptions
): { ok: true; memoryId: string } | { ok: false; error: string }
```

调用方式：`mem store <text> --scope <scope> --tags <tag> --category other --importance 0.5`

---

## 数据模型

### ki-path 向量条目

| 字段 | 类型 | 示例 |
|------|------|------|
| text | string | `"告警系统设计 告警收敛机制 \| 告警收敛,告警去重,降噪"` |
| tags | string | `"ki-path"` |
| scope | string | `"monitor"` |
| category | string | `"other"` |
| importance | number | `0.5` |

### ki-relation 向量条目

| 字段 | 类型 | 示例 |
|------|------|------|
| text | string | `"告警收敛服务 \| Group: 告警系统设计 告警处理服务 \| 收敛,去重,合并"` |
| tags | string | `"ki-relation"` |
| scope | string | `"monitor"` |
| category | string | `"other"` |
| importance | number | `0.5` |

---

## 影响范围

| 文件 | 变更类型 | 变更行数（估算） |
|------|---------|----------------|
| `scripts/lib/path-vectorize.ts` | 新增 | ~150 行 |
| `scripts/lib/import.ts` | 修改 | ~30 行（新增 Phase 2.5） |
| `scripts/lib/incremental.ts` | 修改 | ~40 行（Phase 3 后追加路径向量同步） |
| `scripts/sync-relation.ts` | 修改 | ~15 行（写入后追加向量） |

---

## 关键决策点

### D1：路径层级分隔符选择

| 方案 | 被否决原因 |
|------|-----------|
| 斜杠 `/` 分隔 | embedding 模型对 `/` 的语义理解弱于空格，POC 测试中空格分隔效果更好 |
| 连字符 `-` 分隔 | 连字符在中文语境下不自然，且可能被模型视为一个词 |
| **空格分隔** ✅ | POC 验证效果最好，模型对独立中文词组的语义理解最强 |

### D2：根节点名是否保留在向量文本中

| 方案 | 被否决原因 |
|------|-----------|
| 保留根节点 | 根节点名（如 BK-Monitor-Wiki）对所有条目相同，增加噪音降低区分度 |
| **去除根节点** ✅ | 只保留有语义意义的层级，减少噪音 |
