# ki_search工具

<cite>
**本文引用的文件**
- [src/search.ts](file://src/search.ts)
- [src/lib/vector-client.ts](file://src/lib/vector-client.ts)
- [src/lib/relation-map.ts](file://src/lib/relation-map.ts)
- [src/lib/scope.ts](file://src/lib/scope.ts)
- [src/lib/config.ts](file://src/lib/config.ts)
- [skills/ki-search/SKILL.md](file://skills/ki-search/SKILL.md)
</cite>

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能与调优](#性能与调优)
8. [故障排查](#故障排查)
9. [结论](#结论)
10. [附录：API 参考](#附录api-参考)

## 简介
ki_search 是知识索引工具的混合检索能力入口，结合语义向量搜索与 BM25 全文检索（RRF 融合），并提供作用域隔离、标签过滤、结果去重、原文召回与降级等能力。其核心流程为“索引直查优先，语义检索兜底”：当已知路径或精确标识时优先走索引定位；否则通过向量+全文的混合检索召回相关内容，并支持按 scope/tags 精细控制。

## 项目结构
- CLI 入口与编排：src/search.ts
- 向量客户端与引擎封装：src/lib/vector-client.ts
- 原文定位映射（memoryId → group/relation）：src/lib/relation-map.ts
- Scope 校验与路径构造：src/lib/scope.ts
- 配置加载与解析（含 embedding、vectorDir、scopeMode）：src/lib/config.ts
- 行为规则与最佳实践：skills/ki-search/SKILL.md

```mermaid
graph TB
A["CLI: src/search.ts"] --> B["向量客户端: src/lib/vector-client.ts"]
A --> C["原文定位: src/lib/relation-map.ts"]
A --> D["Scope 校验: src/lib/scope.ts"]
A --> E["配置加载: src/lib/config.ts"]
B --> F["ZvecEngine (dist/zvec-engine)"]
```

图表来源
- [src/search.ts:70-199](file://src/search.ts#L70-L199)
- [src/lib/vector-client.ts:477-506](file://src/lib/vector-client.ts#L477-L506)
- [src/lib/relation-map.ts:48-78](file://src/lib/relation-map.ts#L48-L78)
- [src/lib/scope.ts:30-43](file://src/lib/scope.ts#L30-L43)
- [src/lib/config.ts:444-459](file://src/lib/config.ts#L444-L459)

章节来源
- [src/search.ts:1-248](file://src/search.ts#L1-L248)
- [src/lib/vector-client.ts:1-754](file://src/lib/vector-client.ts#L1-L754)
- [src/lib/relation-map.ts:1-120](file://src/lib/relation-map.ts#L1-L120)
- [src/lib/scope.ts:1-230](file://src/lib/scope.ts#L1-L230)
- [src/lib/config.ts:1-509](file://src/lib/config.ts#L1-L509)
- [skills/ki-search/SKILL.md:1-198](file://skills/ki-search/SKILL.md#L1-L198)

## 核心组件
- executeSearch：统一编排搜索流程（参数校验→可用性检测→检索→原文召回→去重→返回）
- vectorSearch：调用底层 hybridSearch（语义 + FTS + RRF），并按 scope/tag 过滤
- getRelationMap：构建 memoryId → {group, relation} 的反查映射（带 TTL 缓存）
- ensureVectorAvailable：向量服务可用性检测与降级提示
- resolveScope / validateScope：scope 模式与字符合法性校验

章节来源
- [src/search.ts:70-199](file://src/search.ts#L70-L199)
- [src/lib/vector-client.ts:477-506](file://src/lib/vector-client.ts#L477-L506)
- [src/lib/relation-map.ts:48-78](file://src/lib/relation-map.ts#L48-L78)
- [src/lib/vector-client.ts:420-467](file://src/lib/vector-client.ts#L420-L467)
- [src/lib/config.ts:444-459](file://src/lib/config.ts#L444-L459)
- [src/lib/scope.ts:30-43](file://src/lib/scope.ts#L30-L43)

## 架构总览
ki_search 采用“双路径查询机制”：
- 索引直查优先：当存在 Group/Relation 等明确标识时，直接读取本地 KB 与 relations-cache 进行精准命中。
- 语义检索兜底：当无法确定具体位置时，使用 zvec 的 hybridSearch（语义向量 + BM25 全文 + RRF 融合）召回相关片段，再结合 tag 过滤与原文定位。

```mermaid
sequenceDiagram
participant U as "调用方"
participant S as "search.executeSearch"
participant V as "vector-client.vectorSearch"
participant Z as "ZvecEngine.hybridSearch"
participant R as "relation-map.getRelationMap"
participant K as "local KB fetchOriginal"
U->>S : 传入 query/scope/tags/limit/threshold/includeOriginal
S->>S : resolveScope + validateScope
S->>S : ensureVectorAvailable(scope)
alt 可用
S->>V : 执行混合检索语义+FTS+RRF
V->>Z : hybridSearch(queryText, fts, topk, filter)
Z-->>V : Hit[]
V-->>S : VectorSearchResult[]
S->>R : 构建 memoryId→{group,relation} 映射
R-->>S : Map
opt includeOriginal=true
S->>K : 按(group,relation)取原文
K-->>S : original/hint
end
S->>S : Multi-tag 去重 + 多chunk去重
S-->>U : {ok : true, scope, results}
else 不可用
S-->>U : {ok : false, error, degraded : true}
end
```

图表来源
- [src/search.ts:70-199](file://src/search.ts#L70-L199)
- [src/lib/vector-client.ts:477-506](file://src/lib/vector-client.ts#L477-L506)
- [src/lib/vector-client.ts:420-467](file://src/lib/vector-client.ts#L420-L467)
- [src/lib/relation-map.ts:48-78](file://src/lib/relation-map.ts#L48-L78)

## 详细组件分析

### 搜索参数与行为
- query：自然语言查询文本，同时作为语义向量查询与 FTS 关键词输入。
- scope：作用域隔离标识。默认模式下可省略（回退 default），strict 模式下必须显式且已注册。
- tags：标签过滤。不传则搜索全部；传单个或多逗号分隔，内部以 OR 组合；大小写忽略（写入/查询均小写化）。
- limit：返回条数上限。默认 10。
- threshold：最低相似度阈值（融合得分），低于该值的结果将被过滤。
- includeOriginal：是否返回 local KB 文件级原文。默认 false；开启后若原文不可用将降级为向量文档内容并附带提示。
- fallback_mode：当前实现中未暴露同名参数；但整体具备“向量不可用即降级返回”的行为（degraded:true）。如需更细粒度回退策略，可在上层封装。

章节来源
- [src/search.ts:70-199](file://src/search.ts#L70-L199)
- [src/lib/vector-client.ts:477-506](file://src/lib/vector-client.ts#L477-L506)
- [src/lib/config.ts:444-459](file://src/lib/config.ts#L444-L459)
- [src/lib/vector-client.ts:420-467](file://src/lib/vector-client.ts#L420-L467)

### 双路径查询机制
- 索引直查优先：当已知 group/relation/memoryId 时，优先通过 relations-cache 与 local KB 定位原文，确保 100% 精准命中。
- 语义检索兜底：未知路径时，进入 hybridSearch 召回，再通过 memoryId 反查附加 group/relation，必要时拉取原文。

```mermaid
flowchart TD
Start(["开始"]) --> CheckKnown{"是否已知 group/relation?"}
CheckKnown -- 是 --> IndexPath["索引直查<br/>relations-cache + local KB"]
CheckKnown -- 否 --> Hybrid["混合检索<br/>hybridSearch(语义+FTS+RRF)"]
IndexPath --> Return["返回结果"]
Hybrid --> Enrich["附加 group/relation<br/>可选原文召回"]
Enrich --> Dedup["Multi-tag 去重<br/>多 chunk 去重"]
Dedup --> Return
```

图表来源
- [src/search.ts:123-199](file://src/search.ts#L123-L199)
- [src/lib/relation-map.ts:48-78](file://src/lib/relation-map.ts#L48-L78)
- [src/lib/vector-client.ts:477-506](file://src/lib/vector-client.ts#L477-L506)

### 搜索结果排序与去重
- 排序：按 score 降序（zvec 已归一化分数）。
- Multi-tag 去重：同一 (group, relation) 因多 tag 写入产生多条命中时，保留 score 最高的一条。
- 多 chunk 去重（仅 includeOriginal=true）：同一文件的多个 chunk 命中，仅首条携带 original，后续标记 deduplicated。

章节来源
- [src/search.ts:159-194](file://src/search.ts#L159-L194)

### 原文召回与降级
- 当 includeOriginal=true 且能定位到 (group, relation) 时，从 local KB 读取文件级原文。
- 若原文不可用（缺失或读取异常），降级为向量文档 content，并设置 originalRetrieved=false 与 originalHint 提示。
- 若无法定位（无反查信息），同样降级为向量文档 content。

章节来源
- [src/search.ts:135-157](file://src/search.ts#L135-L157)

### 错误处理与超时控制
- 向量服务不可用：ensureVectorAvailable 返回 { ok:false, error, degraded:true }，不抛异常，便于上层降级。
- 撞锁重试：向量库被占用时自动等待并重试（最多 3 次，间隔 2s），避免立即失败。
- 打开/创建超时：engine open/create 带 20s 超时保护，防止原生阻塞导致进程挂起。
- Worker 不可用自愈：在途操作检测到 worker closed 时，自动 closeEngine 并重新获取 engine 重试一次。
- CLI 结束释放：每次 CLI 调用结束后关闭 engine，避免进程无法退出。

章节来源
- [src/lib/vector-client.ts:93-104](file://src/lib/vector-client.ts#L93-L104)
- [src/lib/vector-client.ts:203-216](file://src/lib/vector-client.ts#L203-L216)
- [src/lib/vector-client.ts:389-407](file://src/lib/vector-client.ts#L389-L407)
- [src/search.ts:234-237](file://src/search.ts#L234-L237)

### 搜索语法示例
- CLI
  - ki search <query> [--scope <scope>] [--limit <n>] [--threshold <f>] [--tags <t1,t2>] [--original]
  - 示例：ki search "用户认证流程" --scope myproject --limit 5 --threshold 0.3 --tags "ki-search,auth"
- MCP/函数调用
  - executeSearch({ scope, query, limit, threshold, tags, includeOriginal })

章节来源
- [src/search.ts:206-237](file://src/search.ts#L206-L237)
- [skills/ki-search/SKILL.md:74-104](file://skills/ki-search/SKILL.md#L74-L104)

## 依赖关系分析
- search.ts 依赖 vector-client.ts（检索）、relation-map.ts（原文定位）、scope.ts（校验）、config.ts（scope 解析）。
- vector-client.ts 依赖 dist/zvec-engine（hybridSearch/upsert/delete/listIds/fetch）。
- relation-map.ts 依赖 scope.ts（relations-cache.json 路径）。
- config.ts 提供 embedding/vectorDir/scopeMode 等全局配置。

```mermaid
graph LR
search["search.ts"] --> vc["vector-client.ts"]
search --> rm["relation-map.ts"]
search --> sc["scope.ts"]
search --> cfg["config.ts"]
vc --> ze["zvec-engine (dist)"]
rm --> sc
```

图表来源
- [src/search.ts:11-18](file://src/search.ts#L11-L18)
- [src/lib/vector-client.ts:21-33](file://src/lib/vector-client.ts#L21-L33)
- [src/lib/relation-map.ts:19-21](file://src/lib/relation-map.ts#L19-L21)
- [src/lib/config.ts:148-175](file://src/lib/config.ts#L148-L175)

章节来源
- [src/search.ts:11-18](file://src/search.ts#L11-L18)
- [src/lib/vector-client.ts:21-33](file://src/lib/vector-client.ts#L21-L33)
- [src/lib/relation-map.ts:19-21](file://src/lib/relation-map.ts#L19-L21)
- [src/lib/config.ts:148-175](file://src/lib/config.ts#L148-L175)

## 性能与调优
- 合理使用 limit：限制返回条数，减少网络与序列化开销。
- 合理设置 threshold：提高阈值可减少低质结果，但可能漏召回；建议根据业务场景调优。
- 利用 tags：通过标签缩小搜索空间，提升命中率与速度。
- 原文按需开启：includeOriginal 仅在需要时开启，避免额外 IO。
- 共享向量库：多实例共享同一向量库时，启用空闲释放锁（常驻 MCP 层）避免争用；CLI 短命令无需启用。
- 批量导入优化：导入链路使用批量 upsert，减少往返次数。

章节来源
- [src/lib/vector-client.ts:164-181](file://src/lib/vector-client.ts#L164-L181)
- [src/lib/vector-client.ts:547-590](file://src/lib/vector-client.ts#L547-L590)
- [src/search.ts:94-121](file://src/search.ts#L94-L121)

## 故障排查
- 向量服务不可用
  - 现象：返回 { ok:false, error, degraded:true }
  - 处理：检查向量库是否被占用或损坏；必要时重建向量库
- 向量库被占用
  - 现象：提示“被其他进程占用或存在崩溃残留”
  - 处理：停止冲突进程或等待锁释放；必要时执行重建
- 原文不可用
  - 现象：originalRetrieved=false 且 originalHint 提示
  - 处理：执行 sync-relation 或 rebuild-vector 恢复原文映射
- 打开/创建超时
  - 现象：超过 20s 未完成
  - 处理：检查磁盘状态与向量库目录健康性

章节来源
- [src/lib/vector-client.ts:420-467](file://src/lib/vector-client.ts#L420-L467)
- [src/lib/vector-client.ts:93-104](file://src/lib/vector-client.ts#L93-L104)
- [src/lib/vector-client.ts:203-216](file://src/lib/vector-client.ts#L203-L216)
- [src/search.ts:135-157](file://src/search.ts#L135-L157)

## 结论
ki_search 提供了稳定、可控的混合检索能力：在已知路径时优先索引直查，未知路径时通过语义+全文召回，并结合标签与作用域隔离、原文召回与多级降级，满足多种检索场景。通过合理的参数调优与错误处理策略，可在保证召回质量的同时获得良好的性能表现。

## 附录：API 参考

### 函数：executeSearch
- 入参
  - scope?: string
  - query: string
  - limit?: number
  - threshold?: number
  - tags?: string
  - includeOriginal?: boolean
- 返回
  - { ok: true; scope: string; results: SearchHit[] }
  - { ok: false; error: string; degraded?: boolean }

章节来源
- [src/search.ts:70-199](file://src/search.ts#L70-L199)

### 类型：SearchHit
- memoryId: string
- content: string
- score: number
- tag?: string
- group?: string
- relation?: string
- originalRetrieved?: boolean
- original?: string
- originalHint?: string
- deduplicated?: boolean

章节来源
- [src/search.ts:33-47](file://src/search.ts#L33-L47)

### 函数：vectorSearch
- 入参
  - scope: string
  - query: string
  - limit?: number
  - tags?: string
  - threshold?: number
- 返回
  - VectorSearchResult[]

章节来源
- [src/lib/vector-client.ts:477-506](file://src/lib/vector-client.ts#L477-L506)

### 函数：ensureVectorAvailable
- 入参
  - scope?: string
- 返回
  - { available: boolean; reason?: string; code?: 'LOCKED'|'CORRUPTED'|'PROBE_ERROR' }

章节来源
- [src/lib/vector-client.ts:420-467](file://src/lib/vector-client.ts#L420-L467)

### 函数：getRelationMap
- 入参
  - scope: string
  - ttlMs?: number
- 返回
  - Map<string, { group: string; relation: string }>

章节来源
- [src/lib/relation-map.ts:48-78](file://src/lib/relation-map.ts#L48-L78)

### CLI 用法
- ki search <query> [--scope <scope>] [--limit <n>] [--threshold <f>] [--tags <t1,t2>] [--original]

章节来源
- [src/search.ts:206-237](file://src/search.ts#L206-L237)