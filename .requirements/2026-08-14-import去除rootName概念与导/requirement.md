---
id: REQ-20260814-001
feature: import去除rootName概念与导出回收站改造
status: 已确认
created: 2026-08-14
updated: 2026-08-14
version: 1
tags: [refactor]
depends_on: []
author: AI
document_type: requirement
---

# 需求挖掘报告：import 去除 rootName 概念 + export/delete 语义改造

## 1. 原始需求描述

1. import 目录时不传 `--group`，按子目录名各建根节点；文档导入缺省 group=scope name。
2. 全面移除 rootName 概念，wiki 回写只看 sourceDir。
3. export `--root-name` 改为 `--group`（路径值），父目录名取 group 最后一段，不传则全量导出、默认名 scope name。
4. delete 增加回收站，文档/目录移入回收站而非物理删除。

## 2. 需求澄清

### 2.1 需求形态

真实需求。消除 `rootName`（=`--group` 根前缀）冗余概念，让 import 落点语义与 `sync_relation` 对齐（group 第一段即根节点）。

### 2.2 功能本质

- import 缺省 `--group` 时自动推断根节点（目录→顶层子目录名各为根；单文档→scope name）。
- 全面移除 rootName，wiki 回写简化为 `{sourceDir}/{group}/{relation}.md`。
- export 按 group 路径筛选导出；delete 增加回收站。

### 2.3 使用场景与角色

- 场景 1（目录导入，缺省 --group）：`--source <dir>` 下各子目录名各为根节点。
- 场景 2（单文档导入，缺省 --group）：`--source doc.md`，group=scope name。
- 场景 3（显式 --group）：保留现状（统一根前缀）。
- 场景 4（export）：`--group A/B` 导出 A/B 下文档，父目录名=B；不传全量导出，顶层名=scope name。
- 场景 5（delete）：删除文档/目录移入 `.trash`。

角色：开发者 / 知识库维护者（CLI 使用者）。

### 2.4 核心痛点

每次 import 手动指定 `--group` 根前缀；rootName 概念迫使 group 路径、source 块、wiki 回写三处维护"前缀剥离"逻辑。

### 2.5 期望体验

`import --source <dir>` 一步到位，目录结构自动映射为根节点。

### 2.6 深层动机

统一 import 与 sync_relation 的 group 语义，数据目录（sourceDir）成为唯一事实来源。

### 2.7 关键假设（已全部确认）

| 假设 | 结论 |
|------|------|
| H-01 `--group` 显式传入保留原语义 | ✅ K1 确认 |
| H-02 顶层 .md 归 scope name 根 | ✅ K2=a |
| H-03 全面移除 rootName | ✅ K3=全面改动 |
| H-04 export 父目录名=group 最后一段 | ✅ 理解 A |
| H-05 export 参数改名 --group | ✅ 确认 |
| H-06 回收站：sourceDir/.trash、支持目录+文档、保留结构 | ✅ E1/E2/E3 确认 |

## 3. 根本性分析

### 3.1 核心问题

rootName 是 import 专属冗余抽象，与 sync_relation"group 第一段即根"语义不一致。

### 3.2 根因链

历史演进中 import 采用"建新根 + full/incremental 双模式"，rootName 承载"根前缀"角色；后改幂等追加、废弃 incremental，rootName 概念未同步清理。

### 3.3 方案评估（情况 A：方案对症）

移除 rootName 后 group 即完整路径，目录结构即根节点，与 sync_relation 统一，回写简化为 sourceDir+group。

### 3.4 建议

- 短期：本方案（移除 rootName + 缺省推断根节点）。
- 长期：group 语义统一后可考虑 `ki scan-kb import` 扁平化为 `ki import`（历史遗留，暂缓）。

## 4. 需求清单

### 4.1 需求拆分清单

