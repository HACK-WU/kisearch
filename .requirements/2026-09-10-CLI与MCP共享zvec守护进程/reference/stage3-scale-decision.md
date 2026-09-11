# 阶段 3：规模化与性能治理基准及扩展决策

> 需求：REQ-20260910-001
> 基准入口：`npm run test:e2e:stage3`
> 代码基线：`a001eaf` 之后的阶段 3工作区变更
> 记录时间：2026-09-11

## 1. 验收范围

本轮只验证当前“一 scope 一 Collection + daemon 单 owner”架构的资源上限和并发行为：

- `vector.maxOpenCollections` 控制 daemon 同时保留的 ready Collection handle/worker 数量。
- LRU 只能释放没有活跃租约的句柄；释放后必须能重新打开并读到原数据。
- native `probe/create/open/close` 必须经过 `serializeEngineOp`，避免 zvec 原生并发竞态。
- 跨 scope 写入可以并发提交；同 scope 读写按 coordinator 排队，不承诺并行写。
- `/healthz.vectorResources` 暴露打开/释放次数、耗时和句柄峰值。

## 2. 可重复基准协议

`stage3-scale.network.mjs` 每次运行都会创建隔离 `HOME`、配置、KB、vector 和 backup 目录，并启动只属于该隔离目录的 daemon：

1. 配置 4 个 scope，`maxOpenCollections=2`，每个 scope 预置 2 条文档。
2. 顺序执行预置写入，排除首次建库对并发结果的干扰。
3. 执行 3 轮 × 4 scope 的并发写入，共 12 个真实 embedding 请求，记录墙钟、P95、吞吐、跨 scope 排队数。
4. 同时提交同 scope 的一次读和一次写，记录排队反馈；该观测用于确认调度行为，不把一次竞态顺序当作性能承诺。
5. 从 `/healthz` 读取资源指标，断言 `peakOpenCount <= maxOpenCollections`。
6. finally 中停止隔离 daemon 并删除隔离目录；没有 embedding key 时，套件显式 skip 1 项。

凭证只从运行环境读取（本机使用用户 shell 中的有效 `SILICONFLOW_API_KEY`），报告不记录密钥内容。

正式运行 D 的环境记录：Node `v22.22.2`、Linux `x64`、20 个 CPU、总内存约 31819 MiB；embedding 模型 `Qwen/Qwen3-Embedding-8B`、维度 4096；`maxOpenCollections=2`。运行 A～C 使用同一工作区和同一配置协议，但未逐轮保存机器快照。

## 3. 已验证结果

| 运行 | 工作负载 | 请求数 | 墙钟 | P95 | 吞吐 | 跨 scope 排队 | 同 scope 读写 | 资源峰值 |
|---|---|---:|---:|---:|---:|---:|---|---:|
| A | 检索（历史对照） | 12 | 4114ms | 1491ms | 2.917 req/s | 0 | 1 个排队，等待 392ms | 2 |
| B | 检索（历史对照） | 12 | 26003ms | 21584ms | 0.461 req/s | 0 | 1 个排队 | 2 |
| C | 写入（正式入口） | 12 | 27817ms | 18927ms | 0.431 req/s | 0 | 1 个排队 | 2 |
| D | 写入（正式入口） | 12 | 73282ms | 59740ms | 0.164 req/s | 1 | 1 个排队 | 2 |

四次运行的所有请求均成功。历史检索运行 A/B 的 P95 相差约 14.5 倍，正式写入运行 C/D 也相差约 3.2 倍，说明真实 embedding 网络延迟是当前端到端数值的主要波动源；因此不能用任一单轮结果宣称稳定生产基线，也不能据此宣称需要更换向量后端。

资源指标样本：

- 运行 A：`peakOpenCount=2`、`openCount=2`、`opened=18`、`closed=16`。
- 运行 B：`peakOpenCount=2`、`openCount=1`、`opened=14`、`closed=13`。
- 运行 C：`peakOpenCount=2`、`openCount=2`、`opened=13`、`closed=11`。
- 运行 D：`peakOpenCount=2`、`openCount=2`、`opened=13`、`closed=11`。

另有本地 mock embedding + 真实 zvec LRU 回归：`maxOpenCollections=1` 下两个 scope 并发首次打开不会自等待；发生 LRU 释放后，scope 重新打开并检索成功，测试 1/1。

## 4. 当前结论

### 4.1 当前架构

- 跨 scope 的写入并发条件成立：正式运行 C/D 的 12 个写入请求均成功；C 未出现跨 scope coordinator 排队，D 有 1 个请求报告排队，但没有失败或锁错误。
- 同 scope 仍是单写者语义：读写请求可同时提交，但至少一方进入队列；当前没有观察到读写重叠。
- Collection 句柄上限成立：峰值未超过配置值，活跃租约不会被 LRU 强制关闭。
- 当前指标是应用层句柄/操作指标，不等价于操作系统 mmap 字节数或进程 RSS。

### 4.2 REQ-F01 / REQ-F02 决策

当前暂不实施：

- REQ-F01：按热点、租户或数据规模进一步分片。
- REQ-F02：迁移到支持多客户端并发写的服务型向量后端。

理由不是“功能不可行”，而是当前证据尚未满足扩展触发条件：跨 scope 写入已能并发，单 scope 的瓶颈尚未用固定数据规模的重复写入基准隔离确认，真实 embedding 网络波动也会掩盖 daemon 与 zvec 的本地成本。

## 5. 进入扩展评估的条件

后续基准应固定文档规模、批大小、并发度、机器规格和 embedding 网络条件，至少分别记录 embedding、RPC、排队、engine open/close 和 zvec 写入阶段。满足以下任一可复现现象后，再启动 F01/F02 设计评审：

- 单 scope 写入在批处理和 daemon 排队策略稳定后仍持续成为吞吐瓶颈。
- 同 scope 排队等待持续占主要延迟，且业务无法接受单写者语义。
- 句柄上限、OS mmap/RSS 或文件句柄接近实际预算，即使 LRU 正常也无法扩大 scope 数量。
- 多 scope fan-out 的稳定 P95 随 scope 数增长出现不可接受退化。

进入评估时必须补齐分片键、跨分片检索、迁移、备份恢复、权限隔离和兼容性成本；F02 还需对服务后端的写一致性、运维依赖和回滚路径单独评审。

## 6. 未完成项

- 当前正式 e2e 是小数据集、单机、单次调用内 3 轮；尚未形成跨机器/跨时间的稳定生产基线。
- 尚未采集 OS 级 mmap 字节数、RSS 和文件句柄数量；当前仅以 Collection handle 峰值作为可控资源代理指标。
- restore job 在真实大规模 tar/embedding 中的中途取消仍需专项演练。
- `npm run test:all` 仍未运行；既有 CLI 长耗时约束和两个历史测试问题保持原记录。
