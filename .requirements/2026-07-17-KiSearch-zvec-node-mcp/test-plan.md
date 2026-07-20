---
id: TESTPLAN-20260720-001
feature: ZvecEngine 基座模块（src/zvec-engine）测试方案
status: 已确认
created: 2026-07-20
version: 1
tags: [test-plan, zvec-engine, base-module]
depends_on: [REQ-20260717-001, REQ-20260717-002]
author: AI
document_type: test-plan
---

# 测试计划：ZvecEngine 基座模块（src/zvec-engine）

## 概述

- **关联需求**：`requirement.md`（REQ-01~REQ-10）+ `zvec-base-module.md`（v6，B-01~B-16 + Z-01~Z-06 + §5 NFR）
- **测试对象**：`src/zvec-engine/` 已完成代码（14 个 `.ts` 源文件，tsc 预编译到 `dist/zvec-engine/`）
- **测试范围界定**：据 `zvec-base-module.md §6`，基座模块落地 **REQ-01**（引擎层封装）+ **REQ-04**（原生混合检索 FTS+向量）+ **REQ-03**（embedding 集成的 `SiliconFlowProvider` 参考实现）。REQ-02/05/06/08/09/10 属 KiSearch 上层，不在本计划范围。
- **已有覆盖**：`test/zvec-engine.test.mjs`（14 冒烟测试，已从 `src/zvec-engine/__tests__/` 迁移），覆盖 S-01 schema 校验、S-02 filter、S-06 全链路、probe 三态、open/tryOpen、update 一致性、embed 失败粒度。
- **项目类型**：库/SDK → `node:test` + `node:assert/strict` 单元/集成测试
- **测试框架**：`node --test`（ESM `.mjs`）
- **编译前置**：`npm run build:zvec-engine`（测试 import 自 `dist/zvec-engine/index.js`）
- **测试用例数**：84 个（含已实现 14 + 新增 70；其中复查补充 22）
- **覆盖率**：REQ-01/REQ-03/REQ-04 + B-01~B-16 + Z-01~Z-06 + §5 NFR 全部有对应用例

## 测试环境与公共夹具

### 运行环境

- Node ≥ 18（ESM，`package.json type:module`）
- zvec 0.6.0（`@zvec/zvec`，Rust 内核预编译二进制）
- 测试命令：`npm run build:zvec-engine && npm run test:zvec-engine`

### 公共夹具（每个测试文件复用）

```js
// 固定 mock EmbeddingProvider（4096 维 hash 向量，L2 归一化）
const DIM = 4096;
function hashVector(text, dim = DIM) { /* 同 smoke test */ }
const mockEmbedding = { dimension: DIM, embed: async (texts) => texts.map((t) => hashVector(t)) };

// 标准建库配置（含 jieba FTS）
function makeConfig(dbPath, overrides = {}) { /* 同 smoke test */ }

// 临时 db 目录（每用例独立 mkdtempSync，t.after rmSync）
```

### 已有用例映射（smoke test 14 → 用例编号）

| smoke test 名称 | 对应用例编号 | 状态 |
|---|---|---|
| S-01 维度不符 | TC-REQ-01-02 | ✅ 已实现 |
| S-01 集合名过短 | TC-REQ-01-04 | ✅ 已实现 |
| S-01 集合名前导下划线 | TC-REQ-01-05 | ✅ 已实现 |
| S-01 fts.field 未声明 | TC-REQ-01-09 | ✅ 已实现 |
| S-02 filter 白名单拒绝 | TC-REQ-01-18 | ✅ 已实现 |
| S-06 全链路 | TC-REQ-01-30 | ✅ 已实现 |
| S-06 probe NOT_FOUND | TC-REQ-01-40 | ✅ 已实现 |
| S-06 probe 健康 | TC-REQ-01-41 | ✅ 已实现 |
| S-06 probe locked | TC-REQ-01-42 | ✅ 已实现 |
| S-06 open 不存在 | TC-REQ-01-43 | ✅ 已实现 |
| S-06 tryOpen 失败 null | TC-REQ-01-45 | ✅ 已实现 |
| S-06 update 仅 vector 配 FTS | TC-REQ-01-27 | ✅ 已实现 |
| S-06 upsert embed 失败 | TC-REQ-01-23 | ✅ 已实现 |
| S-06 预计算 vector 不受 embed 影响 | TC-REQ-01-24 | ✅ 已实现 |

---

## 测试用例

### TG-01 Schema 构建与校验（S-01，B-01，REQ-01）

> 目标：`validateCreateConfig`（V-01~V-07）+ `buildCollectionSchema` + `validateOpenConfig`（O-02~O-05）。

#### TC-REQ-01-01：create 正常建库（正常路径）

- **关联需求**：REQ-01 / B-01
- **测试策略**：功能型
- **优先级**：P0
- **前置条件**：dbPath 不存在；mockEmbedding.dimension === 4096
- **测试步骤**：
  1. `ZvecEngine.create(makeConfig(dbPath))`
  2. `engine.info()`
- **预期结果**：返回 engine 实例；`isOpen()===true`、`isHealthy()===true`；info.name/dimension/metric/fts.tokenizer 与配置一致
- **通过标准**：info 字段全部匹配 + isOpen/isHealthy 为 true

#### TC-REQ-01-02：create 维度不符 → DimensionMismatchError（异常路径）

- **关联需求**：REQ-01 / §5 维度校验铁律
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：config.embedding.dimension=2048 ≠ collection.dimension=4096
- **测试步骤**：`ZvecEngine.create(config)`
- **预期结果**：抛 `DimensionMismatchError`，不建库
- **通过标准**：`assert.rejects(..., DimensionMismatchError)` + dbPath 目录未被创建
- **状态**：✅ 已实现（smoke S-01）

#### TC-REQ-01-03：create metric 非 COSINE → InvalidSchemaError

- **关联需求**：REQ-01 / §0 度量限定
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：config.collection.metric = 'IP'（类型断言绕过）
- **测试步骤**：`ZvecEngine.create(config)`
- **预期结果**：抛 `InvalidSchemaError`（V-03）

#### TC-REQ-01-04：create 集合名过短 → InvalidSchemaError（边界）

- **关联需求**：REQ-01 / §7 集合名正则
- **测试策略**：否定型/边界
- **优先级**：P1
- **前置条件**：collection.name = 'ab'（< 3 字符）
- **预期结果**：抛 `InvalidSchemaError`（V-01）
- **状态**：✅ 已实现（smoke S-01）

#### TC-REQ-01-05：create 集合名前导下划线 → InvalidSchemaError（边界）

- **关联需求**：REQ-01 / §7 集合名正则 `^[a-zA-Z][a-zA-Z0-9_]{2,}$`
- **测试策略**：否定型/边界
- **优先级**：P1
- **前置条件**：collection.name = '__probe__'
- **预期结果**：抛 `InvalidSchemaError`
- **状态**：✅ 已实现（smoke S-01）

#### TC-REQ-01-06：create 集合名含非法字符 → InvalidSchemaError

- **关联需求**：REQ-01 / §7
- **测试策略**：否定型
- **优先级**：P2
- **前置条件**：collection.name = 'ki-search!'（含特殊字符）
- **预期结果**：抛 `InvalidSchemaError`

#### TC-REQ-01-07：create 标量字段与 denseField 重名 → InvalidSchemaError

- **关联需求**：REQ-01 / V-06
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：scalarFields 含 `{ name: 'dense', dataType: 'STRING' }`（与 denseField 同名）
- **预期结果**：抛 `InvalidSchemaError`（duplicate field name）

#### TC-REQ-01-08：create 标量字段互相重名 → InvalidSchemaError

- **关联需求**：REQ-01 / V-06
- **测试策略**：否定型
- **优先级**：P2
- **前置条件**：scalarFields 两个 `{ name: 'tag' }`
- **预期结果**：抛 `InvalidSchemaError`

