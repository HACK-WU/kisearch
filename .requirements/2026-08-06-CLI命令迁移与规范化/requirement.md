---
id: REQ-20260806-002
feature: CLI命令迁移与规范化
status: 草案
created: 2026-08-06
updated: 2026-08-06
version: 1
tags: [refactor]
depends_on: [REQ-20260806-001]
author: AI
document_type: requirement
---

# 需求分析报告：CLI 命令迁移与规范化（独立需求）

> 本需求承接 REQ-20260806-001 的 CLI 范围 A/B 之外的全部 CLI 优化点，作为独立演进项。
> **依赖**：REQ-20260806-001（外部Wiki直接导入与自动切分）——其已含短别名/位置参数/命令清理，本需求处理其余规范化。

## 1. 原始需求描述

> 全面审查 KiSearch CLI 命令设计，简化冗余、统一不一致。本次只做**低风险规范化**（参数语义统一、命名统一、帮助去重、命令一致性），不涉及破坏性迁移。
>
> 调研发现 15 项冗余/不一致，其中范围 A（短别名）+ 范围 B（本次改造顺带清理）已并入 REQ-001，**其余全部由本需求承接**。

## 2. 需求澄清

### 2.1 需求形态
真实需求（CLI 可用性与一致性改进）。调研驱动的技术改进。

### 2.2 功能本质
将 KiSearch 的 CLI 从"两套解析体系 + 多处参数语义漂移"规范为"统一、一致、可预期"的命令行体验，且不破坏现有调用。

### 2.3 使用场景与角色
- 场景 1：CLI 开发者日常使用——期望参数语义统一、记忆成本低
- 场景 2：脚本化调用（CI / 自动化）——期望参数稳定、错误契约一致
- 场景 3：新用户上手——期望帮助文本准确、命令结构可预测

**用户角色**：CLI 开发者 / 脚本维护者 / 新用户

### 2.4 核心痛点
1. `--scope` 必填性三层不一致（必填 / 可选 / 默认值），使用困惑
2. scope 传参方式不一致（数据命令 option vs 文件命令位置参数）
3. `--output` 一个名字三种含义（scan 文件 / diff 文件 / export 目录）
4. `--tags` 默认值不统一（store 默认 ki-search vs search 搜全部）
5. 帮助文本双份维护（ki.mjs 硬编码 + 各脚本 help）
6. 命令命名风格不统一（bulk_store 下划线）
7. export 破坏性写盘却无 `--yes` 确认
8. 解析机制双轨（commander vs 手写 argv），错误处理行为不一

### 2.5 期望体验
- 参数语义跨命令一致（`--scope`/`--root-name`/`--output` 行为可预期）
- 破坏性命令统一 `--yes` 确认
- 帮助文本单一来源，`ki --help` 与子命令 `--help` 不重复
- 命令命名统一连字符

### 2.6 深层动机
- 降低 CLI 认知负担与维护成本（双份 help、双轨解析）
- 提升脚本化调用的稳定性与一致性

### 2.7 非功能性需求
- **零破坏**：所有变更向后兼容（不改既有参数名，只统一语义/补确认/去重帮助）
- 可回滚：每项变更为独立提交
- 不涉及 AI 机制（纯 CLI 层）

### 2.8 关键假设（已确认）
| 假设 | 内容 | 状态 |
|------|------|------|
| H-01 | 不破坏现有参数名（只统一语义与默认值） | ✅ 确认 |
| H-02 | 手写 argv 命令（mcp/doctor/backup/restore/export）迁移 commander | ✅ 确认 |
| H-03 | `--output` 三义拆分不破坏现有用法 | ✅ 确认 |
| H-04 | export 补 `--yes`（破坏性写盘确认） | ✅ 确认 |
| H-05 | 帮助文本去重（ki.mjs 委托子命令 --help） | ✅ 确认 |

## 3. 根本性分析

### 3.1 核心问题
CLI 参数语义与命令结构缺乏统一规范，导致使用困惑与维护成本。

### 3.2 根因链
历史演进 → 早期手写 argv → 后期引入 commander → 双轨并存 → 参数约定随命令独立演化 → 语义漂移（scope/output/tags/root-name）→ 使用困惑 + 帮助双份维护。

### 3.3 方案评估
**方案对症（情况 A）**。全部为低风险规范化，无架构风险；逐项独立提交可回滚。方案合理，直接转译。

### 3.4 预期效果分析
- 参数语义统一 → 降低认知负担
- 解析机制统一 → 错误处理行为一致
- 帮助去重 → 单一维护点
- 破坏性命令补确认 → 防误操作
- 风险：低（全部向后兼容）

