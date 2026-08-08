# Demo 验证报告：方案 D（local KB 与向量一对多 + 数据清洗）

> 验证时间：2026-08-08
> 验证对象：REQ-06（数据清洗 + local KB 与向量一对多）、REQ-08（格式检查与大小限制）
> 验证方式：mock 向量层端到端脚本（`.demo-verify/demo-main.mjs`，确定性 memoryId = sha256 前缀），不依赖真实 embedding API
> 验证性质：**已验证**（实际运行 node 脚本，15/15 断言通过）

## 1. 验证目标

方案 D 是数据模型级重构（local KB 存文件级原文 ↔ 向量 chunk 一对多），在投入完整开发前验证 5 个核心风险点。

## 2. 风险点验证结果

| 编号 | 风险点 | 结论 | 验证证据 |
|------|--------|:----:|---------|
| R-01 | local KB 文件级原文 + relation-cache `memoryIds` 多值 | ✅ 通过 | 一个文件一条记录（key=文件级 relation）；多 chunk 文件 `memoryIds.length === chunk 数`；local KB 存完整原文 |
| R-02 | relation-map 多值聚合 + 原文召回去重 | ✅ 通过 | 任一 chunk memoryId 反查同一文件级 relation；命中 2 chunk → Set 收敛为 1 条原文 |
| R-03 | `buildMemoryIdMap` 字段直读与旧 `#N` 前缀聚合等价 | ✅ 通过 | 字段直读（文件级 key → memoryId[]）与 legacy 聚合（chunk 级 sourcePath 按 `#` 前缀聚合）输出集合一致（去重后） |
| R-04 | 清洗只作用于向量化（local KB 原文 vs chunk 清洗后） | ✅ 通过 | local KB 保留 BOM/frontmatter/mermaid/路径（原文）；向量化输入无 BOM/frontmatter/mermaid；空 chunk 过滤 |
| R-05 | relation 冲突跳过 + 非 md 跳过 | ✅ 通过 | 不同 group 同名文件不冲突；同 group 冲突 → 跳过 + 反馈；非 md 文件（.txt/.pdf/.png/.py）全跳过 + 汇总提示 |

## 3. 验证中发现的实现注意点

1. **`buildMemoryIdMap` 需去重**：demo 中同一文件多个 chunk 内容相同（构造数据）会生成相同 memoryId。真实 `diff.ts:107` 已有 `if (!list.includes(...))` 去重——**字段直读实现必须保留该去重语义**，避免 `memoryIds` 含重复 id。
2. **`memoryIds` 与 chunk 数一致性**：多值数组长度 = 清洗后实际 chunk 数（空/近空 chunk 过滤后），进度分母应以清洗后为准（REQ-05 O-01）。
3. **mock 向量层可复用**：确定性 memoryId（内容相同 → id 相同）验证了 modified 场景下"内容未变时新旧 id 相同可跳过删除"的前提，与 `incremental.ts:411` 的 `okIds.includes(oldId)` 逻辑兼容。

## 4. 决策建议

**✅ 继续进入完整开发。**

五个风险点全部通过，方案 D 数据模型（文件级原文 + `memoryIds` 多值 + 召回去重）端到端可行。清洗规则、切分、relation 冲突处理、格式/大小限制均按设计工作。

## 5. 遗留（不属于 demo 范围，开发时处理）

- 真实 embedding API 的批量向量化行为（mock 已验证数据流，真实 embedding 属已验证基线）
- 增量 modified/deleted 链路与 `memoryIds` 字段的完整集成（demo 覆盖了 buildMemoryIdMap 等价性，完整增量链路回归在开发测试阶段）
- 非 TTY 进度输出、SIGINT/SIGTERM 中断处理（REQ-01/05，与方案 D 正交）