#### TC-REQ-01-09：create fts.field 未声明 → InvalidSchemaError

- **关联需求**：REQ-01 / §5 FTS 字段校验
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：fts.field = 'nonexistent'
- **预期结果**：抛 `InvalidSchemaError`
- **状态**：✅ 已实现（smoke S-01）

#### TC-REQ-01-10：create fts.field 非 STRING 类型 → InvalidSchemaError

- **关联需求**：REQ-01 / V-05
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：fts.field 指向一个 `dataType: 'FLOAT'` 的标量字段
- **预期结果**：抛 `InvalidSchemaError`（must be STRING type）

#### TC-REQ-01-11：create fts.tokenizer 缺省 → InvalidSchemaError

- **关联需求**：REQ-01 / §5 FTS 分词器强制配置
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：fts = `{ field: 'content' }`（无 tokenizer）
- **预期结果**：抛 `InvalidSchemaError`（fts.tokenizer is required）

#### TC-REQ-01-12：create dbPath 已存在 → CollectionAlreadyExistsError

- **关联需求**：REQ-01 / V-07（zvec ZVecCreateAndOpen 要求路径不存在）
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：dbPath 目录已存在（先用 create 建一次，再对同路径 create 第二次）
- **预期结果**：抛 `CollectionAlreadyExistsError`

#### TC-REQ-01-13：create dbPath 非绝对路径 → InvalidSchemaError

- **关联需求**：REQ-01 / `assertAbsolutePath`
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：dbPath = 'relative/db'
- **预期结果**：抛 `InvalidSchemaError`（dbPath must be absolute）

#### TC-REQ-01-14：create dbPath 含 '..' → InvalidSchemaError

- **关联需求**：REQ-01 / 路径遍历防御
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：dbPath = '/tmp/../etc/db'
- **预期结果**：抛 `InvalidSchemaError`（must not contain '..'）

#### TC-REQ-01-15：create 成功后 worker 持有唯一句柄（孤立验证）

- **关联需求**：REQ-01 / §5 单一 worker actor 模型
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：已 create 一个 engine
- **测试步骤**：同进程对同 dbPath 再 `ZvecEngine.open`
- **预期结果**：第二次 open 抛 `CollectionLockedException`（Can't lock read-write collection）——印证"单进程单写句柄"

#### TC-REQ-01-16：open 维度与持久化不符 → DimensionMismatchError

- **关联需求**：REQ-01 / O-02
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：先用 4096 维 create + close；再用 dimension=2048 的 embedding open
- **预期结果**：抛 `DimensionMismatchError`

#### TC-REQ-01-17：open schemaAssert 不符 → SchemaMismatchError

- **关联需求**：REQ-01 / O-04
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：已 create（jieba fts）；open 时传 `schemaAssert: { fts: { field: 'content', tokenizer: 'standard' } }`
- **预期结果**：抛 `SchemaMismatchError`（fts.tokenizer 不符）

---

### TG-02 Filter 编译器（S-02，B-12，REQ-01）

> 目标：`compileFilter` 白名单 + 转义 + 嵌套 + 边界。经 `engine.listIds` 间接验证（与 smoke 一致），辅以纯函数单测。

#### TC-REQ-01-18：filter 字段白名单拒绝未声明字段

- **关联需求**：REQ-01 / B-12 / §5 filter 转义
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 create
- **测试步骤**：`engine.listIds({ field: 'unknown_field', op: '==', value: 'x' })`
- **预期结果**：抛 `InvalidFilterError`
- **状态**：✅ 已实现（smoke S-02）

#### TC-REQ-01-19：filter 字符串值单引号转义（防注入）

- **关联需求**：REQ-01 / R-04 Filter 转义注入
- **测试策略**：否定型/安全
- **优先级**：P0
- **前置条件**：已 create + upsert 若干 doc
- **测试步骤**：`engine.listIds({ field: 'tag', op: '==', value: "A'; DROP TABLE--" })`
- **预期结果**：值被转义为 `'A\'; DROP TABLE--'`，仅匹配字面值，不引发注入；返回空数组或仅匹配字面 doc（不抛错、不破坏 db）

#### TC-REQ-01-20：filter 字符串值含反斜杠转义

- **关联需求**：REQ-01 / `renderValue`
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：已 upsert `{ id:'d1', fields:{ tag: 'a\\b' } }`
- **测试步骤**：`engine.listIds({ field:'tag', op:'==', value:'a\\b' })`
- **预期结果**：返回 `['d1']`（反斜杠正确转义，能匹配）

#### TC-REQ-01-21：filter and/or/not 嵌套编译

- **关联需求**：REQ-01 / B-12
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert doc1(tag=A,score=0.9)、doc2(tag=B,score=0.5)、doc3(tag=A,score=0.7)
- **测试步骤**：`engine.listIds({ and:[{field:'tag',op:'==',value:'A'},{field:'score',op:'>=',value:0.7}] })`
- **预期结果**：返回 `['doc1','doc3']`

#### TC-REQ-01-22：filter 嵌套深度超 32 / 空数组 / null 值 → InvalidFilterError

- **关联需求**：REQ-01 / §S-02 边界
- **测试策略**：否定型/边界
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：分别传 (a) 33 层嵌套 not (b) `{and:[]}` (c) `{field:'tag',op:'==',value:null}`
- **预期结果**：均抛 `InvalidFilterError`

---

### TG-03 Embedding 提供方（S-03，B-14，REQ-03）

> 目标：`SiliconFlowProvider` 配置校验 + 重试 + 分批 + 维度校验。注入 mock fetch 避免真实网络。

#### TC-REQ-03-01：缺 apiKey（config 与 env 均无）→ EmbeddingConfigError

- **关联需求**：REQ-03 / 验收「缺 apiKey 时清晰报错」
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：`delete process.env.SILICONFLOW_API_KEY`
- **测试步骤**：`new SiliconFlowProvider({})`
- **预期结果**：抛 `EmbeddingConfigError`，message 含 "apiKey missing"

#### TC-REQ-03-02：apiKey 经 env 读取（正常路径）

- **关联需求**：REQ-03
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：`process.env.SILICONFLOW_API_KEY = 'sk-test'`
- **测试步骤**：`new SiliconFlowProvider({})`；`provider.dimension`
- **预期结果**：构造成功；dimension === 4096（默认）

#### TC-REQ-03-03：baseURL 非 https → EmbeddingConfigError

- **关联需求**：REQ-03 / §S-03
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：`baseURL: 'http://insecure'`
- **预期结果**：抛 `EmbeddingConfigError`（must start with https://）

#### TC-REQ-03-04：dimension 非正整数 → EmbeddingConfigError

- **关联需求**：REQ-03
- **测试策略**：否定型/边界
- **优先级**：P2
- **前置条件**：`dimension: 0` / `dimension: -1` / `dimension: 1.5`
- **预期结果**：抛 `EmbeddingConfigError`

#### TC-REQ-03-05：embed 正常分批 + onProgress 回调（正常路径）

- **关联需求**：REQ-03 / B-14 / §4.6 分批
- **测试策略**：功能型 + 数据型
- **优先级**：P0
- **前置条件**：注入 mock fetch，返回 4096 维向量；batchSize=2，传 5 条文本
- **测试步骤**：`provider.embed(texts, { batchSize:2, onProgress })`
- **预期结果**：返回 5 条向量，每条长度 4096；onProgress 被调用 3 次（2,4,5）；按 index 排序对齐输入

#### TC-REQ-03-06：embed 空数组 → 空数组（边界）

- **关联需求**：REQ-03
- **测试策略**：边界
- **优先级**：P2
- **前置条件**：—
- **测试步骤**：`provider.embed([])`
- **预期结果**：返回 `[]`，不调用 fetch

#### TC-REQ-03-07：5xx 错误指数退避重试成功

