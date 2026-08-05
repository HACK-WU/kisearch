---
id: REQ-20260805-001
feature: ki-search 输出增强与全文标记
status: 已确认
created: 2026-08-05
updated: 2026-08-05
version: 1
tags: [feature, search, vector, relations-cache]
depends_on: []
author: AI
document_type: requirement
---

# 需求文档：ki-search 输出增强与全文标记

## 1. 需求上下文

用户在使用 `ki search` 时发现，返回结果的 `content` 只是摘要，无法定位原文、也无法判断内容是否为全文。经过多轮讨论，需求由三块组成：

1. **search 输出附带原文定位信息**（已完成）：按 `memoryId` 反查 relations-cache，输出 `group` / `relation` / `sourcePath` 字段
2. **新增 `isFullText` 字段**（本需求核心）：标记 content 是否为全文。`scan-kb import --results ai-results.json` 导入的是 AI 摘要（非全文）；`sync-relation` 导入的是原文全文
3. **content 纯化 + 字段调整 + 默认 tags**（方案确认后新增）：
   - 向量 content 不再加 `[摘要]` / `[关键词]` / `[路径]` 前缀（传入什么就是什么），底层 keywords 自动拼接保留
   - search 输出**取消 `sourcePath`**（对 AI 无用），**新增 `keywords`**（取自 relations-cache 的 Group 级 keywords）
   - 不指定 `--tags` 时默认搜索**全部 tag**（现状只有 ki-search，`DEFAULT_TAGS` 常量定义了但未被使用）

## 2. 需求澄清与决策（已确认）

### 2.1 isFullText 标记位置与语义

- **位置**：`relations-cache.json` 每条 `hot_relation` 记录上（与 `memoryId` / `sourcePath` 同级），不是 Group 级
- **语义**：`true` = 向量 content 是全文；`false` = 是 AI 摘要；**字段缺失默认按非全文处理**（兼容旧数据）
- **写入方打标**：

| 写入方 | 数据来源 | 标记 |
|--------|----------|------|
| `scan-kb import`（ai-results.json） | ai-results 的 summary（AI 摘要） | `false` |
| 增量 import（incremental） | ai-results 的 summary | `false` |
| `sync-relation` | 用户传入的 module-info（原文全文） | `true` |
| `import-kb`（外部导入） | 本地 markdown 文件全文 | `true` |

- **重复同步补标**：`sync-relation` 对已存在 relation 重复同步时补 `isFullText: true`（兼容旧数据缺字段）

#### isFullText 完整加载链路（存储 / 写入 / 读取 / 判定）

**① 存储位置**（写在哪）：
- 文件：`relations-cache.json`
- 路径：`groups[groupPath].hot_relations[i].isFullText`（relation 级字段，与 `memoryId`/`sourcePath` 同级）
- 类型：`Relation.isFullText?: boolean`（定义于 `src/lib/scoring.ts`）

**② 写入方**（谁打标）：

| 写入函数 | 文件 | 值 | 时机 |
|---------|------|----|------|
| `upsertRelation` | `src/lib/import.ts` | `false` | scan-kb import 新建 / 更新 relation |
| `upsertRelation` | `src/lib/incremental.ts` | `false` | 增量导入新建 / 更新 |
| `syncSingleRelation` | `src/sync-relation.ts` | `true` | sync-relation 新建 / 重复同步补标 |
| `upsertImportedRelation` | `src/import-kb.ts` | `true`（待改） | import-kb 导入 |

**③ 读取方**（谁消费）：
1. `src/lib/relation-map.ts` `buildRelationMap`：构建 `Map<memoryId, …>` 时读 `rel.isFullText` 存入 Map 值（每个 scope 一份缓存）
2. `src/search.ts` `executeSearch`：`getRelationMap(scope).get(r.memoryId)` 命中后读取 → 输出到 `SearchHit.isFullText`

**④ 判定规则**（search 时）：

```
仅对 tag === 'ki-search' 的结果计算 isFullText（ki-path/ki-relation 不给该字段）
命中反查（relation-map 有该 memoryId）:
  ├─ 字段存在 → 输出字段值（false=摘要 / true=全文）
  └─ 字段缺失（旧数据）→ 默认 false
未命中反查（ki store / bulk-store 等只写向量层、不写 relations-cache 的数据）:
  └─ 前缀推断兜底 isFullTextContent(content)
     （content 纯化后无 [摘要] 前缀 → 兜底恒为 true，符合"用户直传原文"语义）
```

**⑤ rebuild 链路**（不读）：
- content 纯化后（见 2.2），rebuild 的 content 格式统一 = index.json 值，不再需要按 `isFullText` 决定是否加 `[摘要]` 前缀
- 因此 `collectContentEntries` **不读 isFullText**；isFullText 的唯一消费方是 search（经 relation-map 反查）

