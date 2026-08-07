# E2E 测试报告：外部Wiki直接导入与自动切分

## 概览
- 通过步骤：10 / 总 11（teardown 不计入判定；发现并修复 1 个体验问题）
- 环境：本地 CLI（隔离 config `/tmp/ki-e2e-config.yaml`，独立 dataDir/vectorDir）
- 旅程状态：✅ PASS（含 1 次体验问题修复后复验）

## 明细

| 步骤 | 类型 | 状态 | 关键 evidence | 失败根因 |
|------|------|------|---------------|----------|
| setup_wiki | setup | ✅ | 5 md 文件，ref.md 5087B（触发切分），git init | — |
| full_import | cli | ✅ | 5 文件 → 7 chunks，vectorized=7/errors=0（REQ-01） | — |
| assert_cache | assert | ✅ | relation=`文件名-N`、sourcePath=`文件#N`、memoryId 全回填（REQ-02/03/08） | — |
| assert_source | assert | ✅ | commit + chunkSize=1000/chunkOverlap=150 持久化（REQ-07） | — |
| assert_sourcedir | assert | ✅ | config sourceDir=/tmp/ki-e2e-wiki 绝对路径（REQ-01） | — |
| search_pos | cli | ✅ | `ki search "告警收敛"` 位置参数命中 alarm-01（REQ-12） | — |
| make_changes | cli | ✅ | git 三类变更：A auth / M alarm / D ref | — |
| incr_import | cli | ✅ | added=1/modified=1/deleted=1/errors=0（REQ-06） | — |
| assert_final | assert | ✅ | auth-01 新增 / alarm memoryId 更新 / api 组 3→0 全清 / commit 推进（REQ-06/08） | — |
| no_git_error | cli | ⚠️→✅ | 首次报错缺引导 → 修复后含"git init 或 --mode full"（§4.4） | 错误文案缺引导性提示 |
| teardown | teardown | ✅ | 清理全部 e2e 数据 + 全量测试 290/290 全绿 | — |

## 跨组件终态验证（REQ-06/08 核心）

| 变更 | 终态 | 结果 |
|------|------|------|
| A docs/auth.md | relations-cache 出现 `auth-01`，检索"RBAC 角色访问控制"命中 | ✅ |
| M docs/alarm.md（内容重写） | `alarm-01` memoryId 更新（f0044b78→17d1a4a0），检索"时间窗口聚合"命中 | ✅ |
| D api/ref.md（3 chunks） | E2EWiki/api 组 3 relations → 0（ref-01/02/03 全清） | ✅ |
| commit 推进 | source.commit 6f6af6aa → 1a5ef1b6 | ✅ |
| 未变更文件 | README-01/deploy-01/login-01 memoryId 不变 | ✅ |

## 体验问题发现与修复

**问题（§4.4 错误反馈友好度）**：非 git 目录跑增量，原报错"无法获取 sourceDir 的 git HEAD"——缺引导（用户不知如何处置）。

**修复**：`diff.ts:199` + `incremental.ts:429` 两处报错统一为：
`source 目录不在 git 仓库中（{dir}）。增量更新依赖 git，请先 git init 或改用 --mode full 全量导入`

**复验**：无 git 增量报错已含引导 ✅；incremental-direct 3/3 + 全量 290/290 全绿。

## 副作用清单
- 已创建：`/tmp/ki-e2e-data`、`/tmp/ki-e2e-vector`、`/tmp/ki-e2e-wiki` 等
- 已清理：teardown 全部删除 ✅

## 建议
- 无阻塞项。§4.4 引导文案已修复，可纳入本次提交。