- **关联需求**：REQ-03 / §4.4 评测踩坑（SiliconFlow 抖动）
- **测试策略**：功能型
- **优先级**：P0
- **前置条件**：mock fetch 前 2 次返回 503，第 3 次 200
- **测试步骤**：`provider.embed(['x'], { retries: 3 })`
- **预期结果**：重试 2 次后成功，返回向量；sleep 被调用（指数退避）

#### TC-REQ-03-08：429 带 Retry-After 优先退避

- **关联需求**：REQ-03 / `parseRetryAfter`
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：mock fetch 第 1 次返回 429 + header `retry-after: 1`，第 2 次 200
- **测试步骤**：`provider.embed(['x'], { retries: 3 })`
- **预期结果**：成功；退避取 Retry-After（1000ms）而非指数

#### TC-REQ-03-09：4xx（非 429）不重试直接抛

- **关联需求**：REQ-03 / nonRetryable
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：mock fetch 返回 401
- **测试步骤**：`provider.embed(['x'], { retries: 3 })`
- **预期结果**：抛 `EmbeddingError`，code='HTTP_401'，data.nonRetryable===true；fetch 仅调用 1 次

#### TC-REQ-03-10：超时 → EmbeddingError(code=TIMEOUT) 可重试

- **关联需求**：REQ-03 / §4.6 timeoutMs
- **测试策略**：否定型/性能
- **优先级**：P1
- **前置条件**：mock fetch 用 AbortSignal 模拟超时（`e.name==='AbortError'`）
- **测试步骤**：`provider.embed(['x'], { timeoutMs: 10, retries: 1 })`
- **预期结果**：抛 `EmbeddingError`，code='TIMEOUT'，data.nonRetryable===false

#### TC-REQ-03-11：响应维度不符 → EmbeddingError(nonRetryable)

- **关联需求**：REQ-03 / 维度一致性校验
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：mock fetch 返回 2048 维向量（provider.dimension=4096）
- **预期结果**：抛 `EmbeddingError`，message 含 "dimension mismatch"，nonRetryable===true

#### TC-REQ-03-12：响应 data 数量不符 → EmbeddingError

- **关联需求**：REQ-03
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：传 3 条文本，mock fetch 返回 2 条
- **预期结果**：抛 `EmbeddingError`（data length mismatch）

#### TC-REQ-03-13：响应乱序按 index 对齐（防御）

- **关联需求**：REQ-03 / "按 index 排序对齐输入顺序"
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：mock fetch 返回 data 顺序为 [index:1, index:0]
- **测试步骤**：`provider.embed(['a','b'])`
- **预期结果**：结果[0] 对应 'a'，结果[1] 对应 'b'（已按 index 排序）

---

### TG-04 Worker 层与并发模型（S-04，B-16，REQ-01）

> 目标：单一 worker actor 模型、close drain 顺序、crash 处理、Transferable 零拷贝。

#### TC-REQ-01-19w：worker 内写入分批 + setImmediate 让出（查询插队）

- **关联需求**：REQ-01 / §5 串行化代价缓解
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 create；批量 > DEFAULT_WRITE_BATCH_SIZE(100)
- **测试步骤**：并发发起 `engine.upsert(200 条)` 与 `engine.vectorSearch(...)`
- **预期结果**：两者均成功；查询不因大批写入无限阻塞（worker 在批间 setImmediate 让出处理查询）

#### TC-REQ-01-20w：close drain 在途请求后再 closeSync + terminate

- **关联需求**：REQ-01 / 评审 🔴#2 close 顺序
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 create + 发起一个慢 upsert（200 条）
- **测试步骤**：upsert 未完成时调 `engine.close()`；close 后再 `ZvecEngine.open` 同 dbPath
- **预期结果**：close 等待在途完成（drain）→ worker closeSync 释放 LOCK → terminate；open 成功（锁已释放）

#### TC-REQ-01-21w：close 幂等（多次 close 不抛）

- **关联需求**：REQ-01 / §4.5 close 幂等
- **测试策略**：边界
- **优先级**：P1
- **前置条件**：已 create
- **测试步骤**：连续 `engine.close()` 三次
- **预期结果**：均 resolve，不抛错；`isOpen()===false`

#### TC-REQ-01-22w：worker crash 后在途请求被 reject + isOpen=false

- **关联需求**：REQ-01 / §5 worker 崩溃 / B-16
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：已 create（需注入可触发 crash 的场景，如向 worker 发非法消息触发 unhandled error）
- **测试步骤**：触发 worker error 事件；并发 `engine.info()`
- **预期结果**：在途请求 reject `WorkerCrashedError`；`isHealthy()===false`、`isOpen()===false`
- **注**：crash 自动重 spawn 属 T-05 二期，本期不验证

#### TC-REQ-01-23w：Float32Array 经 Transferable 零拷贝传递（数据完整性）

- **关联需求**：REQ-01 / 方案 X / R-02
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：已 create
- **测试步骤**：`engine.vectorSearch({ vector: hashVector('x'), topk:1 })`
- **预期结果**：检索结果正确（向量跨线程传递无损坏）；includeVector=true 时 fetch 回的 vector 与写入一致

#### TC-REQ-01-24w：destroy 删盘后不可 open

- **关联需求**：REQ-01 / §4.5 destroy
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：已 create
- **测试步骤**：`engine.destroy()`；`ZvecEngine.open(...)`
- **预期结果**：destroy 后 dbPath 目录被删；open 抛 `CollectionNotFoundError`

---

### TG-05 检索路由与归一化（S-05，B-09/B-10/B-11，REQ-04）

> 目标：退化矩阵 + score 归一化 + 互斥校验 + topk 边界。

#### TC-REQ-04-01：vectorSearch 自检索 top1 score≈1（正常路径）

- **关联需求**：REQ-04 / §5 score 归一化
- **测试策略**：度量型
- **优先级**：P0
- **前置条件**：已 upsert doc1(text='hello world')；用同文本 hash 向量检索
- **预期结果**：top1.id==='doc1'；score > 0.99（distance≈0 → 1/(1+0)≈1）；queryType==='vector'
- **状态**：✅ 已实现（smoke S-06 全链路内）

#### TC-REQ-04-02：semanticSearch embed 路径（正常路径）

- **关联需求**：REQ-04 / B-09
- **测试策略**：功能型
- **优先级**：P0
- **前置条件**：已 upsert
- **测试步骤**：`engine.semanticSearch({ queryText: 'hello world', topk: 3 })`
- **预期结果**：top1.id==='doc1'；内部 embed 被调用
- **状态**：✅ 已实现（smoke S-06 全链路内）

#### TC-REQ-04-03：ftsSearch jieba 中文命中（正常路径，B-10 核心差异点）

- **关联需求**：REQ-04 / B-10 / H-03
- **测试策略**：功能型
- **优先级**：P0
- **前置条件**：已 upsert doc2(text='你好世界')；fts.tokenizer='jieba'
- **测试步骤**：`engine.ftsSearch({ match: '世界', topk: 3 })`
- **预期结果**：命中 doc2；queryType==='fts'；score > 0
- **状态**：✅ 已实现（smoke S-06 全链路内）

#### TC-REQ-04-04：hybridSearch 两路 RRF 融合（正常路径，B-11 主路径）

- **关联需求**：REQ-04 / B-11
- **测试策略**：功能型
- **优先级**：P0
- **前置条件**：已 upsert
- **测试步骤**：`engine.hybridSearch({ queryText:'hello world', fts:'世界', topk:3 })`
- **预期结果**：返回非空；queryType==='hybrid'
- **状态**：✅ 已实现（smoke S-06 全链路内）

#### TC-REQ-04-05：hybridSearch queryText + vector 同传 → InvalidSearchError（互斥）

- **关联需求**：REQ-04 / §4.3 互斥 / 评审 🔴#3
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 create
- **预期结果**：抛 `InvalidSearchError`，message 含 "mutually exclusive"
- **状态**：✅ 已实现（smoke S-06 全链路内）