### 2.2 content 纯化（方案确认）

- 调用方（`buildVectorizeContent`、rebuild 的 `collectContentEntries`）**不再拼接** `[摘要] {s}\n[关键词] {kw}\n[路径] {path}`
- 向量 content = 传入的原始内容（summary 存 summary、全文存全文）
- 底层 `vector-client` 的 keywords 自动拼接 `\n\n[关键词] xxx` **保留**（保证 BM25 全文召回不降级）
- 关键词通过 `keywords` 参数传给 vector-client（不再手动拼进 content，避免重复）

### 2.3 search 输出字段调整

- **取消**：`sourcePath`（对 AI 无用）
- **保留**：`group`（定位模块）、`relation`（原文全文）、`keywords`（当前内容所在 Group 的索引关键词，取 relations-cache group 级 `groups[path].keywords`）
- `isFullText` 仅对 `ki-search` tag 计算；命中反查读标记（缺失默认 `false`），未命中（如 `ki store` 数据）前缀推断兜底（content 已无 `[摘要]` 前缀，兜底恒为 `true`）

### 2.4 默认 tags 搜索全部

- 不传 `--tags` → 不按 tag 过滤，搜索 scope 下**全部 tag**（含 ki-path / ki-relation）
- 传 `--tags a,b` → 多 tag OR 过滤（复用 `buildScopeTagFilter`）
- `DEFAULT_TAGS = ['ki-search', 'ki-path', 'ki-relation']` 是设计意图，本次落地
- MCP `ki_search` 工具的 tags 默认值同步改为不传（undefined）

### 2.5 关键权衡（已接受）

- rebuild-vector 重建的 content 来自 local KB index.json（可能存全文），与标记（摘要）可能不一致——**标记反映导入来源语义，rebuild 内容反映 index.json 现有内容，两者解耦**
- 这是"纯标记"方案的 trade-off（summary 未持久化到 KB 层，无法还原）

### 2.6 relation-map 反查映射（memoryId → 定位信息）详细设计

**数据源**：`relations-cache.json` 的 `groups` 字段（扁平键结构，键 = 完整 groupPath，如 `BKMonitorWiki/告警系统设计/通知渠道管理`）

**映射结构**（`src/lib/relation-map.ts`）：

```
Map<memoryId, {
  group: string         // 该 memoryId 所属 groupPath（定位模块）
  relation: string      // rel.text（原文全文 / 关系名，非摘要）
  keywords: string[]    // group 级 keywords（该 Group 的索引关键词，数组）
  isFullText?: boolean  // rel.isFullText（缺失 → search 按默认 false 处理）
}>
```

**构建逻辑**（`buildRelationMap`，O(N)，N = 全部 hot_relation 条数）：
1. 解析 relations-cache.json 的 `groups`
2. 外层遍历每个 `groupPath`：先取该 group 的 group 级 `keywords`（一个 group 一份，供其下所有 relation 复用）
3. 内层遍历 `hot_relations`：**仅 `rel.memoryId` 存在的条目进 Map**
   - 键：`rel.memoryId`（= 向量 docId，sha256(text+scope) 截 32）
   - 值：`{ group: groupPath, relation: rel.text, keywords: <该 group 的 keywords>, isFullText: rel.isFullText }`
4. 无 `memoryId` 的条目跳过（不构成反查键）

**缓存策略**（`getRelationMap`，按 scope 隔离）：
- 模块级单例：`Map<scope, { builtAt, mtimeMs, size, map }>`
- 命中条件：`relations-cache.json` 的 `mtime` + `size` **均未变** 且 距构建未超 TTL（默认 10 分钟）
- 失效条件：mtime/size 任一变化 → 立即重建（覆盖 sync-relation/import 写入后需立即可见的场景）；TTL 过期 → 重建（兜底原地等长改写）
- 懒构建：无定时器，首次访问 O(N)，后续 O(1)
- 文件缺失 / JSON 损坏 → 返回空 Map（search 降级为不带附加字段，不抛错）

**消费方**（search 时 O(1) 反查）：
- `src/search.ts` `executeSearch`：对每条 `vectorSearch` 返回的 `VectorSearchResult`，按 `memoryId` 执行 `map.get()`
  - 命中 → 附加 `group` / `relation` / `keywords` / `isFullText`（见 2.1 判定规则）
  - 未命中 → 仅附加 `isFullText`（前缀推断兜底）

## 3. 当前进度（已编写内容，含文件路径）

> 注意：以下"已完成"含上一轮已提交的 search 定位字段增强；本需求的核心改动（isFullText 标记）部分已改、部分待改。**用户明确要求"说开始编写才编写"，未获指令前不得继续改代码。**

