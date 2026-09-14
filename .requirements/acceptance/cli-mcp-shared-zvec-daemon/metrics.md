# 验收指标：CLI 与 MCP 共享 zvec 守护进程

> 需求来源：REQ-20260910-001《CLI 与 MCP 共享 zvec 守护进程》
> 验收对象：CLI、stdio MCP、HTTP MCP 共用 daemon owner；按 scope 调度；一 scope 一 Collection；长任务状态反馈；Collection 资源治理。
> 指标锁定：2026-09-11，首次验收。指标直接沿用需求文档中的验收标准，本轮不因执行结果调整判据。

| 指标 ID | 类型 | 指标描述 | 判据 | 证据层 | 优先级 |
|---------|------|----------|------|--------|--------|
| M-01 | 🎯 功能达成 | 唯一 daemon owner 与客户端接入 | CLI、stdio MCP、HTTP MCP 可共享同一 owner；daemon 不可用或身份不匹配时 fail-loud | L1/L3 | 🔴 必达 |
| M-02 | 🎯 功能达成 | 按 scope 调度与复合写一致性 | 同 scope 写入按序；不同 scope 在上限内可并发；20+ 混合请求无可避免锁错误且记录不丢失 | L1/L3 | 🔴 必达（round-2 高优先级场景已补验） |
| M-03 | 🧱 边界异常 | scope 隔离、授权与身份漂移 | 未授权跨 scope 请求仍拒绝；scope 只能映射到自身目录；配置/布局/身份不匹配有明确失败 | L1/L2 | 🔴 必达 |
| M-04 | 🔗 契约集成 | 多 scope fan-out 检索 | 单 scope 结果保持；多 scope 结果为各 scope 合并后的全局 top-k；单次请求只计算一次 query embedding | L1/L2 | 🔴 必达 |
| M-05 | 🔗 契约集成 | 存量迁移可恢复 | 迁移前后文档数、memoryId、cache 和检索结果一致；checkpoint 可续跑；旧布局确认前保留 | L1/L2 | 🔴 必达 |
| M-06 | 🎯 功能达成 | 长任务进度与取消 | import/restore/rebuild 能查询 jobId、阶段和进度；取消按批次边界生效，取消后不产生未声明后台写入 | L1/L2 | 🟡 质量必验（round-2 真实 restore/rebuild 已补验） |
| M-07 | 💎 体验质量 | 失败、排队与生命周期反馈 | 失败包含 operation/scope/jobId/原因/恢复建议；排队可识别；重启、缺 daemon、配置不匹配均可操作地反馈 | L1/L2 | 🟡 质量必验（round-2 teardown 隔离已补验） |
| M-08 | 🎯 功能达成 | Collection 资源上限与 LRU | 达到配置上限不无限打开；只释放无活跃租约句柄；释放后锁释放且重新打开结果正确；打开/释放耗时和峰值可观测 | L1/L3 | 🟡 质量必验 |
| M-09 | 📊 非功能 | 真实 embedding 并发基线 | 记录固定场景下跨 scope P95、吞吐、排队和同 scope 读写重叠结论；不以单轮结果冒充稳定生产基线 | L3 | 🟡 质量必验（24 请求重复基线与 OS 采样已补齐，稳定生产趋势仍待后续） |
| M-10 | 🔗 契约集成 | CLI/MCP 兼容性 | 既有 CLI 参数/退出码和 MCP 授权语义保持；备份/export/wiki-backfill 等纳入既定 daemon 调度边界 | L1/L2 | 🔴 必达 |

## 历史未达标

- 首次验收（2026-09-11）：M-02、M-06、M-07、M-09、M-10 为 🟡，分别缺少 20+ 混合请求稳定基线、真实大规模 restore 中途取消、测试 teardown 隔离完整性、跨时间稳定性能样本或部分 daemon 边界的独立场景证据。

## round-2 高优先级补验（2026-09-14）

本轮不改变既有指标判据，补验重点为 M-02、M-06、M-07，并补充 M-09 的固定规模运行数据。验收基线为 `master @ 5951556`，工作区保持 dirty，结论仅针对当前未提交变更。

| 指标 | 本轮结果 | 结论 |
|------|----------|------|
| M-02 | 4 个 scope × 6 轮，共 24 个真实 embedding 写入；24/24 成功；每个 scope 以 CLI 搜索按 docId+文本核对 6/6 记录；跨 scope 排队 0；同 scope 读写 2/2 成功且一方排队 | 高优先级场景通过 |
| M-06 | 401 条快照 fixture 生成 803 个向量条目；restore+rebuild job 在 rebuild 第一批完成后取消；cancel 202；终态 `cancelled`、`cancelRequested=true`、`done=200/803`；额外 1500ms 状态/进度/finishedAt 不变；队列清空 | 高优先级场景通过 |
| M-07 | 新增共享隔离 daemon 生命周期辅助；teardown 只针对 healthz 实际 PID，确认 PID/端口退出；测试前后默认 7423 健康 | 本轮隔离场景通过 |
| M-09 | `maxOpenCollections=2`，资源峰值 2；追加三轮 24 请求运行分别为 9345ms/P95 1696ms/2.568 req/s、8111ms/1516ms/2.959 req/s、12265ms/3053ms/1.957 req/s，均跨 scope 排队 0、同 scope 排队 1；三轮 OS 峰值分别为 RSS/mmap/fd=663156/760/146、662964/767/149、689664/655/144；另有此前两轮采样 822288/628/143 与 759220/631/150 | 固定规模重复与 OS 观测已补齐；资源量级仅为本机样本，稳定生产趋势仍未形成 |

### round-2 L1/L3 命令证据

- 静态：`npx tsc -p tsconfig.json --noEmit` exit 0；三个新增/修改 E2E 文件 `node --check` 通过；`git diff --check` 通过。
- 回归：`mcp-http-api 21/21`、`restore 17/17`、`rebuild-vector 36/36`、`mcp-stop 9/9`。
- 真实链路：本轮追加 `npm run test:e2e:stage3` 3/3；`npm run test:e2e:restore-cancel` 1/1、`npm run test:e2e:daemon-routes` 1/1；各次测试前后 `ki mcp --status` 均确认默认 7423 running/ready、队列为空。
- `npm run test:all` 本轮未运行，不能据此宣称全量通过。
- OS 采样进展：已接入 `/proc` RSS、mmap 映射数和 fd 数采样；曾有阶段 3 启动预检因 SiliconFlow `/v1/embeddings` 超时而失败，endpoint 恢复后追加三轮真实负载采样，峰值分别为 RSS/mmap/fd=663156/760/146、662964/767/149、689664/655/144；结合此前两轮 822288/628/143、759220/631/150，共 5 轮成功采样。资源量级仅是本机样本，不代表容量上限。
