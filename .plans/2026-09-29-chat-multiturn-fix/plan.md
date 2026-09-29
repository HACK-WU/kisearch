---
task: 多轮上下文修复的 code review 问题修复
status: 已完成
created: 2026-09-29
updated: 2026-09-29
related: REQ-20260924-001（SR-01 后端检索与生成链）
---

# 执行计划：多轮上下文修复的 code review 问题修复

## 目标
把 code review 在「多轮上下文重复 user 修复」变更上发现的 P1 问题清零，并让两处共享不变量的耦合有注释与测试守护；回归全绿。

## 完成判据
- [x] `npm run test:chat` 全绿（含新增的降级路径上游形状用例）→ 9 文件 **103 断言 0 失败**
- [x] 后端 `node_modules/.bin/tsc -p tsconfig.json --noEmit` 退出码 0
- [x] 真实链路 e2e `tests/e2e/journey-sidebar-ai-chat.mjs` 13/13 PASS（4m36s，`/tmp/ki-journey2.log`）
- [x] `tool-loop.ts` 中「末条 = 本轮 user」这一共享不变量在**两处**均有交叉引用注释（守卫处 + 降级路径 splice 处）
- [x] `grep -rn "DEBUG-TRACE" src/ test/` 无输出

## 注意事项（执行护栏）
| # | 注意事项 | 来源 | 违反后果 |
|---|----------|------|----------|
| 1 | 不得放宽或改动任何既有测试的断言语义（只允许**新增**覆盖） | 上游 slice.md「不得修改片级验收测试的断言」 | P0：把真缺陷改成绿色通过 |
| 2 | 不得让生产代码（`src/**`）引用 `.delivery/mocks/**` 或任何测试脚手架 | 项目约定（生产代码不得引用 mock） | P0：交付物夹带测试脚手架 |
| 3 | 含明文密钥的文件（`config.dev.yaml`、`.env.e2e`）不得进入 git 暂存区或提交 | 已知坑（本次已误暂存过一次，靠 `git restore --staged` 挽回） | P0：密钥泄露入库 |
| 4 | 不得修改 SR-01/SR-02 的 `verify/run.sh` 与片级验收资产 | 上游文档（片级冻结资产） | P1：越界修改他人冻结资产 |
| 5 | 临时插桩 / 探针脚本 / mock 配置用完必须清理 | 任务自身高危面（调试留痕入库） | P1：调试代码长期留在仓库 |

## 工作项
| # | 工作项 | 状态 | 证据 | 备注 |
|---|--------|------|------|------|
| 1 | 补两处共享不变量的交叉引用注释（守卫处 + 降级路径 splice 处） | 已完成 | `tool-loop.ts:140-152` 守卫注释（含"末条恒为本轮 user"不变量 + 指向下方 splice + 指向测试）· `tool-loop.ts:452-456` splice 处反向引用 · `grep -n "不变量" src/lib/chat/retrieval/tool-loop.ts` 两处命中 | 守 #1（未改任何既有断言） |
| 2 | 新增 `runPreRetrievalFallback` 的上游 messages 形状用例（含 splice 位置与"本轮 user 恰好一次"） | 已完成 | `npx jiti test/chat/multi-turn-context.test.ts` → **7 pass / 0 fail**（新增 1 条 `describe('多轮上下文 · 降级路径…')`） | 守 #2（测试不引 mocks）· 实测发现 `!retrievalOk` 分支不易触发，改为对两支都成立的结构性断言 |
| 3 | 补守卫的"内容等值比较"限制说明（无法覆盖的边界形态） | 已完成 | `tool-loop.ts:147-151` 新增「已知限制（可接受）」段 | - |
| 4 | 回归：test:chat + 后端 typecheck + 真实链路 e2e | 已完成 | ✅ `npm run test:chat` → 9 文件 **103 断言 0 失败**；✅ `tsc -p tsconfig.json --noEmit` → exit 0；✅ e2e 最终 **13/13 PASS**（4m36s，`/tmp/ki-journey2.log`）；⚠️ 4 次复跑中 1 次 `qa_miss` 抖动失败（详见 `tests/e2e/journey-sidebar-ai-chat-report.md` 复跑记录） | e2e 为真实模型，存在非确定性；已如实记录未确证 |
| 6 | 修 harness 自身缺陷：SSE 补客户端超时（流卡住不再静默挂起） | 已完成 | `tests/e2e/journey-sidebar-ai-chat.mjs` 新增 `withTimeout`（`AbortSignal.timeout(180s)`，`sseStream`/`ssePatch` 各接一处）；实测一次挂起被兜住 | 执行中发现，追加为工作项 |
| 5 | 输出 code review 报告（含未修项与理由） | 已完成 | `.plans/2026-09-29-chat-multiturn-fix/review-report.md`（含 P1-3/P1-4 未修项与建议路径） | 需求库不在本 worktree，偏离见下 #2 |

## 决策与偏差
| # | 事项 | 决策 / 偏差 | 原因 |
|---|------|------------|------|
| 1 | review 并行派发（task-dispatch 子 agent） | 偏差：改为主 agent 串行完成 7 维度 | 有效代码面仅 6 行（唯一产品改动），派发子 agent 的上下文打包与回收开销高于收益 |
| 2 | 需求管理集成（写 `review/code-review.md` 到需求目录） | 偏差：报告落在本计划目录 | 本 worktree 无 `CodeWikiHub/`（需求库在主 checkout），`req` 找不到 REQ-20260924-001 |
| 3 | 测试目录 typecheck 缺口（test/ 不在任何 tsconfig） | 记为 P2 不实施 | 单独 typecheck `test/chat` 有 8 条**存量**错误（`.delivery/mocks` 无声明、`@/` 别名需 web 配置），修复面超出本次最小修复 |
| 4 | `qa_miss` 步骤「含『未找到』」断言的确定性 | **维持现状 + 已记录** | 该文案取决于**模型判断**（语义检索对任何 query 都返回 top-k），属断言口径问题而非产品缺陷；4 次复跑 3 次 13/13、1 次该步抖动失败但**未留存断言原文故不能确证**。建议后续拆成「结构性硬断言 + 模型行为软观测」，本轮不擅自改判据 |

## 进度日志
- 2026-09-29 23:30 建档；review 已完成取证（调用点、不变量、阈值、内容规范化四处已核）；fix-loop 本计划三阶段（审查→修复→回归）进行中
- 2026-09-29 23:35 工作项 1/2/3/5 完成并附证据；工作项 4 的 e2e 复跑出现 1 次 FAIL（5/13，中止于 `qa_miss`）——用单轮最小复现探针实测：模型**回答正确**（明确「知识库中未找到相关内容」且声明不来自知识库，检索命中 3）
- 2026-09-29 23:38 工作项 4 收口：e2e 最终 **13/13 PASS**（4m36s，`/tmp/ki-journey2.log`）；期间发现 harness 自身缺客户端超时（实测挂起 2m12s）→ 派生出**工作项 6** 并修复。全部工作项已完成，转入自评审
- 2026-09-29 23:40 自评审完成：**通过 15 / 15，P0 未通过 0**（见 checklist.md）；本计划状态置「已完成」
