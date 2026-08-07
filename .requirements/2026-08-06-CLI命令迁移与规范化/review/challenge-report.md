# 🎯 质疑审查报告（CLI 规范化 + P-7 chunk 上限）

> 关联需求：REQ-20260806-002（CLI命令迁移与规范化）+ REQ-20260806-001（P-7）
> 审查时间：2026-08-07
> 调用方：code-review 阶段 7（无阻塞项自动接力）

## 审查对象

- **代码变更**：CLI-01~08 规范化（13 文件 / 129 行净变更）+ P-7 `MAX_CHUNKS_PER_FILE` + 测试修复
- **类型**：优化 + 新增功能混合

## ⚔️ 反对意见

### 意见1（🔴 致命 → 已修复）：增量 chunk 超限导致数据静默丢失

- **反对理由**：`incremental.ts` 原 chunk 超限分支仅 `logWarn + continue`，但 `modified++` 计数器仍递增、`errors` 未记录、`source.commit` 无条件推进（原 435 行）。`git diff ${source.commit}..HEAD` 基线前移后，该文件变更被永久吞掉——**旧数据残留 + 新内容缺失 + 用户无感知**（不可观测 = 静默丢弃）
- **功能影响**：预期"modified 文件同步新内容" → 实际"文件停留在旧状态，下次增量不再检测"
- **修复**：超限分支 `logWarn + continue` → `errors.push` 记录（commit 仍推进防永久卡死，但用户可见失败项）
- **验证**：incremental-direct 3/3 全绿、lint 零错误

### 意见2（🟡 待确认）：doc/tag 改 resolveScope 与"管理命令绕过 strict"设计冲突

- **反对理由**：`vector-client.ts:464-467` 注释明确"管理命令（scope/doc）用 validateScope（仅字符安全）而非 resolveScope（会按 strict 白名单拒绝）"。本次 doc/tag 改 resolveScope 后，strict 模式下管理命令无法操作未注册 scope
- **功能影响**：strict 模式 `ki doc list <未注册scope>` 从"可操作"变"被拒"（默认模式零影响）
- **验证**：`vectorListDocs`(502)/`vectorListTags`(548) 内部有 validateScope 兜底 → 无路径遍历风险；仅 strict 白名单行为收窄
- **建议**：REQ-002 文档标注"strict 模式管理命令行为收窄"为有意决策；或按需保留旧行为

### 意见3（🟢 低）：query-group 错误路径 scope 输出不一致

- `query-group.ts:768` 成功路径 `result.scope`（已 resolve）、错误路径 `scope: opts.scope`（原始，省略时为 undefined）
- 影响：轻微输出不一致（原有行为，非本次引入）

### 意见4（🟢 低）：restore `--list` 与 `--from-snapshot` 组合语义未文档化

- `fromSnapshot` 分支优先，`--list` 被忽略——无破坏，帮助文本未说明优先级
- 建议：文档标注"`--list` 仅列表模式，与 `--from-snapshot`/`--rebuild-vector` 互斥"

## ✅ 认可点

1. chunk 上限双处防护（import full + incremental 直连）对称且提示友好
2. export `--yes` 非空目录拒绝 + `requireConfirm` + 修复提示；`detectUnknownFlags` 正确区分带值/布尔
3. resolveScope 统一后校验链完整（manage-index 双保险 / scan-kb 靠 ensureScopeDir 兜底）
4. 测试修复精准（模型 Qwen 对齐 + commit.gpgsign=false）

## 📊 风险与行动

| 风险 | 等级 | 处置 |
|------|------|------|
| 增量超限静默丢数据 | 🔴 高 | ✅ 已修复（errors 记录） |
| strict 模式管理命令收窄 | 🟡 中 | 待确认（建议接受为有意决策） |
| 错误路径 scope / --list 组合 | 🟢 低 | P2 可选 |

**总体风险**：🟡 中（🔴 已修复归零）

## 修复记录

| 项 | 修复 |
|----|------|
| 🔴 增量超限静默丢数据 | `incremental.ts` 超限分支记 `errors` |
| P2 restore 死代码 | 删除未使用 `listOnly` 变量 |
| P2 测试覆盖 | `chunker.test.ts` 补 `MAX_CHUNKS_PER_FILE` 契约用例（10/10） |
