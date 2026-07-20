# ZvecEngine 基座实现级设计 · 评审报告

> 评审时间：2026-07-20
> 评审范围：`design/` 父文档 + 6 个子文档
> 评审格式：design-craft（强信号命中）
> 评审模式：全量评审（首次）

---

## 评审结论：❌ 不通过（含 4 项 🔴 阻断）→ 修复后 **✅ 通过**

**修订状态**：全部 20 项已修复（🔴4 + ⚠️2 + 🟡8 + 🟢6），详见下方逐项"修复验证"。

---

## 修复验证表

### 🔴 阻断（4 项，全部已修复）

| # | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|
| 1 | `probe` 误用 `collectionName: '__probe__'`（过不了集合名正则 + zvec open 不需新名） | S-04 §3.2 / S-06 §3.4 | S-04 §3.2 probe 决策行改"不传 collectionName"；S-06 §3.4 伪码删 `collectionName: '__probe__'`，补 🔴#1 修复说明 | ✅ |
| 2 | `close` 语义"terminate + closeSync"顺序矛盾（terminate 强杀后 closeSync 不执行） | S-04 §3.2 | S-04 §3.2 close 决策行改为"drain → closeSync → terminate" | ✅ |
| 3 | `queryText`/`vector` 互斥与 v5 §4.2 "text/vector 并存"字面张力 | S-05 §3.2 + §4b | S-05 §3.2 决策行补"写入侧并存 OK / 检索侧互斥 OK"语义边界；§4b `HybridSearchReq` 加 JSDoc | ✅ |
| 4 | engine 构造函数注入与静态工厂模式冲突 | S-06 §3.2 | 决策行改"private 构造 + 静态工厂内部装配 + `__forTest__.createWithDeps` 测试入口" | ✅ |

### ⚠️ 疑似阻断（2 项，全部已修复）

| # | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|
| S-1 | `destroy` 协议的进程归属未澄清 | S-04 §3.2 | 新增"destroy 语义"决策行：worker 内执行（closeSync → ZVecDestroy → terminate） | ✅ |
| S-2 | 写入批大小 100 未论证 + `setImmediate` 有效性 | S-04 §3.2 | 新增"写入批大小"决策行：默认 100 可调 20~500，论证 21ms 尾延迟可接受 | ✅ |

### 🟡 警告（8 项，全部已修复）

| # | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|
| 5 | `fetch` 协议缺 `includeVector` 控制 | S-04 §3.3 | `fetch` payload 加 `includeVector?: boolean` | ✅ |
| 6 | `info` 消息返回结构未定义 + `locked` 语义 | S-04 §3.3 | 新增 `InfoResult` 类型定义，标注 `locked: false` 仅 probe 有意义 | ✅ |
| 7 | `index.ts` 全量导出 17 种异常固化 API 表面 | S-06 §4a | 改显式导出：11 种核心 + 基类；Worker*/Embedding* 标 @internal | ✅ |
| 8 | `dimensions: 4096` 请求体并非所有 provider 都支持 | S-03 §3.3 | 移除 `dimensions` 字段，维度一致性完全由响应 `embedding.length` 校验保证 | ✅ |
| 9 | `close` 消息缺 `drainTimeoutMs` | S-04 §3.3 | `close` payload 加 `drainTimeoutMs?: number` | ✅ |
| 10 | `Hit.score` 值域未在 JSDoc 体现 | S-06 §4b | `Hit.score` 补完整 JSDoc：vector 路 [1/3,1]、fts 路 BM25 原值、hybrid 路 RRF 分 | ✅ |
| 11 | `CollectionCorruptedException` 识别规则未定义 | S-01 §3.5 | 新增 §3.5 "zvec 错误 → 类型化异常识别规则"表（待 T-04 实测校准） | ✅ |
| 12 | `__log__` 消息类型使用时机未定义 | S-04 §3.3 | 移除 `__log__` 类型，注释说明 v1 不引入带外日志通道 | ✅ |

### 🟢 建议（6 项，全部已修复）

| # | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|
| 13 | 父文档 `Filter` 描述含"/IN" 与 S-02 矛盾 | 父文档 §3 | 删除"/IN"，标注"v1 不支持 IN，留 v2" | ✅ |
| 14 | `apiKey` "必填；缺省从 env 读"矛盾 | S-03 §4a.1 | 类型改 `apiKey?: string`，注释明确"二者都无则抛 EmbeddingConfigError" | ✅ |
| 15 | `ProbeResult.healthy` 与 `error` 语义重叠 | S-06 §4a | 改判别联合类型：`{healthy:true} \| {healthy:false, error:...}` | ✅ |
| 16 | T-01 未标注双 FTS 字段方案代价 | S-01 §7 | T-01 补"双 FTS 可行性未实测；备选 whitespace + 应用层二次过滤" | ✅ |
| 17 | `tryOpen` 返回 null 无法区分原因 | S-06 §4a | `tryOpen` JSDoc 注明"仅布尔判断；需判别原因用 open 或 probe" | ✅ |
| 18 | `ZvecEngineError` 字段声明不完整 | S-06 §4b | 补 `code`/`data` 字段 JSDoc 与 SerializedError 对应关系 | ✅ |

---

## 原始评审统计

| 维度 | 🔴 | ⚠️ | 🟡 | 🟢 | 合计 |
|------|----|----|----|----|------|
| 完整性 | 0 | 0 | 2 | 0 | 2 |
| 质量 | 0 | 0 | 4 | 5 | 9 |
| 正确性 | 2 | 2 | 1 | 0 | 5 |
| 一致性 | 2 | 0 | 1 | 0 | 3 |
| 体验 | 0 | 0 | 0 | 1 | 1 |
| 合计 | **4** | **2** | **8** | **6** | **20** |

---

## 评审维度总结

### 主干设计优点（肯定）

1. **方案 X 锁定清晰**：embedding 主线程 + Float32Array + Transferable 零拷贝，论证充分
2. **单一 worker actor 模型**：消解 zvec 文件级锁与 async 签名矛盾，写入让出机制（分批 + setImmediate）贴合实测
3. **错误分层与 zvec 实测对齐**：批级抛异常（维度/未知字段/schema 漂移/不一致更新）vs 文档级 errors[]（embedding 失败/id 冲突/not found）
4. **Filter 编译白名单 + 单引号转义**：杜绝注入，移除 `{raw}` 逃生口
5. **score 归一化方向统一**："越大越相关"，调用方无需按 queryType 分支

### 修复后的设计完备性

- 4 项 🔴 全部消除：probe collectionName 修正、close 顺序理顺、queryText/vector 语义边界明确、engine 注入与静态工厂对齐
- 2 项 ⚠️ 全部澄清：destroy 进程归属（worker 内）、写入批大小论证
- 8 项 🟡 全部补全：协议字段（fetch includeVector / close drainTimeoutMs / info 返回结构）、API 表面收敛（index.ts 显式导出）、dimensions 参数移除、Hit.score JSDoc、异常识别规则、移除 __log__
- 6 项 🟢 全部吸收：Filter 描述、apiKey 类型、ProbeResult 判别联合、T-01 备选方案、tryOpen JSDoc、异常类字段

---

## 下一步建议

设计文档已达**可进入实现**状态。建议按以下顺序推进：

1. **优先**：`design-to-code` 生成 `src/zvec-engine/` 代码骨架（7 个模块文件 + 类型定义 + 异常类）
2. **其次**：`code-implement` 按依赖拓扑序填充实现（S-01 → S-02 → S-03 → S-04 → S-05 → S-06）
3. **并行**：实现期实测 T-03（delete 不存在 id 行为）、T-04（probe 错误类型可区分性）
4. **实现完成后**：真实 embedding 验证 T-01（jieba 代码符号）+ T-02（score 公式 + Recall@5）

---

## 评审历史

| 时间 | 模式 | 结论 | 问题数 |
|---|---|---|---|
| 2026-07-20 | 全量评审 | ❌ 不通过（4 项 🔴） | 20 |
| 2026-07-20 | 修复验证 | ✅ 通过（20 项全部修复） | 0 |
