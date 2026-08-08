---
id: REQ-20260806-003
feature: 可视化前端界面
status: 设计中
created: 2026-08-08
updated: 2026-08-08
version: 1
tags: [feat, ux, design]
depends_on: [REQ-20260806-001]
author: AI
document_type: design
parent: design/DESIGN.md
---

# S-02：`/api/health` + `/api/doc/list` 路由

## 术语

| 术语 | 定义 |
|------|------|
| doctor 报告 | `runHealthCheck` 返回的结构化 `HealthReport`（health-check.ts:148） |
| Group 路径 | relations-cache 中 group 层级路径（`RelationMapEntry.group`） |
| 文档 | 文件级 relation（文件名去扩展名，`RelationMapEntry.relation`） |

## 现状（AS-IS）

- `src/lib/health-check.ts:148`：`runHealthCheck(config)` 返回 `HealthReport`，含 `items`/`fail`/`warn` 等结构化字段，现被 `doctor.ts` 与 `mcp-server.ts` 预检使用（文本渲染 `renderHealthReport`）
- `src/lib/relation-map.ts:48`：`getRelationMap(scope)` 返回 `Map<memoryId, RelationMapEntry>`（含 `group` + `relation`，带 TTL 缓存），供 `ki_search` 反查原文
- `src/lib/mcp-http.ts` `handleRequest`（mcp-http.ts:271）无 `/api/*` 分支，非 `/mcp` 一律 404

## 方案（TO-BE）

### 1. `/api/health`（GET）

**改 `src/lib/mcp-http.ts`**：`handleRequest` 加 `/api/*` 分支（S-01 分流后）。

接口契约：
```
GET /api/health
→ 200 { ok: true, report: HealthReport }
→ 500 { ok: false, error: string }   # runHealthCheck 内部异常
```

- 实现：`loadConfig()` → `runHealthCheck(config)` → 返回 `report`
- 复用既有 `runHealthCheck`，**不新增逻辑**；鉴权：回环免鉴权（与 `/healthz` 一致，走现有 authEnabled 判定）
- **超时（评审修复）**：`runHealthCheck` 含 zvec 探活可能较慢，用 `Promise.race` 包裹（10s 超时）；超时返回 `{ ok: true, report: { items: [{ name:'zvec', status:'warn', message:'探活超时' }], ... } }`，不阻塞总览页

### 2. `/api/doc/list`（GET）

接口契约：
```
GET /api/doc/list?scope=<scope>&q=<文件名关键词可选>
→ 200 {
    ok: true,
    scope,
    docs: [ { name, group, path? }, ... ],
    total
  }
→ 400 { ok: false, error }   # scope 非法
```

- `name`：文件名（relation 名，去扩展名）
- `group`：所属 Group 路径（v4 契约：**每个文档自带 Group 路径**）
- `path`：可选，sourcePath（相对路径，若有）
- `q`：对 `name` 做**模糊匹配**（不区分大小写子串匹配；空/缺省 = 全部）
- 排序：按 `group` 分组（前端按组渲染）

**实现**：
- 数据源：**直接读 relations-cache.json**（`getRelationsCachePath(scope)`，scope.ts），遍历 `groups[group].hot_relations[]`：
  - 文档名 = `rel.text`（文件级 relation 名，文件名去扩展名）
  - Group 路径 = `group`
  - 可选 `sourcePath` = `rel.sourcePath`（相对路径）
  - 去重：按 `group + rel.text` 去重（多 chunk 共享文件级 relation）
  - **不使用 `getRelationMap`**（它是 memoryId→{group,relation} 反查映射，仅覆盖有 memoryId 的向量化 relation，会漏掉 sync-relation 无 memoryId 数据）
- 模糊匹配：`name.toLowerCase().includes(q.toLowerCase())`
- 分页：默认 `limit=500`，超过截断（防大 scope 响应过大）
- **缓存（challenger 质疑修复）**：复用 `getRelationMap` 的 TTL+mtime/size 失效模式，实现 docList 专用缓存（模块级 Map<scope, {builtAt, mtimeMs, size, docs}>），避免高频文件名搜索每次全量读 JSON；文件变更（import/sync-relation）时 mtime/size 变化自动失效

### 3. 路由接入

`handleRequest` 分流后新增：
```ts
if (url.pathname.startsWith('/api/')) {
  await handleApiRequest(req, res, url);
  return;
}
```

`handleApiRequest` 内部按 pathname 分发：
- `/api/health` → GET health
- `/api/doc/list` → GET doc list
- `/api/import/*` → S-03

## 关键决策点

| 决策 | 选择 | 被否决方案 | 否决理由 |
|------|------|-----------|----------|
| `/api/doc/list` 数据源 | 直接遍历 relations-cache.json 的 `groups[].hot_relations[]` | ①`getRelationMap` 聚合 ②读 local KB 目录 | ①`getRelationMap` 是 memoryId→{group,relation} 反查（relation-map.ts:48），仅覆盖有 memoryId 的向量化 relation，漏掉 sync-relation 无 memoryId 数据且无 sourcePath ②local KB 是 `{relation: 原文}` map，无 Group 分组信息 |
| 空查询语义 | 返回全部文档按 group 分组 | 返回空提示 | v4 契约：空查 = 全部，有 q 才过滤 |
| 分页 | limit 上限 500 | 无上限 | 防大 scope 响应过大 |
| health 鉴权 | 复用现有 authEnabled | 独立鉴权 | 回环默认免鉴权，与 /healthz 一致 |

## 接口 Demo

```json
// GET /api/doc/list?scope=monitor&q=告警
{
  "ok": true,
  "scope": "monitor",
  "docs": [
    { "name": "告警收敛策略", "group": "告警收敛", "path": "docs/alarm/告警收敛策略.md" },
    { "name": "告警通知", "group": "告警通知", "path": "docs/alarm/告警通知.md" }
  ],
  "total": 2
}
```

```json
// GET /api/health
{
  "ok": true,
  "report": {
    "pass": true,
    "fail": 0,
    "warn": 1,
    "items": [
      { "name": "config", "status": "ok" },
      { "name": "embedding", "status": "ok" },
      { "name": "zvec", "status": "warn", "message": "zvec 集合未建" }
    ]
  }
}
```

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/lib/mcp-http.ts` | `handleRequest` 加 `/api/*` 分支；新增 `handleApiRequest`；`/api/health` + `/api/doc/list` 实现 |
| 新增依赖 | 无（复用 `runHealthCheck`/`getRelationMap`） |

## 待定问题

| 问题 | 说明 | 状态 |
|------|------|------|
| `HealthReport` 完整结构 | 需按 `health-check.ts` 类型确认字段（items 含哪些维度） | 技术评审确认 |

## 变更记录

- 2026-08-08 v1：初版
