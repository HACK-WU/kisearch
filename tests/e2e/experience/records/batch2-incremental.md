# 体验记录 Batch2：增量直连链路

> **体验基线 commit**：`2548d73c3e60266803bf3f43fb41facddc0cc711`（体验执行时 HEAD；本记录中 P1/P2 体验修复为基线后未提交改动，涉及 `src/lib/incremental.ts`）

## 结论：6/7 通过，2 项体验问题（1 已修复）

| # | 体验点 | 类型 | 结果 | 实际反馈 | 评价 |
|---|--------|------|------|----------|------|
| 1 | 无变更增量 | 正向 | ✅ | `base=head=52f3d6a5 added=0/0/0` + 4 阶段进度 + 完整统计 | 明确非静默 |
| 2 | 同文件再改 | 正向 | ✅ | modified=1，memoryId 每次更新（90609e76→d233e32e），旧向量清理 | 幂等正确 |
| 3 | 增量超大文件跳过 | 边界 | ⚠️→✅ | 修复前 errors=0（静默）；修复后 errors=1 + "文件过大已跳过…旧数据保留" | **已修复** |
| 4 | 大量删除 | 边界 | ⚠️ | 删除未导入文件报 `deleted 文件未关联 memoryId`（误报为 error） | 待确认 |
| 5 | 未首导增量 | 负面 | ✅ | 明确报错引导（Batch1 复验） | 引导明确 |
| 6 | 文件重命名 | 边界 | ✅ | R→deleted=1+added=1，renamed-01 正确、new-01 消失 | 无残留 |
| 7 | 增量后检索 | 正向 | ✅ | renamed-01 召回、huge 零命中、new 旧名不命中 | 终态一致 |

## 🟡 发现问题

### P1：增量超大文件跳过静默（已修复）
- **现象**：`incremental.ts` 超大文件分支 `logWarn + continue`，errors 不记录 → 结构化输出完全无感知，commit 推进后该文件永久不同步
- **修复**：改为 `errors.push`（与 challenger 修复的 chunk 超限一致）
- **验证**：stats.errors=1 + 明确错误信息 ✅

### P2：删除"从未导入"文件误报 error（待确认）
- **现象**：删除超大文件（上一轮因过大被跳过、无 memoryId）时，报 `deleted 文件未关联任何 memoryId（可能未导入过或 cache 缺失）`——计入 errors
- **分析**：该文件**从未成功导入**，删除属"无事可做"。报 error 过于严重（污染错误统计），应为"信息级提示"（无害跳过）
- **影响**：低（正确性无影响，错误分类过严）
- **建议**：deleted 无 memoryId 时降级为 logWarn/信息（不入 errors），除非确认 cache 损坏

## ✅ 修复已确认（2026-08-07）

### P1：增量超大文件跳过静默 → 已修复
- `incremental.ts` 超大文件分支改 `errors.push`（"文件过大已跳过…旧数据保留。可手动切分后导入"）
- 验证：stats.errors=1 + 明确错误 ✅

### P2：删除"从未导入"文件误报 error → 已修复
- deleted 无 memoryId 分支从 `errors.push` 降级为 `logWarn`（`[delete skip] 未关联 memoryId…跳过删除`）
- 验证：从未导入文件删除 → 信息提示 + errors=0；正常文件删除 → deleted=1/errors=0 不受影响 ✅

## 结论
Batch2 全部体验点闭环：7/7（含 2 项体验问题修复）。incremental-direct 3/3 + lint 零错误。

## 下一步
- 体验验证全部完成，可出体验报告总结