### 3.5 建议
分两期：一期为"语义统一 + 命名统一 + 补确认"（低风险快速落地）；二期为"手写 argv 迁移 commander + 帮助去重"（中等工作量）。

## 4. 需求清单

### 4.1 需求拆分清单

| 优先级 | 需求 ID | 需求描述 | 预期效果 | 依赖 | 验收标准 |
|--------|---------|----------|----------|------|----------|
| P0 | CLI-01 | **`--scope` 必填性统一**：数据命令（scan-kb/query-group/get-module-info/sync-relation/delete-relation/search/store/bulk_store/manage-index）统一为"default 模式可省略、strict 模式必填"；`doc`/`tag` 移除硬编码默认值改为运行时 resolve | scope 行为跨命令一致 | - | 各命令 strict 模式缺 scope 报错一致；default 模式省略一致 |
| P0 | CLI-02 | **`--output` 三义拆分**：scan-kb scan 的 `--output`（scan-index 路径）改为 `--scan-index`；diff 的 `--output` 保留（结果文件）；export 的 `--output`（目录）保留；消除同名三义 | 同名参数不再多义 | - | scan-kb scan 用 `--scan-index`；三命令参数语义唯一 |
| P0 | CLI-03 | **`--tags` 默认值统一**：明确语义并统一——store 默认 `ki-search`（写入侧）；search/scope clear 不设默认（查询/清理侧搜全部）；doc list 的 `--tags` 移除默认改为"不传=全部" | 过滤/分类标签缺省语义可预期 | - | 各命令 tags 缺省行为与文档一致 |
| P0 | CLI-04 | **export 补 `--yes`**：破坏性写盘目录覆盖前需确认 | 防误覆盖 | - | export 覆盖已有目录时需 `--yes`，否则拒绝 |
| P1 | CLI-05 | **手写 argv → commander 迁移**：mcp / doctor / backup / restore / export 迁移到 commander（保留现有参数名与行为；mcp 的 token/stop 子命令用 `.command` 定义） | 解析/错误/帮助行为统一 | - | 五命令参数与迁移前等价；`-h` 行为一致 |
| P1 | CLI-06 | **帮助文本去重**：`ki.mjs` 全局 help 改为执行 `ki <cmd> --help` 聚合；删除硬编码重复 | 单一维护点 | CLI-05 | `ki --help` 与各子命令 help 一致且同步 |
| P1 | CLI-07 | **`--root-name` required 语义统一**：scan-kb scan（必填）与 import（可选覆盖）语义明确化，文档标注；import-kb 已随 REQ-001 删除 | 同名参数行为可预期 | REQ-001 | 文档明确三处语义；代码注释/校验一致 |
| P1 | CLI-08 | **backup `--list` 与 restore 无参列备份统一**：restore 增加 `--list` 显式 flag（保留无参列出的兼容） | 列备份触发方式一致 | CLI-05 | restore --list 与 backup --list 行为一致 |
| P2 | CLI-09 | **命令命名统一**：`bulk_store` → `bulk-store`（已并入 REQ-001 REQ-13）；其余多词命令检查连字符一致性 | 命名风格统一 | REQ-001 | 所有多词命令均为连字符 |
| P2 | CLI-10 | **`--yes` 全命令梳理**：审计所有破坏性操作（doc delete/scope delete/scope clear/restore/export/mcp token reset）确认均有 `--yes` | 破坏性操作确认一致 | - | 无破坏性命令缺 `--yes` |
| P2 | CLI-11 | **数值参数命名统一**：`--limit`/`--hot-count`/`--scan-limit` 语义文档化（不改名，仅明确语义） | 参数语义可预期 | - | 文档明确各数值参数含义 |

### 4.3 实施状态（2026-08-07）