### 3.1 已完成

| 文件 | 改动 |
|------|------|
| `src/lib/scoring.ts` | `Relation` 接口新增 `isFullText?: boolean`（约 29-37 行） |
| `src/lib/import.ts` | `upsertRelation`（约 200-241 行）：新建 relation 时 `isFullText: false`；已存在时刷新补 `isFullText: false` |
| `src/lib/incremental.ts` | `upsertRelation`（约 142-176 行）：新建/更新 `isFullText: false` |
| `src/sync-relation.ts` | `syncSingleRelation`（约 213-240 行）：新建 `isFullText: true`；重复同步补 `isFullText: true` |
| `src/lib/relation-map.ts`（新建，上轮） | memoryId → `{group, relation, sourcePath}` 反查映射 + TTL(10min)/mtime/size 双失效缓存 |
| `src/search.ts`（上轮） | `SearchHit`（group/relation/sourcePath）+ `isFullTextContent()` 前缀推断 + `executeSearch` 反查附加字段 |
| `test/relation-map.test.ts`（新建，上轮） | 8 用例：构建/跳过/缺失/损坏/缓存命中/mtime失效/TTL过期/scope隔离 |
| `test/search-is-full-text.test.ts`（新建，上轮） | 5 用例：isFullTextContent 前缀判定 |
| `test/rebuild-vector.test.ts`（上轮改） | 15 用例：collectContentEntries 加 `[摘要]/[路径]` 断言（**本需求要回退**） |
| `docs/cli.md` | search 章节：原文定位字段 + isFullText + `[摘要]/[关键词]/[路径]` 格式说明（**本需求要改**） |
| `AGENTS.md` | 变更记录（本需求上下文） |

### 3.2 待完成（按确认后的方案）

| 文件 | 改动 |
|------|------|
| `src/import-kb.ts` | `upsertImportedRelation`（约 224-247 行）：新建/更新 `isFullText: true` |
| `src/lib/batch-vectorize.ts` | `buildVectorizeContent` 只返回 `summary`（删 `[摘要]/[关键词]/[路径]` 手动拼接）；`vectorizeOne`/`bulkVectorize` 传 `keywords` 给 vector-client |
| `src/lib/rebuild-vector.ts` | `collectContentEntries` 回退：text = index.json 值（纯值）+ keywords=[关系名]；移除上轮加的 `[路径]` 与 relationsCache 参数 |
| `src/lib/relation-map.ts` | entry 改为 `{group, relation, keywords, isFullText}`（去 sourcePath，加 keywords 取 group 级、isFullText 从 rel 读） |
| `src/search.ts` | SearchHit 去 `sourcePath` 加 `keywords`；`isFullText` 仅 ki-search 计算（命中读标记、缺失默认 false；未命中前缀推断兜底）；默认 `tags` 改为不传（搜全部） |
| `src/lib/vector-client.ts` | `vectorSearch` tags 参数改为可选：不传/空 → 不按 tag 过滤（用 `buildScopeTagFilter`） |
| `src/lib/mcp-tools/search.ts` | `ki_search` 工具 tags 默认值 `'ki-search'` → 不传（undefined） |
| `test/relation-map.test.ts` | 更新 entry 结构断言（keywords/isFullText） |
| `test/rebuild-vector.test.ts` | 回退 content 格式断言（纯值，无 `[摘要]/[路径]`） |
| `test/search-is-full-text.test.ts` | 保持（前缀推断兜底逻辑不变），必要时更新注释 |
| `docs/cli.md` | search 章节：去 sourcePath、加 keywords、默认 tags 行为、content 纯化说明 |

### 3.3 待验证

- [ ] 单元测试全绿（relation-map / rebuild-vector / search-is-full-text / vector-cli-functions）
- [ ] 端到端：monitor rebuild 后 search 输出含 `keywords`/`isFullText`、无 `sourcePath`
- [ ] 端到端：`ki store` 数据 search 时 `isFullText: true`
- [ ] 端到端：不传 `--tags` 时返回含 ki-path/ki-relation 的混合结果

## 4. 关联文件

- 检索链路：`src/search.ts` → `src/lib/vector-client.ts`（`vectorSearch`）→ `src/lib/relation-map.ts`（反查缓存）
- 写入链路：`src/lib/import.ts` / `src/lib/incremental.ts` / `src/sync-relation.ts` / `src/import-kb.ts` → `relations-cache.json`（hot_relation 打标）
- 重建链路：`src/lib/rebuild-vector.ts`（`collectContentEntries`）
- MCP：`src/lib/mcp-tools/search.ts`（`ki_search`）
- 常量：`src/lib/constants.ts`（`DEFAULT_TAGS`）
- 类型：`src/lib/scoring.ts`（`Relation.isFullText`）
