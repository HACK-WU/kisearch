# S-02 query-group 自动语义兜底

> 状态：草案
> 依赖：S-01（mem-client + search.ts）

## 术语

| 术语 | 定义 |
|------|------|
| 语义兜底 | 本地 Group/Relation 精确匹配和现有向量兜底（ki-path/ki-relation）均未命中时，自动走通用语义搜索 |
| 物理隔离 | ki-search 使用独立 tag `ki-search`，与 ki-path/ki-relation 互不干扰 |
| 显式标注 | 语义兜底结果带 `💡 语义匹配` 标识，区分于精确匹配 |

## 现状（AS-IS）

`query-group.ts` 当前查询链路（第 607-632 行）：

1. 用户传入 `--groups "模糊路径"` 
2. 调用 `resolveGroupPath()` 做本地模糊匹配
3. 匹配成功 → 展示 Relations + 词云
4. 匹配失败 → 输出"暂无 Relations"+ hint

**现有向量兜底**（由 `group-resolve.ts` 提供）：仅对 Group 路径做 ki-path/ki-relation 向量搜索，是**路径级兜底**，不涉及通用语义搜索。

**问题**：当 Group 路径和 Relation 都找不到时，没有通用语义搜索作为最终兜底。用户只能看到"暂无"提示。

**关键文件**：
- `scripts/query-group.ts`（第 607-632 行：groupsParam 处理分支）
- `scripts/lib/group-resolve.ts`（路径解析 + ki-path/ki-relation 向量兜底）

## 方案（TO-BE）

### 3.1 新增兜底层

在 `resolveGroupPath` 之后，当本地匹配和现有向量兜底均未命中时，新增一层：

```
精确匹配 → ki-path/ki-relation 向量兜底 → ki-path 路径级语义搜索（新增）
```

**触发条件**：
1. `resolveGroupPath()` 返回 `matched: false`
2. **且** mem 可用（`ensureMemAvailable().available === true`）
3. **且** `--auto-fallback` 未设为 false

**新增参数**：

```bash
ki query-group --scope <scope> --groups "模糊表述" [--auto-fallback]  # 默认开启
```

### 3.2 语义兜底执行流程

```
1. 调用 memSearch({ scope, query: groupsParam, limit: 5 })
2. 如果返回结果：
   a. 每条结果标注 💡 语义匹配
   b. 直接展示摘要 + score（不做路径提取）
3. 如果无结果：
   a. 维持原有"暂无 Relations"输出
```

**内容展示策略**：语义兜底结果直接展示摘要 + score，不尝试从 content 中提取 group/relation 路径。理由：通用语义搜索返回的内容格式多样，路径提取依赖正则匹配，可靠性低且增加实现复杂度，不符合薄封装原则。

### 3.3 输出格式

语义兜底命中时，在原有输出后追加：

```
💡 语义匹配结果（来自通用搜索）：
├── [score: 0.92] 用户登录流程 - 认证模块负责校验账号密码...
├── [score: 0.85] Token 刷新机制 - 过期前自动刷新...
└── [score: 0.78] OAuth2 授权流程 - 第三方登录集成...
```

### 3.4 自动回写

语义兜底命中后，**不自动回写**到本地 Relation。理由：
- 通用语义搜索结果不一定对应 ki 中已有的 Group/Relation
- 自动回写可能创建大量无意义的 Relation
- 回写应由用户显式决定（通过 sync-relation）

### 3.5 降级行为

mem 不可用时：
- 跳过语义兜底层，直接输出原有"暂无 Relations"
- 不报错，不 warning（静默降级）

### 3.6 关键决策点

| 决策 | 选定方案 | 被否决方案 | 否决理由 |
|------|----------|------------|----------|
| 兆底触发时机 | 精确匹配 + ki-path/ki-relation 兜底均未命中时触发 | 仅精确匹配失败即触发 | 跳过现有 ki-path/ki-relation 路径级兜底会丢失已有的路径模糊匹配能力，语义搜索应作为最终兜底而非替代现有机制 |
| `--auto-fallback` 默认值 | 默认开启 | 默认关闭 | 用户期望查询尽可能返回结果，默认关闭会导致多数用户手动开启，降低体验；保留关闭能力以支持仅需结构化结果的场景 |
| 兆底结果是否展示完整 Relations | 仅展示摘要 + score | 尝试提取路径后展示完整 Relations | 路径提取依赖正则匹配，可靠性低，内容格式多样难以覆盖；增加实现复杂度不符合薄封装原则 |

## 接口设计

**对 `executeQueryGroup` 函数的变更**：

```typescript
export interface QueryGroupParams {
  scope: string;
  groupsParam?: string;
  hotCount: number;
  depth: number;
  modes: string[];
  autoFallback?: boolean;  // 新增，默认 true
}
```

输出格式不变（`QueryGroupResult`），仅 output 字符串内容追加语义匹配结果。

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| memSearch 调用失败 | 静默跳过兜底，输出原有结果 | 否 |
| memSearch 返回空结果 | 维持原有"暂无"输出 | 否 |
| memSearch 超时 | 静默跳过兜底 | 否 |
| content 中无法提取路径 | 不适用——统一展示摘要 + score | 是（正常输出） |

## 测试方案

- **单元测试**：mock `memSearch`，验证兜底触发条件、输出格式、降级行为
- **集成测试**：写入数据后，用模糊路径查询验证语义兜底返回结果
- **降级测试**：mem 不可用时验证原有输出不受影响

## 风险 & 待定问题

| 问题 | 状态 | 备选方案 |
|------|------|----------|
| 语义搜索结果质量依赖 mem 中的数据质量 | 已知风险 | 接受——这是 mem 的职责，不是 ki 的职责 |
| 是否需要 `--auto-fallback` 开关？ | 已确定：默认开启 | 保留关闭能力，部分场景只需结构化结果 |
| 语义兜底是否应限制在指定 scope 内？ | 已确定：是 | mem 本身有 scope 隔离，ki 不做额外限制 |
