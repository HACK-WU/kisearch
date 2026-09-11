# 验收指标：CLI 与 MCP 共享 zvec 守护进程

> 需求来源：REQ-20260910-001《CLI 与 MCP 共享 zvec 守护进程》
> 验收对象：CLI、stdio MCP、HTTP MCP 共用 daemon owner；按 scope 调度；一 scope 一 Collection；长任务状态反馈；Collection 资源治理。
> 指标锁定：2026-09-11，首次验收。指标直接沿用需求文档中的验收标准，本轮不因执行结果调整判据。

| 指标 ID | 类型 | 指标描述 | 判据 | 证据层 | 优先级 |
|---------|------|----------|------|--------|--------|
| M-01 | 🎯 功能达成 | 唯一 daemon owner 与客户端接入 | CLI、stdio MCP、HTTP MCP 可共享同一 owner；daemon 不可用或身份不匹配时 fail-loud | L1/L3 | 🔴 必达 |
| M-02 | 🎯 功能达成 | 按 scope 调度与复合写一致性 | 同 scope 写入按序；不同 scope 在上限内可并发；20+ 混合请求无可避免锁错误且记录不丢失 | L1/L3 | 🔴 必达 |
| M-03 | 🧱 边界异常 | scope 隔离、授权与身份漂移 | 未授权跨 scope 请求仍拒绝；scope 只能映射到自身目录；配置/布局/身份不匹配有明确失败 | L1/L2 | 🔴 必达 |
| M-04 | 🔗 契约集成 | 多 scope fan-out 检索 | 单 scope 结果保持；多 scope 结果为各 scope 合并后的全局 top-k；单次请求只计算一次 query embedding | L1/L2 | 🔴 必达 |
| M-05 | 🔗 契约集成 | 存量迁移可恢复 | 迁移前后文档数、memoryId、cache 和检索结果一致；checkpoint 可续跑；旧布局确认前保留 | L1/L2 | 🔴 必达 |
| M-06 | 🎯 功能达成 | 长任务进度与取消 | import/restore/rebuild 能查询 jobId、阶段和进度；取消按批次边界生效，取消后不产生未声明后台写入 | L1/L2 | 🟡 质量必验 |
| M-07 | 💎 体验质量 | 失败、排队与生命周期反馈 | 失败包含 operation/scope/jobId/原因/恢复建议；排队可识别；重启、缺 daemon、配置不匹配均可操作地反馈 | L1/L2 | 🟡 质量必验 |
| M-08 | 🎯 功能达成 | Collection 资源上限与 LRU | 达到配置上限不无限打开；只释放无活跃租约句柄；释放后锁释放且重新打开结果正确；打开/释放耗时和峰值可观测 | L1/L3 | 🟡 质量必验 |
| M-09 | 📊 非功能 | 真实 embedding 并发基线 | 记录固定场景下跨 scope P95、吞吐、排队和同 scope 读写重叠结论；不以单轮结果冒充稳定生产基线 | L3 | 🟡 质量必验 |
| M-10 | 🔗 契约集成 | CLI/MCP 兼容性 | 既有 CLI 参数/退出码和 MCP 授权语义保持；备份/export/wiki-backfill 等纳入既定 daemon 调度边界 | L1/L2 | 🔴 必达 |

## 历史未达标

- 首次验收（2026-09-11）：M-02、M-06、M-07、M-09、M-10 为 🟡，分别缺少 20+ 混合请求稳定基线、真实大规模 restore 中途取消、测试 teardown 隔离完整性、跨时间稳定性能样本或部分 daemon 边界的独立场景证据。