#### TC-REQ-04-06：hybridSearch 三者皆缺 → InvalidSearchError

- **关联需求**：REQ-04 / §4.3 退化矩阵
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 create
- **测试步骤**：`engine.hybridSearch({ topk: 3 })`
- **预期结果**：抛 `InvalidSearchError`（must provide at least one of）

#### TC-REQ-04-07：hybridSearch 缺 fts 退化为单路向量（退化矩阵）

- **关联需求**：REQ-04 / §4.3
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert
- **测试步骤**：`engine.hybridSearch({ queryText:'hello world', topk:3 })`（无 fts）
- **预期结果**：queryType==='vector'（退化）

#### TC-REQ-04-08：hybridSearch 缺 queryText/vector 只给 fts 退化为单路 FTS

- **关联需求**：REQ-04 / §4.3
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert
- **测试步骤**：`engine.hybridSearch({ fts:'世界', topk:3 })`
- **预期结果**：queryType==='fts'（退化）

#### TC-REQ-04-09：ftsSearch 集合无 FTS 配置 → InvalidSearchError

- **关联需求**：REQ-04 / routeFts
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：create 时不配 fts
- **测试步骤**：`engine.ftsSearch({ match:'x' })`
- **预期结果**：抛 `InvalidSearchError`（collection has no fts config）

#### TC-REQ-04-10：检索 vector 维度不符 → InvalidSearchError

- **关联需求**：REQ-04 / `validateVectorDimension`
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 create（4096 维）
- **测试步骤**：`engine.vectorSearch({ vector: new Array(2048).fill(0), topk:3 })`
- **预期结果**：抛 `InvalidSearchError`（dimension mismatch）

#### TC-REQ-04-11：topk 非正整数 / 超上限 1000 → InvalidSearchError

- **关联需求**：REQ-04 / §5 topk 边界
- **测试策略**：否定型/边界
- **优先级**：P1
- **前置条件**：已 create
- **测试步骤**：分别传 topk=0、topk=-1、topk=1.5、topk=1001
- **预期结果**：均抛 `InvalidSearchError`

#### TC-REQ-04-12：queryText 空串 / 超长 → InvalidSearchError

- **关联需求**：REQ-04 / `validateTextLength`（MAX_TEXT_LEN=10000）
- **测试策略**：否定型/边界
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：`semanticSearch({ queryText: '' })`；`semanticSearch({ queryText: 'x'.repeat(10001) })`
- **预期结果**：均抛 `InvalidSearchError`

#### TC-REQ-04-13：score 归一化 vector 路 distance clamp [0,2]

- **关联需求**：REQ-04 / §5 score 归一化 / `normalizeVectorScore`
- **测试策略**：度量型
- **优先级**：P1
- **前置条件**：纯函数单测 `normalizeVectorScore`
- **测试步骤**：`normalizeVectorScore(-1,'COSINE')`、`normalizeVectorScore(2,'COSINE')`、`normalizeVectorScore(0,'COSINE')`
- **预期结果**：-1→clamp 0→1；2→1/3；0→1

#### TC-REQ-04-14：score 归一化非 COSINE → SchemaMismatchError

- **关联需求**：REQ-04 / §0 度量限定
- **测试策略**：否定型
- **优先级**：P2
- **前置条件**：—
- **测试步骤**：`normalizeVectorScore(0, 'IP')`（类型断言绕过）
- **预期结果**：抛 `SchemaMismatchError`（only supports COSINE）

#### TC-REQ-04-15：toHit distance NaN/undefined → 丢弃（返回 null）

- **关联需求**：REQ-04 / normalize.ts
- **测试策略**：边界
- **优先级**：P2
- **前置条件**：—
- **测试步骤**：`toHit({ id:'x', distance: NaN, fields:{} }, { queryType:'vector', metric:'COSINE' })`
- **预期结果**：返回 null

#### TC-REQ-04-16：includeVector=true 时 Hit.vector 填充

- **关联需求**：REQ-04 / §4.4 Hit.vector
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert
- **测试步骤**：`engine.vectorSearch({ vector, topk:1, includeVector: true })`
- **预期结果**：hits[0].vector 为长度 4096 的数组

#### TC-REQ-04-17：检索带 filter 过滤（标量过滤 + 检索组合）

- **关联需求**：REQ-04 / B-12 / SearchOptions.filter
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert doc1(tag=A)、doc2(tag=B)
- **测试步骤**：`engine.vectorSearch({ vector, topk:3, filter:{ field:'tag', op:'==', value:'A' } })`
- **预期结果**：仅返回 tag=A 的 doc

#### TC-REQ-04-18：weighted 融合缺 weights → InvalidSearchError

- **关联需求**：REQ-04 / `weightsToArray`
- **测试策略**：否定型
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：`hybridSearch({ queryText:'x', fts:'y', rerank:{ type:'weighted' } })`
- **预期结果**：抛 `InvalidSearchError`（weighted requires weights）

---

### TG-06 引擎门面集成（S-06，B-01~B-16，REQ-01）

> 目标：文档 CRUD 全链路 + 生命周期。已有 smoke S-06 全链路覆盖主干，此处补边界。

#### TC-REQ-01-30：create → upsert → 4 类检索 → close → reopen → probe 全链路

- **关联需求**：REQ-01 / B-01~B-11 集成
- **测试策略**：功能型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 全链路）

#### TC-REQ-01-23：upsert embed 失败 → EMBEDDING_FAILED 文档级

- **关联需求**：REQ-01 / §4.4 错误分层 / R-03
- **测试策略**：否定型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 embed-fail）

#### TC-REQ-01-24：预计算 vector 不受 embed 失败影响（失败粒度）

- **关联需求**：REQ-01 / §4.6 失败粒度 = 小批
- **测试策略**：数据型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 prevector）

#### TC-REQ-01-25：upsert 写入维度不符 → DimensionMismatchError（批级抛异常）

- **关联需求**：REQ-01 / §4.4 批级 vs 文档级分层
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 create（4096 维）
- **测试步骤**：`engine.upsert([{ id:'d1', vector: new Array(2048).fill(0) }])`
- **预期结果**：抛 `DimensionMismatchError`（批级，不进 errors[]）

#### TC-REQ-01-26：upsert 含未声明标量字段 → InvalidDocInputError（批级）

- **关联需求**：REQ-01 / §4.4
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 create
- **测试步骤**：`engine.upsert([{ id:'d1', text:'x', fields:{ unknown:'y' } }])`
- **预期结果**：抛 `InvalidDocInputError`

#### TC-REQ-01-27：update 仅 vector 不传 text 且配 FTS → InconsistentUpdateError

- **关联需求**：REQ-01 / §4.5 update 联动规则
- **测试策略**：否定型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 update）

#### TC-REQ-01-28：update 传 text → 重嵌 + 同步 FTS（正常路径）

- **关联需求**：REQ-01 / §4.5 update 联动
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert doc1(text='old')
- **测试步骤**：`engine.update([{ id:'doc1', text:'new text' }])`；`ftsSearch({ match:'new' })`
- **预期结果**：update 成功；ftsSearch 能命中 'new'（FTS 索引已同步）

#### TC-REQ-01-29：insert 重复 id → ID_CONFLICT 文档级（不回滚不覆盖）

- **关联需求**：REQ-01 / B-05 / §7 实测（部分成功不回滚）
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 insert doc1
- **测试步骤**：`engine.insert([{ id:'doc1', text:'dup' }, { id:'doc2', text:'ok' }])`
- **预期结果**：ok=1, failed=1, errors[0].code==='ID_CONFLICT', id==='doc1'；doc1 原内容未被覆盖

#### TC-REQ-01-29b：delete 不存在 id → NOT_FOUND 文档级（T-03）