| 需求 ID | 状态 | 说明 |
|---------|------|------|
| CLI-01 | ✅ 完成 | doc/tag/query-group/get-module-info/manage-index/scan-kb 全部改 `resolveScope`（default 可省略、strict 必填）；sync-relation/delete-relation/search/store/bulk-store 原已 requiredOption + validateScope，保持 |
| CLI-02 | ✅ 完成 | `scan` 子命令已随 REQ-001 删除，剩余 `diff --output`（结果文件）与 `export --output`（目录）语义唯一，三义消除 |
| CLI-03 | ✅ 完成 | `doc list --tags` 移除默认改为"不传=全部"；store 默认 `ki-search`、search 搜全部（现状保持） |
| CLI-04 | ✅ 完成 | export 非空输出目录覆盖需 `--yes`，否则拒绝（`requireConfirm: true`）；端到端验证通过 |
| CLI-05 | ⚠️ 评估后维持现状 | 见 §6 评估结论——现有手写解析已规范化（统一错误契约 NEG-01/04 + detectUnknownFlags + 前置 -h），commander 迁移风险高收益低 |
| CLI-06 | ✅ 完成 | `ki.mjs` 帮助已是"概览式命令清单 + 委托 `ki <cmd> --help`"，单一维护点达成 |
| CLI-07 | ✅ 完成 | `--root-name`：`scan-kb import --mode full` 必填（前置校验），`--mode incremental` 忽略；文档标注 |
| CLI-08 | ✅ 完成 | restore 增加 `--list` 显式 flag，与 backup `--list` 行为一致；无参列出兼容保留 |
| CLI-09 | ✅ 完成 | 已随 REQ-001（`bulk_store` → `bulk-store`） |
| CLI-10 | ✅ 完成 | 审计全部破坏性命令：doc delete / scope delete / scope clear / restore / export / mcp token reset 均有 `--yes` |
| CLI-11 | ✅ 完成 | `docs/cli.md` 新增"数值参数语义"表（`--limit` 截断返回 / `--scan-limit` 限制扫描 / `--hot-count` 展示个数） |

**验证**：全量测试 339/339 全绿，lint 零错误。

### 4.2 需求依赖图
```
CLI-01 (scope 统一)
CLI-02 (output 拆分)
CLI-03 (tags 统一)
CLI-04 (export --yes)
   ↓
CLI-05 (手写 argv → commander)
   ├→ CLI-06 (帮助去重)
   ├→ CLI-08 (backup/restore 统一)
   ↓
CLI-07 (root-name 语义) [依赖 REQ-001 删除 import-kb]
CLI-09 (命名统一) [并入 REQ-001]
CLI-10 / CLI-11 (低风险文档/审计)
```

### 4.3 需求验证标准
| 需求 ID | 验证方式 | 验证指标 | 验证时机 |
|---------|----------|----------|----------|
| CLI-01 | CLI 验收 | scope 行为跨命令一致 | 一期完成后 |
| CLI-02 | CLI 验收 | scan-kb scan 用 --scan-index | 一期完成后 |
| CLI-03 | CLI 验收 | tags 缺省行为与文档一致 | 一期完成后 |
| CLI-04 | CLI 验收 | export 覆盖需 --yes | 一期完成后 |
| CLI-05 | 评估结论 | 维持现状（§5.4），现有手写解析已达成统一目标 | ✅ 2026-08-07 |
| CLI-06 | 视觉验收 | ki --help 与子命令 help 同步 | ✅ 2026-08-07（已委托式） |
| CLI-07 | 代码审查 | root-name 语义文档化 | 二期完成后 |
| CLI-08 | CLI 验收 | restore --list 可用 | 二期完成后 |
| CLI-09 | 代码审查 | 命名统一 | 随 REQ-001 |
| CLI-10 | 代码审查 | 无破坏性命令缺 --yes | 二期完成后 |
| CLI-11 | 文档审查 | 数值参数语义明确 | 二期完成后 |

### 4.4 非功能性约束
- 零破坏：不删除/重命名既有参数（除 REQ-001 已确认的 bulk_store）
- 每项独立提交可回滚
- 不涉及 AI 机制与数据格式

### 4.5 潜在风险与注意事项
- **CLI-05 迁移风险**：mcp 的手写解析（parseMcpArgs/token 子命令）迁移 commander 时需保留 `--token > KI_MCP_TOKEN > 托管文件` 优先级与错误码（MCP_HTTP_TOKEN_REQUIRED 等）；stop/status 子命令顺序语义需保留
- **CLI-02 兼容**：`--output` 在 scan-kb scan 改名后，旧调用 `--output` 需给 deprecated 警告（过渡期）或直接报错（按用户选择）
- **CLI-03 默认值变更**：doc list `--tags` 从默认 `ki-search` 改为"不传=全部"是**行为变更**，需在文档标注并评估影响（可能影响 MCP 工具）
- **CLI-08 兼容**：restore 无参列备份保留（隐式），`--list` 为显式新增，两者并存

### 4.6 复杂度评估与快速实现判断