| 优先级 | 需求 ID | 需求描述 | 依赖 | 验收标准 |
|--------|--------|----------|------|----------|
| P0 | REQ-01 | `--group` 可选；目录缺省按顶层子目录名各建根（多根，不存在自动建） | - | import 后 group-index 顶层=各子目录名 |
| P0 | REQ-02 | 单 .md 导入（放开 isDirectory 校验），缺省 group=scope name | REQ-01 | 单文档导入成功，group=scope name |
| P0 | REQ-03 | 目录根下顶层 .md（不在子目录）缺省归 scope name 根 | REQ-01 | 顶层 .md 落在 scope name 根 |
| P0 | REQ-04 | 全面移除 rootName：scope.ts source 块、config 字段、getScopeRootName、progress.ts 死代码 | - | 无 rootName 残留，tsc 0 error |
| P0 | REQ-05 | wiki 回写只看 sourceDir：`{sourceDir}/{group}/{relation}.md`，不去前缀 | REQ-04 | sync 后文件在 sourceDir 对应 group 路径 |
| P0 | REQ-08 | export `--root-name` 改名为 `--group`，传 group 路径值只导该路径下文档 | REQ-04 | `--group A/B` 导出 A/B 下全部文档 |
| P0 | REQ-09 | export 父目录名=group 最后一段；不传 `--group` 全量导出、顶层名=scope name | REQ-08 | 导出目录结构正确 |
| P0 | REQ-12 | export 父目录同名冲突 → 停止导出并反馈（fail-loud） | REQ-09 | 冲突时报错退出 |
| P0 | REQ-10 | delete 增加回收站：文档/目录移入 `sourceDir/.trash/`（保留原结构，重名追加时间戳） | REQ-04/05 | 删除后文件在 .trash 对应路径 |
| P0 | REQ-13 | 移入回收站后 cache 与向量仍删除（只保留 wiki 文件） | REQ-10 | cache/向量清理，wiki 文件进回收站 |
| P0 | REQ-11 | delete 支持目录级删除，连带删除 group-index 树节点 | REQ-10 | 删除 group 目录 + 树节点 |
| P1 | REQ-06 | `--group` 显式传入 import 保留原"统一根前缀"语义 | REQ-01 | `--group wiki` 行为不变 |
| P1 | REQ-07 | delete-relation findWikiFile 去 rootName 前缀逻辑 | REQ-04 | 删除定位正确 |

### 4.2 需求依赖图

```
REQ-04 (移除 rootName)
   ├─→ REQ-05 (wiki 回写简化)
   ├─→ REQ-07 (delete 定位去前缀)
   └─→ REQ-08 (export --group 改造)

REQ-01 → REQ-02 / REQ-03 / REQ-06

REQ-08 → REQ-09 → REQ-12 (export 父目录命名 + 冲突保护)

REQ-10 → REQ-11 (目录级删除)
REQ-10 → REQ-13 (cache/向量清理边界)
```

**功能重叠**：REQ-02 与 REQ-03 同属"缺省 group 推断"分支，合并实现。

## 5. 复杂度评估与可行性

- **综合复杂度：中**（H=0，M=2）——跨 8+ 文件（import/scan-kb/scope/config/export/wiki-sync/delete-relation/progress），含 group 推断、回收站、目录级删除、export 命名规则等多模块改动。
- **快速实现可行性：不可快速实现**，建议先技术设计（design-craft）。
- **可行性结论：可行**，无硬性障碍，所有 rootName 引用点已定位。

## 6. 潜在风险与注意事项（含决策）

1. **export 父目录同名冲突** → 停止导出并反馈（fail-loud）。注意：不同 group（`X/Y` 与 `Z/Y`）导出到同名 `Y/` 会触发此保护。
2. **回收站重名** → 追加时间戳。
3. **移入回收站后 cache 与向量** → 仍删除，只保留 wiki 文件进回收站。
4. **目录级删除 group-index 节点** → 连带删除（保留无意义）。
5. **export 不传 --group 全量导出** → 顶层名=scope name，与"父目录=group 最后一段"是两套命名规则，需统一实现。
6. **单文件导入放开 isDirectory 校验** → collectMarkdownFiles 需新增单文件分支。
7. **幂等语义** → 缺省推断的根节点需稳定（目录名/scope name 天然稳定，风险低）。
8. **旧数据** → 无需迁移，重新 import 即可（用户明确）。

## 7. 涉及文件（rootName 引用点）

- `src/lib/import.ts`（setSource 写 rootName）
- `src/scan-kb.ts`（import CLI）
- `src/lib/scope.ts`（GroupIndexSource.rootName、getSource/setSource 校验）
- `src/lib/config.ts`（getScopeRootName、scopes.<scope>.rootName 字段）
- `src/config.ts`（模板注释）
- `src/export.ts`（--root-name 参数）
- `src/lib/wiki-sync.ts`（去 rootName 前缀）
- `src/delete-relation.ts`（findWikiFile 去前缀）
- `src/lib/ai-results.ts`（deriveGroupPath 注释）
- `src/lib/progress.ts`（死代码，含 rootName）