- **关联需求**：REQ-01 / B-07 / T-03
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 create（无 doc）
- **测试步骤**：`engine.delete(['nonexistent'])`
- **预期结果**：ok=0, failed=1, errors[0].code==='NOT_FOUND'（印证 zvec deleteSync 对不存在 id 报 ZVEC_NOT_FOUND）

#### TC-REQ-01-31：upsert 幂等（同 id 再写覆盖）

- **关联需求**：REQ-01 / B-04 幂等
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 upsert doc1(text='a')
- **测试步骤**：`engine.upsert([{ id:'doc1', text:'b' }])`；`fetch(['doc1'])`
- **预期结果**：ok=1；fetch 回的 text==='b'（覆盖）

#### TC-REQ-01-32：fetch 不存在 id → 不返回（Doc[] 长度 < 请求数）

- **关联需求**：REQ-01 / B-08
- **测试策略**：边界
- **优先级**：P1
- **前置条件**：已 upsert doc1
- **测试步骤**：`engine.fetch(['doc1','nope'])`
- **预期结果**：返回长度 1，仅 doc1

#### TC-REQ-01-33：fetch includeVector=true 返回向量

- **关联需求**：REQ-01 / B-08
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert doc1
- **测试步骤**：`engine.fetch(['doc1'], true)`
- **预期结果**：docs[0].vector 长度 4096

#### TC-REQ-01-34：listIds 无 filter 返回全部 / limit 截断

- **关联需求**：REQ-01 / B-15 / §4.5 limit 默认 1000 上限 10000
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert 3 条
- **测试步骤**：`engine.listIds()`；`engine.listIds(undefined, 2)`
- **预期结果**：前者返回 3 条；后者返回 2 条

#### TC-REQ-01-35：listIds limit > 10000 → InvalidSearchError

- **关联需求**：REQ-01 / §4.5
- **测试策略**：否定型/边界
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：`engine.listIds(undefined, 10001)`
- **预期结果**：抛 `InvalidSearchError`（exceeds max 10000）
- **注**：当前实现 `assertReadable` 路径需确认 limit 上限校验落点；若未实现则记为实现缺口

#### TC-REQ-01-36：空数组写入 → { ok:0, failed:0 }（边界）

- **关联需求**：REQ-01 / `writeDocs` 早返回
- **测试策略**：边界
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：`engine.upsert([])`
- **预期结果**：`{ ok:0, failed:0 }`，不调 embed、不发 worker

#### TC-REQ-01-37：destroy 后再操作 → 抛错（防御）

- **关联需求**：REQ-01 / `assertWritable`
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：已 create + destroy
- **测试步骤**：`engine.upsert([...])`
- **预期结果**：抛 `InvalidSchemaError`（engine destroyed）

#### TC-REQ-01-38：isHealthy/isLocked/isOpen 语义

- **关联需求**：REQ-01 / B-16
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：create / close / destroy 各阶段
- **测试步骤**：分别断言三态
- **预期结果**：create 后 isOpen=true/isHealthy=true/isLocked=false；close 后 isOpen=false

---

### TG-06b probe 与 open 错误区分（S-06，B-16，REQ-01）

#### TC-REQ-01-40：probe 不存在 → NOT_FOUND

- **关联需求**：REQ-01 / B-16
- **测试策略**：否定型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 probe）

#### TC-REQ-01-41：probe 健康 db

- **关联需求**：REQ-01 / B-16
- **测试策略**：功能型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 probe）

#### TC-REQ-01-42：probe 被持锁 db → locked=true

- **关联需求**：REQ-01 / B-16 / Z-04
- **测试策略**：功能型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 probe-locked）

#### TC-REQ-01-43：open 不存在 → CollectionNotFoundError

- **关联需求**：REQ-01 / B-02 / Z-04（主线程 existsSync 预检）
- **测试策略**：否定型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 open-nonexistent）

#### TC-REQ-01-44：probe 自定义 timeoutMs（边界）

- **关联需求**：REQ-01 / §4.5 probe timeout 默认 3000
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：持锁 db
- **测试步骤**：`ZvecEngine.probe(dbPath, 500)`
- **预期结果**：500ms 内判定 locked=true（不阻塞到默认 3000ms）

#### TC-REQ-01-45：tryOpen 失败返回 null

- **关联需求**：REQ-01 / B-02
- **测试策略**：功能型
- **优先级**：P0
- **状态**：✅ 已实现（smoke S-06 tryOpen）

#### TC-REQ-01-46：probe 损坏 db → CORRUPTED（T-04 可区分性）

- **关联需求**：REQ-01 / T-04 / §3.5 错误识别规则
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：手动破坏 db 目录（删关键元数据文件 / 写入垃圾字节）
- **测试步骤**：`ZvecEngine.probe(dbPath)`
- **预期结果**：返回 `{ exists:true, locked:false, healthy:false, error:'CORRUPTED' }`
- **注**：T-04 待定项，需构造可复现损坏样本；若 zvec 对损坏路径表现与 NOT_FOUND 不可区分，记为已知局限

---

### TG-07 zvec 参数契约一致性（Z-01~Z-06，§4.5.1）

> 目标：验证实现与 zvec 0.6.0 实测约束对齐（v6 修正回写项）。这些属数据型契约测试。

#### TC-Z-01：querySync/multiQuerySync 不传显式 undefined（Z-01）

- **关联需求**：REQ-01 / §4.5.1 Z-01
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 upsert
- **测试步骤**：`vectorSearch`（无 filter）、`ftsSearch`（无 filter）、`hybridSearch`（无 filter）各跑一次
- **预期结果**：均不抛 "Expected a string for 'filter'" 错（条件展开生效）

#### TC-Z-02：upsert 空向量/空字段对象（Z-02）

- **关联需求**：REQ-01 / §4.5.1 Z-02
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 create
- **测试步骤**：`engine.upsert([{ id:'d1', vector: hashVector('x') }])`（无 fields）
- **预期结果**：成功（toZvecDocInput 始终返回 `{}` 而非 undefined）

#### TC-Z-03：update 必须带 dense vector（Z-03，v6 修正联动规则）

- **关联需求**：REQ-01 / §4.5 update 联动 v6
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 upsert doc1；配 FTS
- **测试步骤**：`engine.update([{ id:'doc1', fields:{ tag:'B' } }])`（仅 fields 不带 vector/text）
- **预期结果**：zvec 报 "field[dense] is required"（v6 已确认"仅传 fields"不可实现）；实现应抛 `InconsistentUpdateError` 或文档级 ZVEC_WRITE_ERROR
- **注**：需确认 engine 当前对"仅 fields update"的处理路径；若未显式拦截则记为实现缺口

#### TC-Z-04：open/probe 对持锁路径不无限阻塞（Z-04）

- **关联需求**：REQ-01 / Z-04
- **测试策略**：性能型
- **优先级**：P0
- **前置条件**：持锁 db
- **测试步骤**：`ZvecEngine.probe(dbPath, 1000)` 计时
- **预期结果**：~1000ms 内返回 locked=true（Promise.race 超时生效），不阻塞
- **状态**：✅ 已实现（smoke probe-locked）

#### TC-Z-05：probe 不传 collectionName（Z-05）

- **关联需求**：REQ-01 / Z-05
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：健康 db
- **测试步骤**：`ZvecEngine.probe(dbPath)`（仅 dbPath）
- **预期结果**：成功判定 healthy=true（不因 collectionName 缺失失败）
- **状态**：✅ 已实现（smoke probe-healthy）

#### TC-Z-06：worker ESM 静态 import（Z-06）

- **关联需求**：REQ-01 / Z-06
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：—
- **测试步骤**：`npm run build:zvec-engine` 后任意 create/open
- **预期结果**：worker 启动成功（无 "require is not defined" 错），印证静态 import
- **状态**：✅ 已实现（全部 smoke 测试隐式验证）

#### TC-Z-07：embed 失败 doc 从 toWrite 剔除（v6 修正）

