# S-02：查询链路向量兜底

> 状态：草案
> 父文档：[DESIGN.md](./DESIGN.md)
> 依赖：S-01（路径向量索引基础设施）

---

## 术语

| 术语 | 定义 |
|------|------|
| 向量兜底 | 精确匹配失败后，调用 `mem search` 做语义搜索作为第四层查找 |
| 近似匹配 | score ≥ 0.75 的向量搜索结果，标注 `💡 近似匹配` 返回 |
| fuzzyMatched | ResolveResult 新增字段，标识该结果来自向量兜底 |

---

## 现状（AS-IS）

### 当前路径查找链路
- `scripts/lib/group-resolve.ts` → `resolveGroupPath()`：三层精确查找（直接匹配 → 顶层前缀补全 → 部分匹配），失败后返回 `matched: false` + 候选提示
- `scripts/get-module-info.ts` → relation 查找：`r.id === relation || r.text === relation` 精确匹配，失败后返回 `⚠️ Relation 未找到`

### 问题
- `resolveGroupPath` 失败后只能列出候选项或顶层 Group，无法做语义推断
- `get-module-info` 的 relation 查找完全没有模糊能力

---

## 方案（TO-BE）

### 新增模块：`scripts/lib/path-search.ts`

封装 `mem search` 调用，提供路径语义搜索能力。

```typescript
const DEFAULT_THRESHOLD = 0.75;
const SEARCH_TIMEOUT_MS = 15_000;

interface PathSearchResult {
  matched: boolean;
  rawText: string;
  extractedPath: string;
  score: number;
}

/**
 * 搜索路径向量（Group 路径或 Relation 名称）
 * 
 * @param query     用户输入的路径/名称
 * @param tag       搜索标签：ki-path 或 ki-relation
 * @param scope     当前 scope
 * @param threshold 匹配阈值，默认 0.75
 * @returns         搜索结果，超时/失败返回 matched=false（静默降级）
 */
export function searchPath(
  query: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  threshold?: number
): PathSearchResult | null
```

**调用方式**：
```bash
mem search "<query>" --scope <scope> --tags <tag> --limit 1 --json
```

**返回解析**：从 JSON 的 `results[0]` 提取 `score` 和 `content`，从 `content` 中解析出路径。

**降级处理**（委托 S-03）：`execFileSync` 抛异常或超时时返回 `null`。

### 修改：`scripts/lib/group-resolve.ts`

在 `resolveGroupPath()` 第 7 步（完全无匹配）之前，新增**第 6.5 步：向量兜底**。

```
原有流程（不变）：
  1. 直接匹配 groupsData → matched
  2. group-index 树查找 → matched
  3. 顶层前缀补全 → matched
  4. 唯一命中 → 自动补全
  5. 多个命中 → 候选列表
  6. 部分匹配 → 提示子节点

新增：
  6.5 向量兜底 → searchPath(userInput, 'ki-path', scope)
       - score ≥ 0.75 → 返回 matched=true + hint="💡 近似匹配"
       - score < 0.75 或 null → 继续原有流程
  
  7. 完全无匹配 → 提示顶层 Group（原有）
```

**ResolveResult 扩展**：

```typescript
export interface ResolveResult {
  resolvedPath: string;
  hint: string;
  matched: boolean;
  candidates?: string[];
  /** 新增：是否来自向量近似匹配 */
  fuzzyMatched?: boolean;
  /** 新增：向量匹配分数 */
  fuzzyScore?: number;
}
```

### 修改：`scripts/get-module-info.ts`

Relation 精确匹配失败后（第 113-127 行区域），新增向量兜底：

```
原有流程（不变）：
  r.id === relation || r.text === relation → 精确命中

新增：
  精确匹配失败 → searchPath(relation, 'ki-relation', scope)
    - score ≥ 0.75 → 用 extractedPath 作为 relation text 重新查找
    - score < 0.75 或 null → 返回原有 "Relation 未找到" 错误
```

---

## 接口设计

### searchPath 完整签名

```typescript
function searchPath(
  query: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  threshold: number = 0.75
): PathSearchResult | null

// 返回 null 表示搜索失败（超时/异常），调用方应静默降级
// 返回 { matched: false } 表示搜索成功但无有效匹配
// 返回 { matched: true } 表示找到近似匹配
```

### resolveGroupPath 扩展签名

```typescript
function resolveGroupPath(
  userInput: string,
  groupIndex: GroupIndex,
  groupsData: Record<string, unknown>,
  scope?: string  // 新增：向量兜底需要 scope 参数
): ResolveResult
```

**向后兼容**：`scope` 为可选参数，不传时跳过向量兜底，行为与原有完全一致。

---

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| `mem search` 超时（> 15s） | 返回 null → 调用方静默降级 | 否，stderr 输出 `[path-search] 搜索超时，跳过向量兜底` |
| `mem search` 进程异常 | 返回 null → 静默降级 | 否 |
| `mem search` 返回 0 结果 | 返回 `{ matched: false }` → 继续原有流程 | 否 |
| score < 0.75 | 返回 `{ matched: false }` → 继续原有流程 | 否 |
| score ≥ 0.75 但无法解析路径 | 返回 `{ matched: false }` → 继续原有流程 | stderr 记录 |

---

## 关键决策点

### D1：向量兜底插入位置

| 方案 | 被否决原因 |
|------|-----------|
| 放在第 3 步（前缀补全之前） | 精确匹配优先是核心原则，向量不应替代前缀补全这种低成本操作 |
| 放在第 5 步（多候选之后） | 多候选场景说明路径部分匹配成功，不需要向量兜底 |
| **放在第 6.5 步（部分匹配之后、完全无匹配之前）** ✅ | 所有精确手段失败后才启用向量，且能改善"完全无匹配"的最差体验 |

### D2：resolveGroupPath 的 scope 参数传递方式

| 方案 | 被否决原因 |
|------|-----------|
| 修改 resolveGroupPath 签名，增加 scope 参数 | 需要所有调用方都传 scope，改动面大 |
| **scope 设为可选参数** ✅ | 向后兼容，现有调用不传 scope 时行为不变；新增调用方传 scope 启用向量兜底 |