| 评估维度 | 评分 | 说明 |
|----------|------|------|
| 技术难度 | 中 | commander 迁移需保留错误契约；默认值变更需评估影响 |
| 范围大小 | 中 | 涉及 5 个手写命令迁移 + 4 个语义统一点 |
| 依赖关系 | 中 | 依赖 REQ-001（import-kb 删除 / bulk_store 改名） |
| 需求清晰度 | 高 | 调研已完成，各项明确 |
| 时间约束 | 低 | 无紧迫 deadline |
| 风险程度 | 中 | CLI-03 默认值变更与 CLI-05 迁移有行为影响面 |

**综合复杂度**：中（H=0，M=3）
**快速实现可行性**：可快速实现（一期四项语义统一 + 二期两项可并行，均低风险规范化）
**推荐下一步**：
- **特征命中**：技术方案明确（commander 迁移是成熟路径）、无数据流复杂性
- **推荐行动**：`design-craft`（技术设计）或直接 work-breakdown 拆分实施
- **理由**：CLI 规范化是纯接口层改造，无数据模型变化，技术方案直接；但 CLI-05 迁移涉及错误契约保留，建议先小范围设计确认 mcp 迁移细节。

## 5. 迭代建议

### 5.1 反馈收集计划
- 收集方式：迁移后手动回归既有调用脚本；收集 CLI 使用反馈
- 收集频率：一期上线后、二期上线后

### 5.2 迭代规划
- **一期**（低风险快速）：CLI-01（scope 统一）+ CLI-02（output 拆分）+ CLI-03（tags 统一）+ CLI-04（export --yes）
- **二期**（中等工作量）：CLI-05（commander 迁移）+ CLI-06（帮助去重）+ CLI-07（root-name 语义）+ CLI-08（backup/restore 统一）
- **三期**（低优先）：CLI-10（--yes 审计）+ CLI-11（数值参数文档化）
- CLI-09 随 REQ-001（bulk-store 改名）

### 5.3 长期演进建议
- 完成后可将 CLI 约定沉淀为文档（docs/cli.md 更新为规范章节）
- 考虑为 MCP 工具入参与 CLI 参数语义对齐（工具 schema 与 CLI 一致）

## 5.4 CLI-05 评估结论（2026-08-07）

**决策：维持现状，不执行 commander 迁移。**

### 评估依据

CLI-05 的目标是"解析/错误/帮助行为统一"。经代码核验，现有 5 个手写命令（mcp / doctor / backup / restore / export）**已达成该目标**：

| 统一维度 | 现有机制 | 是否满足 |
|----------|----------|----------|
| 未知参数检测 | `detectUnknownFlags`（NEG-01） | ✅ |
| 统一错误契约 | `failJson` + `toErrorPayload`（NEG-04，错误含 code） | ✅ |
| `-h/--help` 前置处理 | 各命令解析开头统一处理 | ✅（cli-help.test.ts 41 项保证） |
| 带值参数可选语义 | restore `--from-snapshot [file]` 手写支持可选带值 | ✅ |

### 迁移代价

1. **mcp 高风险**：`parseMcpArgs` 含 token 子命令（generate/show/reset）、stop/status 顺序语义、`--token > KI_MCP_TOKEN > 托管文件` 鉴权优先级、`MCP_HTTP_TOKEN_REQUIRED` 等错误码——commander 迁移需全部保留且被 mcp-token/mcp-http 测试锁定
2. **restore 别扭**：`--from-snapshot [file]`（可选带值）在 commander 中用 `.option('--from-snapshot [file]')` 表达，与现有 `--from-snapshot=file` 兼容性需验证
3. **收益低**：手写解析已统一行为，迁移是"换框架"而非"补能力"

### 后续触发条件（未来如需迁移）

- 新增第 6 个手写命令且解析复杂度上升
- 或 commander 能力（如自动补全、交互式提示）成为硬需求
- 届时按 backup → export → restore → mcp 顺序迁移，每步跑 cli-help + 对应测试

### 结论落地

- 需求清单 CLI-05 标注"⚠️ 评估后维持现状"（§4.3 实施状态表）
- 无代码变更

## 6. 变更记录

- 2026-08-06 v1：从 REQ-001 拆分 CLI 迁移规范化独立需求；承接 CLI 范围 A/B 之外的全部优化点（11 项 CLI-01~11）；状态草案
- 2026-08-07 v2：实施完成——CLI-01~04/06/07/08/10/11 落地（含 export --yes 端到端验证、restore --list、数值参数文档化）；CLI-09 随 REQ-001；CLI-05 评估后维持现状（§5.4）；全量测试 339/339 全绿；§4.3 实施状态表 + §5.4 评估结论