- **关联需求**：REQ-01 / §4.5.1 嵌入失败文档剔除
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：flakyEmbedding（首调失败）
- **测试步骤**：`engine.upsert([{ id:'d1', text:'fail' }, { id:'d2', vector: precomputed }])`
- **预期结果**：d1 标 EMBEDDING_FAILED 且**不进 toWrite**（不触发 Z-02 整批失败）；d2 成功写入
- **状态**：✅ 已实现（smoke prevector）

---

### TG-08 性能验收（§5 NFR，REQ-07 前置）

> 目标：不含 embedding 的检索路 <5ms；reopen <100ms。用 hash 向量（无网络）测纯引擎延迟。

#### TC-PERF-01：vectorSearch 单次 <5ms（度量）

- **关联需求**：REQ-01 / §5 时延构成 / REQ-07 前置
- **测试策略**：性能型
- **优先级**：P1
- **前置条件**：已 upsert 200 条；预热 1 次
- **测试步骤**：`performance.now()` 包裹 `vectorSearch`，跑 20 次取均值
- **预期结果**：均值 <5ms（基准 0.8ms；含 postMessage 往返 ~0.1ms）
- **通过标准**：均值 <5ms，P99 <10ms

#### TC-PERF-02：ftsSearch 单次 <5ms（度量）

- **关联需求**：REQ-01 / §5
- **测试策略**：性能型
- **优先级**：P1
- **前置条件**：同上
- **预期结果**：均值 <5ms

#### TC-PERF-03：reopen（open）冷启动 <100ms（度量）

- **关联需求**：REQ-01 / §5 / 基准 49.9ms
- **测试策略**：性能型
- **优先级**：P1
- **前置条件**：已 create + close
- **测试步骤**：计时 `ZvecEngine.open`
- **预期结果**：<100ms（含 worker spawn）

#### TC-PERF-04：批量 upsert 200 条吞吐（度量，非阻断）

- **关联需求**：REQ-01 / §5 串行化代价
- **测试策略**：性能型
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：计时 `upsert(200 条)`
- **预期结果**：<500ms（基准 41.8ms/200 条；含 embed mock 开销）
- **注**：记录数值供上层评估，非硬性阻断

---

### TG-09 待定项与真实 embedding 验收（T-01~T-05，REQ-04/REQ-07）

> 目标：闭合设计 §5 待定问题 + REQ-07 Recall@5。需真实 SiliconFlow API，标记为 `@requires-network`，CI 默认跳过。

#### TC-T-01：jieba 对代码符号标识符精确召回（T-01，REQ-04）

- **关联需求**：REQ-04 / T-01 / R-01
- **测试策略**：度量型
- **优先级**：P1（真实环境）
- **前置条件**：SiliconFlow `Qwen3-Embedding-8B`；语料 = `syncRelation` 代码符号（函数名/路径）
- **测试步骤**：建库（jieba）→ 用代码符号名 `ftsSearch`/`hybridSearch`
- **预期结果**：精确命中对应符号文档；若不满足，触发 R-01 双 FTS 字段方案
- **通过标准**：代码符号查询 top1 命中

#### TC-T-02：score 公式真实 embedding 验证 + Recall@5≥90%（T-02，REQ-07）

- **关联需求**：REQ-07 / T-02 / R-06
- **测试策略**：度量型
- **优先级**：P0（真实环境，REQ-07 验收）
- **前置条件**：4096 维 COSINE；compare.py 语料（40 篇 bk-monitor wiki）；self-retrieval 评测
- **测试步骤**：建库 → 用文档标题/首句查询 → 统计 Recall@5
- **预期结果**：Recall@5 ≥90%（基准 95%）；自检索 top1 score≈1（distance≈0）；不相关 score≈1/3（distance≈2）；Recall@1≥85% 附加观察
- **通过标准**：Recall@5 ≥90%

#### TC-T-03：delete 不存在 id 行为（T-03）

- **关联需求**：REQ-01 / T-03
- **测试策略**：数据型
- **优先级**：P0
- **状态**：并入 TC-REQ-01-29b（已确认 ZVEC_NOT_FOUND → NOT_FOUND 文档级）

#### TC-T-04：probe 损坏 vs 不存在可区分（T-04）

- **关联需求**：REQ-01 / T-04
- **测试策略**：数据型
- **优先级**：P1
- **状态**：并入 TC-REQ-01-46

#### TC-T-05：worker 崩溃自动重 spawn（T-05，二期）

- **关联需求**：REQ-01 / T-05 / REQ-09 上层
- **测试策略**：功能型
- **优先级**：P2（二期）
- **预期结果**：一期不实现自动恢复；记为已知限制，REQ-09 上层处理

---

## 补充用例（复查新增）

> 复查发现以下分支/契约/纯函数未覆盖，按类别补充。编号接续前文。

### A. 契约一致性核对（实现 vs v6，需先核对再定 pass/fail）

#### TC-REQ-01-47：listIds 默认值与上限校验（契约偏差核对）

- **关联需求**：REQ-01 / §4.5「limit 默认 1000、上限 10000，超过抛 InvalidSearchError」
- **测试策略**：数据型/契约
- **优先级**：P0
- **前置条件**：已 upsert >1000 条（或核对常量即可）
- **测试步骤**：(a) `engine.listIds()` 不传 limit → 核对默认值是 1000 还是 10000；(b) `engine.listIds(undefined, 10001)` → 核对是否抛 `InvalidSearchError`
- **预期结果**：契约要求默认 1000、超 10000 抛错
- **⚠ 实现缺口**：`engine.ts` `DEFAULT_LIST_IDS_LIMIT=10_000` 与契约「默认 1000」**不符**；且 `listIds` **未做 >10000 上限校验**（直接透传 worker）。本用例用于暴露并驱动修正，合并强化原 TC-REQ-01-35

### B. 纯函数单测（高 ROI，无 worker 依赖）

#### TC-S01-01：mapZvecOpenError 错误消息 → 类型化异常映射

- **关联需求**：REQ-01 / §3.5 错误识别规则
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：纯函数 import `mapZvecOpenError`
- **测试步骤**：分别传入 message 含 "Can't lock" / "not exist" / "corrupt" / 无法识别 的 Error
- **预期结果**：分别映射为 `CollectionLockedException` / `CollectionNotFoundError` / `CollectionCorruptedException` / 原样返回
- **注**：闭合 `CollectionCorruptedException` 在端到端路径中几乎无触发场景的缺口

#### TC-S01-02：assertSchemaMatch 各字段比对

- **关联需求**：REQ-01 / O-04
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：纯函数 import
- **测试步骤**：分别构造 `schemaAssert.dimension` / `.metric` / `.scalarFields[].dataType` / `.fts.field` 与持久化不符
- **预期结果**：均抛 `SchemaMismatchError`，`data.field` 指明不符项

#### TC-S01-03：buildCollectionSchema FP16 + jiebaDictDir

- **关联需求**：REQ-01 / §4.1 `denseDataType` / `FtsConfig.jiebaDictDir`
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：纯函数 import `buildCollectionSchema`
- **测试步骤**：(a) `denseDataType:'FP16'` → 向量 dataType 为 `VECTOR_FP16`；(b) `fts.jiebaDictDir:'/dict'` → `FtsIndexParams.extraParams` 含 `jieba_dict_dir`
- **预期结果**：schema 构建无错，字段映射正确

#### TC-ERR-01：异常 instanceof 链

- **关联需求**：REQ-01 / errors.ts
- **测试策略**：数据型
- **优先级**：P2
- **前置条件**：import index.ts 导出的 12 种异常
- **测试步骤**：遍历断言每种 `instanceof ZvecEngineError`
- **预期结果**：全部 true（调用方可 `instanceof` 统一识别）

### C. 行为分支未覆盖

#### TC-REQ-01-48：upsert/insert 无 text 无 vector → UNKNOWN 文档级

- **关联需求**：REQ-01 / `writeDocs`「doc must provide at least one of text/vector」
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：已 create
- **测试步骤**：`engine.upsert([{ id:'d1', fields:{ tag:'A' } }])`
- **预期结果**：`{ ok:0, failed:1, errors:[{ code:'UNKNOWN' }] }`（update 模式跳过此校验）

#### TC-REQ-01-49：text + vector 并存写入（vector 为准 + text 写 FTS）

- **关联需求**：REQ-01 / §4.2 联动「并存时以 vector 为准、text 仅写 FTS 索引」
- **测试策略**：数据型
- **优先级**：P0
- **前置条件**：已 create（配 FTS）
- **测试步骤**：`upsert([{ id:'d1', text:'FTS_TEXT', vector: hashVector('VEC') }])`；分别 `ftsSearch({ match:'FTS_TEXT' })` 与 `vectorSearch({ vector: hashVector('VEC') })`
- **预期结果**：两路均命中 d1（vector 用预计算值不重嵌；text 写入 FTS 索引）

#### TC-REQ-01-50：outputFields 过滤返回字段

- **关联需求**：REQ-04 / `SearchOptions.outputFields`
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert 含 tag/score/content
- **测试步骤**：`vectorSearch({ vector, topk:1, outputFields:['tag'] })`
- **预期结果**：`hits[0].fields` 仅含 tag（不含 score/content）

#### TC-REQ-01-51：readOnly open 写入失败

- **关联需求**：REQ-01 / `ZvecEngineOpenConfig.readOnly`
- **测试策略**：否定型
- **优先级**：P2
- **前置条件**：已 create + close
- **测试步骤**：`ZvecEngine.open({ ..., readOnly:true })` 后 `engine.upsert([...])`
- **预期结果**：zvec 拒绝写入（抛错，体现 read-only）

#### TC-REQ-01-52：destroy 幂等（二次调用不抛）

- **关联需求**：REQ-01 / `destroy` destroyed flag
- **测试策略**：边界
- **优先级**：P2
- **前置条件**：已 create
- **测试步骤**：连续 `engine.destroy()` 两次
- **预期结果**：第二次直接 return（不抛、不再 open/destroySync）

#### TC-REQ-01-53：并发纯读（actor 串行化正确性）

- **关联需求**：REQ-01 / §5 单 worker 串行
- **测试策略**：功能型
- **优先级**：P1
- **前置条件**：已 upsert
- **测试步骤**：`Promise.all([vectorSearch×5, ftsSearch×5, listIds×5])`
- **预期结果**：15 个并发请求全部正确返回，无串扰/丢失

#### TC-REQ-01-54：close 在 opening 中调用直接 terminate

- **关联需求**：REQ-01 / `proxy.close` opening 分支
- **测试策略**：边界
- **优先级**：P2
- **前置条件**：create 进行中（worker 未 ready）
- **测试步骤**：create 未 resolve 时调 `engine.close()`
- **预期结果**：不卡死，直接 terminate，`state=closed`

#### TC-REQ-01-55：update 仅 fields（Z-03 路径，明确行为）

- **关联需求**：REQ-01 / Z-03 / §4.5 v6
- **测试策略**：否定型
- **优先级**：P0
- **前置条件**：已 upsert doc1；配 FTS
- **测试步骤**：`engine.update([{ id:'doc1', fields:{ tag:'B' } }])`（无 vector/text）
- **预期结果**：zvec `updateSync` 要求 dense vector → 抛错（`ZVEC_WRITE_ERROR` 或 `InconsistentUpdateError`）；确认实现是否显式拦截
- **注**：闭合原「已知缺口」TC-Z-03

#### TC-REQ-01-56：send 非 open 状态 → WorkerUnavailableError

- **关联需求**：REQ-01 / `proxy.send` 状态守卫
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：已 close
- **测试步骤**：`engine.info()`
- **预期结果**：reject `WorkerUnavailableError`（worker not open）

#### TC-REQ-01-57：close drain 超时 → CloseTimeoutError（内部消化）

- **关联需求**：REQ-01 / `proxy.waitForDrain`
- **测试策略**：否定型/性能
- **优先级**：P2
- **前置条件**：upsert 大批未完成
- **测试步骤**：`engine.close(1)`（drainTimeoutMs=1）
- **预期结果**：drain 超时 → `drained=false` → 仍 terminate 不卡死（`CloseTimeoutError` 内部消化，close resolve）

#### TC-REQ-01-58：probe CollectionLockedException 快速分支 + UNKNOWN fallback

- **关联需求**：REQ-01 / probe 错误映射
- **测试策略**：数据型
- **优先级**：P2
- **前置条件**：(a) 构造 zvec 快速抛 lock 错（非超时）；(b) 构造未识别错误
- **测试步骤**：分别 probe
- **预期结果**：(a) `locked:true`（走 `CollectionLockedException` 分支而非超时）；(b) `{ exists:true, locked:false, healthy:false, error:'UNKNOWN' }`
- **注**：smoke 仅覆盖超时分支

#### TC-REQ-01-60：filter op 变体 + boolean 渲染 + not 正常路径

- **关联需求**：REQ-01 / B-12 / `compileFilter`
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：已 upsert 含 BOOL/数值字段
- **测试步骤**：分别用 `==`(→=)/`!=`/`>`/`<`/`>=`/`<=` 与 boolean 值 `listIds`；`{ not:{ field:'tag', op:'==', value:'A' } }`
- **预期结果**：op 正确翻译；boolean 渲染为 `true`/`false`；`not` 返回非 A 的 doc

#### TC-REQ-01-61：worker 错误序列化往返（类型/code/data 保持）

- **关联需求**：REQ-01 / `worker-protocol` serialize/deserialize
- **测试策略**：数据型
- **优先级**：P1
- **前置条件**：触发一个携带 code/data 的 worker 错误（如 `InvalidDocInputError` 经未声明字段）
- **测试步骤**：主线程 catch；断言 `instanceof` 原类型 + `code`/`data` 字段保持
- **预期结果**：跨线程反序列化重建类型化异常，字段不丢失

### D. Embedding 补充

#### TC-REQ-03-14：网络错误（fetch reject）→ EmbeddingError(NETWORK) 可重试

- **关联需求**：REQ-03 / siliconflow 网络错分支
- **测试策略**：否定型
- **优先级**：P1
- **前置条件**：mock fetch 抛 `TypeError`；retries=2，第 3 次 200
- **测试步骤**：`provider.embed(['x'], { retries:2 })`
- **预期结果**：重试后成功；中间错误 `code='NETWORK'`，`nonRetryable=false`

#### TC-REQ-03-15：Retry-After HTTP 日期格式

- **关联需求**：REQ-03 / `parseRetryAfter`
- **测试策略**：数据型
- **优先级**：P2
- **前置条件**：mock fetch 429 + header `retry-after: <RFC1123 未来日期>`
- **测试步骤**：`provider.embed(['x'], { retries:1 })`
- **预期结果**：按日期差计算退避（非指数）

### E. 检索补充

#### TC-REQ-04-19：weighted 融合带 weights 正常路径

- **关联需求**：REQ-04 / §4.3 weighted（实验性）
- **测试策略**：功能型
- **优先级**：P2
- **前置条件**：已 upsert
- **测试步骤**：`hybridSearch({ queryText:'x', fts:'y', rerank:{ type:'weighted', weights:{ dense:0.7, content:0.3 } } })`
- **预期结果**：返回非空，不崩溃（数值主导性记录供评估）

#### TC-REQ-04-20：rerank.rankConstant 自定义值

- **关联需求**：REQ-04 / RRF `rankConstant` 默认 60
- **测试策略**：功能型
- **优先级**：P2
- **前置条件**：已 upsert
- **测试步骤**：`hybridSearch({ queryText, fts, rerank:{ type:'rrf', rankConstant:30 } })`
- **预期结果**：成功返回（rankConstant 透传 worker）

### F. B-13 索引管理

#### TC-B13-01：createIndex/dropIndex/optimize 契约

- **关联需求**：REQ-01 / B-13
- **测试策略**：功能型
- **优先级**：P2
- **前置条件**：已 create + upsert
- **测试步骤**：(a) `createIndex('tag', { indexType:'INVERT' })` 后 `listIds` 带 filter 正常；(b) `optimize()` 后 `info.docCount` 不变；(c) `dropIndex('tag')` 后过滤仍可用（扫描）
- **预期结果**：三操作不抛错，语义符合

---

## 覆盖矩阵

### REQ → 用例

| 需求 ID | 验收标准 | 测试策略 | 用例数 | 用例 ID |
|---|---|---|---|---|
| REQ-01 | 引擎层封装，`which mem` 缺失时仍工作 | 功能+否定+数据 | 46 | TC-REQ-01-01~61（含 w 系列 + 补充 47~61） |
| REQ-03 | 缺 apiKey 清晰报错 | 否定+功能 | 15 | TC-REQ-03-01~15 |
| REQ-04 | 代码符号精确命中 + 混合检索 | 功能+度量+否定 | 20 | TC-REQ-04-01~20 |
| REQ-07 | Recall@5≥90%、<5ms | 度量+性能 | 5 | TC-T-02, TC-PERF-01~04 |
| REQ-09（基座支撑） | 常驻保活/崩溃恢复 | — | 0 | T-05 二期，上层负责 |

### B-xx 能力 → 用例

| 能力 | 说明 | 用例 ID |
|---|---|---|
| B-01 集合创建即打开 | create | TC-REQ-01-01~17 |
| B-02 集合打开/tryOpen/probe | open | TC-REQ-01-15~17, 40~46 |
| B-03 集合信息 | info | TC-REQ-01-01, 30 |
| B-04 文档写入 upsert | upsert | TC-REQ-01-23~26, 30, 31, 36 |
| B-05 文档插入 insert | insert 防覆盖 | TC-REQ-01-29 |
| B-06 文档更新 update | update 联动 | TC-REQ-01-27, 28, 55 |
| B-07 文档删除 delete | delete | TC-REQ-01-29b |
| B-08 文档取回 fetch | fetch | TC-REQ-01-32, 33 |
| B-09 向量/语义检索 | semantic/vectorSearch | TC-REQ-04-01, 02, 10 |
| B-10 FTS 检索 | ftsSearch | TC-REQ-04-03, 09 |
| B-11 混合检索 | hybridSearch | TC-REQ-04-04~08, 18~20 |
| B-12 标量过滤 Filter | filter | TC-REQ-01-18~22, 60, TC-REQ-04-17 |
| B-13 索引管理 | createIndex/dropIndex/optimize | TC-B13-01 |
| B-14 Embedding 抽象 | provider | TC-REQ-03-01~15 |
| B-15 列出文档 id | listIds | TC-REQ-01-34, 35, 47 |
| B-16 健康检查/锁/关闭 | isHealthy/isLocked/isOpen/close/probe | TC-REQ-01-38, 40~45, w-20~22 |

### Z-xx 契约 → 用例

| 契约 | 用例 ID | 状态 |
|---|---|---|
| Z-01 不传显式 undefined | TC-Z-01 | 待实现 |
| Z-02 vectors/fields 至少 {} | TC-Z-02 | 待实现 |
| Z-03 update dense vector 必填 | TC-Z-03, TC-REQ-01-55 | 待实现 |
| Z-04 持锁不无限阻塞 | TC-Z-04 | ✅ |
| Z-05 probe 不传 collectionName | TC-Z-05 | ✅ |
| Z-06 worker ESM 静态 import | TC-Z-06 | ✅ |
| 嵌入失败文档剔除 | TC-Z-07 | ✅ |

---

## 未覆盖需求 / 已知缺口

| 项 | 原因 | 处置 |
|---|---|---|
| B-13 索引管理 | 已补 TC-B13-01 | ✅ 闭合 |
| listIds 默认值/上限契约偏差 | 实现 `DEFAULT_LIST_IDS_LIMIT=10_000` 与契约「默认 1000」**不符**；且未做 >10000 上限校验（直接透传 worker） | 已补 TC-REQ-01-47（核对+驱动修正） |
| update 仅 fields（Z-03） | zvec `updateSync` 要求 dense vector 必填 | 已补 TC-REQ-01-55（明确抛错路径） |
| T-05 worker 自动重 spawn | 二期健壮性 | REQ-09 上层负责 |

## 非功能性测试

| NFR（§5） | 用例 | 说明 |
|---|---|---|
| 维度校验铁律 | TC-REQ-01-02, 16, 25 | create/open/upsert 三处 |
| 度量限定 COSINE | TC-REQ-01-03, TC-REQ-04-14 | 非 COSINE 拒绝 |
| score 归一化 | TC-REQ-04-01, 13, 15 | 1/(1+distance) + clamp + NaN 丢弃 |
| FTS 分词器强制 | TC-REQ-01-11, TC-REQ-04-03 | jieba 默认，禁 standard |
| filter 转义防注入 | TC-REQ-01-19, 20, 22 | 白名单 + 单引号 + 反斜杠 |
| 错误分层 | TC-REQ-01-23~26, 29 | 批级抛异常 vs 文档级 errors[] |
| topk 边界 | TC-REQ-04-11 | 默认 10，上限 1000 |
| 锁协调 | TC-REQ-01-15, 42, 44, Z-04 | 单句柄 + probe 超时 |
| 时延 <5ms | TC-PERF-01~03 | 纯引擎路 |
| 版本锁定 | （部署校验，非单测） | `@zvec/zvec@0.6.0` 锁版本 |

## 风险测试（R-01~R-06）

| 风险 | 用例 | 处置 |
|---|---|---|
| R-01 FTS 单分词器 vs 代码符号 | TC-T-01 | 真实语料实测；不满足则改双 FTS 字段 |
| R-02 EmbeddingProvider 跨 worker | TC-REQ-01-23w | 方案 X 已锁定，验证 Transferable 完整性 |
| R-03 embed 失败粒度 | TC-REQ-01-23, 24, Z-07 | 小批失败 + 预计算 vector 不受影响 |
| R-04 Filter 转义注入 | TC-REQ-01-19, 20 | 白名单 + 转义 |
| R-05 worker 入口打包 | TC-Z-06 | tsc ESM 产物 + new Worker 路径 |
| R-06 score 公式真实验证 | TC-T-02 | 真实 embedding 下自检索≈1、不相关≈1/3 |

---

## 实施优先级

| 批次 | 范围 | 用例 | 依赖 |
|---|---|---|---|
| P0 已完成 | smoke 14 | TC-REQ-01-02,04,05,09,18,23,24,27,30,40,41,42,43,45 | 已通过 |
| P0 新增（纯 mock，可立即实现） | Schema/Filter/Embedding/Search/契约 | TC-REQ-01-01,03,06~08,10~17,19~22,25,26,28,29,29b,31~38,46；TC-REQ-03-01~13；TC-REQ-04-01~18；TC-Z-01~03,07 | 仅 tsc 产物 + mock |
| P1 性能 | TG-08 | TC-PERF-01~04 | hash 向量，无网络 |
| P1 真实环境 | TG-09 | TC-T-01,02,04 | SiliconFlow API + 语料 |

## 验证方式

- 打开本文件 → 检查覆盖矩阵 → 确认 REQ-01/REQ-03/REQ-04 与 B-01~B-16、Z-01~Z-06 全覆盖
- 随机挑 TC-REQ-03-07（重试）、TC-REQ-04-05（互斥）、TC-Z-03（update 必填 vector）→ 检查步骤可执行、通过标准可判定
- 实现后跑 `npm run build:zvec-engine && npm run test:zvec-engine`，逐批补齐用例至 `test/zvec-engine.test.mjs`（或拆分为多文件）
