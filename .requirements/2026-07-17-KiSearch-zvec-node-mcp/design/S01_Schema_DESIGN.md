# S-01 Schema 构建与校验 · 设计

> 父文档：`ZVEC_ENGINE_DESIGN.md`
> 子需求编号：S-01
> 对应文件：`src/zvec-engine/schema/{builder.ts, validator.ts}` + `src/zvec-engine/types.ts`（配置结构）

---

## 1. 术语

| 术语 | 含义 | 引用 |
|---|---|---|
| `ZvecEngineConfig` | `ZvecEngine.create` 的入参，含 dbPath/collection/embedding | 本文件 §4b |
| `ZvecEngineOpenConfig` | `ZvecEngine.open` 的入参，含 dbPath/collectionName/embedding/readOnly/schemaAssert | 本文件 §4b |
| `ScalarFieldDef` | 标量字段定义（name/dataType/indexed） | 本文件 §4b |
| `FtsConfig` | FTS 字段配置（field/tokenizer/filters/jiebaDictDir） | 本文件 §4b |
| `ZVecCollectionSchema` | `@zvec/zvec` 原生 schema 类 | 外部依赖 |
| 铁律校验 | create/open 时必须通过的硬性校验（维度/metric/fts 字段） | 本文件 §3.2 |

---

## 2. 现状（AS-IS）

### 2.1 现状描述

v5 `zvec-base-module.md` §4.1 已用 TS interface 定义了 `ZvecEngineConfig`/`ScalarFieldDef`/`FtsConfig` 的**形状**，并约定了 4 条校验规则（维度、metric 限定、FTS 字段类型、schema 漂移）。但：
- 校验逻辑分散在 §4.1 注释块和 §4.5 方法签名注释里，无单一入口
- 未定义"配置 → `ZVecCollectionSchema` 对象"的转换函数
- 未定义"持久化 schema 读回 → 与 `schemaAssert` 比对"的具体实现

### 2.2 痛点

- 校验规则若不收敛到一处，S-06 engine 与 S-04 worker 重建 schema 时会出现**两份校验逻辑漂移**
- `ZVecCollectionSchema` 的构造细节（fields/vectors 数组、indexParams 嵌套、FtsIndexParam 的 filters/jiebaDictDir）若散落在 engine/worker 中，后续改 schema（如加双 FTS 字段）改动面大

---

## 3. 方案（TO-BE）

### 3.1 方案概述

抽出 `schema/builder.ts`（配置 → ZVecCollectionSchema）与 `schema/validator.ts`（铁律校验 + schemaAssert 比对）两个纯函数模块，被 S-06 engine 与 S-04 worker 双侧复用，保证 schema 相关逻辑单一来源。

### 3.2 关键决策点

| 决策 | 选择 | 理由 | 备选方案 | 否决原因 |
|---|---|---|---|---|
| 校验入口位置 | `validator.ts` 独立模块，engine/worker 双调用 | 单一来源，worker 内重建 schema 时复用 | 校验写在 engine.ts 内 | worker 无法复用，需重复实现 |
| `denseDataType` 默认值 | `FP32` | 与基准对齐；FP16 是省内存进阶项 | 默认 FP16 | 精度损失，Recall 未实测 |
| `tokenizer` 默认值 | `'jieba'`（显式必填，无 undefined） | H-03 实测 standard 中文 FTS 失效 | 允许缺省，缺省时取 standard | 静默失效（中文返回空） |
| `jiebaDictDir` | 可选，缺省用 SDK 内置字典 | v4 实测无需 dictDir 即可初始化 | 必填 | 增加部署负担 |
| `schemaAssert` 比对粒度 | 逐项（dimension/metric/scalarFields/fts）比对，任一不符抛 `SchemaMismatchError` | 防御 schema 漂移，错误信息指向具体字段 | 整体 deepEqual | 错误信息不指向根因 |
| 集合名合法性校验 | 长度 ≥3、正则 `^[a-zA-Z][a-zA-Z0-9_]*$` | `verify_blocking.mjs` 实测 `lk`/`h` 被拒 | 不校验，让 zvec 报错 | 错误信息不友好，且在校验层提前失败 |
| `create` 前路径存在性 | `create` 前检查 `dbPath` 必须不存在 | v4 实测 `path exists` 报错（含空目录） | 自动清空目录 | 破坏性，可能误删用户数据 |

### 3.3 铁律校验清单（create 时）

| # | 校验 | 不符行为 |
|---|---|---|
| V-01 | `collection.name` 匹配 `^[a-zA-Z][a-zA-Z0-9_]{2,}$` | 抛 `InvalidSchemaError` |
| V-02 | `collection.dimension === embedding.dimension` | 抛 `DimensionMismatchError` |
| V-03 | `collection.metric === 'COSINE'` | 抛 `InvalidSchemaError`（本模块不开放 IP/L2） |
| V-04 | 若配 `fts`：`fts.field ∈ collection.scalarFields` 且对应 `dataType === 'STRING'` | 抛 `InvalidSchemaError` |
| V-05 | 若配 `fts`：`fts.tokenizer` 必填，默认 `'jieba'` | 抛 `InvalidSchemaError` |
| V-06 | `scalarFields[*].name` 不与 `denseField` 重名、不互相重名 | 抛 `InvalidSchemaError` |
| V-07 | `dbPath` 不存在（create 前） | 抛 `CollectionAlreadyExistsError` |

### 3.4 open 时校验清单

| # | 校验 | 不符行为 |
|---|---|---|
| O-01 | `dbPath` 存在且含 zvec 集合元数据 | 不存在 → `CollectionNotFoundError`；损坏 → `CollectionCorruptedException` |
| O-02 | `embedding.dimension === 持久化 dimension` | 抛 `DimensionMismatchError` |
| O-03 | 持久化 `metric === 'COSINE'` | 抛 `SchemaMismatchError` |
| O-04 | 若传 `schemaAssert`：逐项比对（dimension/metric/scalarFields/fts） | 抛 `SchemaMismatchError`，附不符字段名 |
| O-05 | 锁状态 | 已被持锁 → `CollectionLockedException` |

### 3.5 zvec 错误 → 类型化异常识别规则（O-01 细化）

worker 内 `ZVecOpen` 抛出的原始错误需按下表映射到本模块的类型化异常；**具体识别规则以 Node 实测为准（见 T-04）**：

| zvec 原始错误特征 | 映射到 | 识别方式（初版假设，待 T-04 实测校准） |
|---|---|---|
| 路径不存在 / ENOENT | `CollectionNotFoundError` | `err.message` 含 `'not found'` / `'ENOENT'` / `'does not exist'` |
| 锁冲突 / LOCK 文件被占 | `CollectionLockedException` | `err.message` 含 `"Can't lock"` / `'LOCK'`（v4 实测 `'Can't lock read-write collection: .../LOCK'`） |
| 元数据损坏 / 反序列化失败 | `CollectionCorruptedException` | `err.message` 含 `'corrupt'` / `'invalid'` / `'parse'` / `'deserialize'` |
| 其他未识别错误 | 原样 re-throw（不包装） | 避免误分类；调用方拿到原始错误 |

---

## 4. 接口设计 + 数据模型

### 4a. 接口设计

#### 对外接口（被 S-06 / S-04 调用）

```typescript
// schema/builder.ts
export function buildCollectionSchema(config: ZvecEngineConfig): ZVecCollectionSchema;
export function collectionNameOf(config: ZvecEngineConfig | ZvecEngineOpenConfig): string;

// schema/validator.ts
export function validateCreateConfig(config: ZvecEngineConfig, dbPathExists: boolean): void;
export function validateOpenConfig(config: ZvecEngineOpenConfig, persistedSchema: PersistedSchema): void;
export function assertSchemaMatch(assert: SchemaAssert, persisted: PersistedSchema): void;
```

| 接口 | 输入 | 输出 | 异常 |
|---|---|---|---|
| `buildCollectionSchema` | `ZvecEngineConfig` | `ZVecCollectionSchema` | `InvalidSchemaError` |
| `validateCreateConfig` | 配置 + dbPath 存在性 | void | `InvalidSchemaError` / `DimensionMismatchError` / `CollectionAlreadyExistsError` |
| `validateOpenConfig` | open 配置 + 持久化 schema | void | `DimensionMismatchError` / `SchemaMismatchError` |
| `assertSchemaMatch` | schemaAssert + 持久化 schema | void | `SchemaMismatchError`（附字段名） |

#### 内部协作接口

- S-06 engine `create`：`validateCreateConfig` → `buildCollectionSchema` → 经 S-04 proxy 发 `create` 消息（携 schema 序列化形式）
- S-04 worker 接收 `create` 消息：反序列化 → `buildCollectionSchema` **再次执行**（双保险，避免主线程与 worker 版本漂移）→ `ZVecCreateAndOpen`
- S-06 engine `open`：worker 返回 `PersistedSchema` → `validateOpenConfig` + 可选 `assertSchemaMatch`

### 4b. 数据模型

#### 配置结构（写自 v5 §4.1，原样继承）

```typescript
// types.ts
export interface ZvecEngineConfig {
  dbPath: string;
  collection: {
    name: string;
    denseField: string;
    dimension: number;
    metric: 'COSINE';
    denseDataType?: 'FP32' | 'FP16';
    scalarFields: ScalarFieldDef[];
    fts?: FtsConfig;
  };
  embedding: EmbeddingProvider;
}

export interface ZvecEngineOpenConfig {
  dbPath: string;
  collectionName: string;
  embedding: EmbeddingProvider;
  readOnly?: boolean;
  schemaAssert?: SchemaAssert;
}

export interface ScalarFieldDef {
  name: string;
  dataType: 'STRING' | 'BOOL' | 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'UINT32' | 'UINT64';
  indexed?: boolean;
}

export interface FtsConfig {
  field: string;
  tokenizer: 'standard' | 'whitespace' | 'jieba';
  filters?: ('lowercase' | 'ascii_folding' | 'stemmer')[];
  jiebaDictDir?: string;
}

export interface SchemaAssert {
  dimension?: number;
  metric?: 'COSINE';
  scalarFields?: ScalarFieldDef[];
  fts?: FtsConfig;
}
```

#### 持久化 schema 读回结构

```typescript
export interface PersistedSchema {
  name: string;
  denseField: string;
  dimension: number;
  metric: string;          // 从 zvec 读回，可能是 'COSINE'/'IP'/'L2'
  denseDataType: string;
  scalarFields: ScalarFieldDef[];
  fts?: FtsConfig;
}
```

#### 文档输入结构（v5 §4.2 原样继承，本文件只是引用入口）

```typescript
export interface DocInput {
  id: string;
  text?: string;
  vector?: number[];
  fields?: Record<string, ScalarValue>;
}
export type ScalarValue = string | number | boolean;
```

---

## 5. 异常处理

| 场景 | 行为 | 是否对外暴露 |
|---|---|---|
| `create` 集合名长度 <3 | 抛 `InvalidSchemaError('collection name must be ≥3 chars')` | 是 |
| `create` 维度不符 | 抛 `DimensionMismatchError` | 是 |
| `create` metric 非 COSINE | 抛 `InvalidSchemaError` | 是 |
| `create` fts.field 未在 scalarFields 声明 | 抛 `InvalidSchemaError` | 是 |
| `create` fts.field 类型非 STRING | 抛 `InvalidSchemaError` | 是 |
| `create` dbPath 已存在 | 抛 `CollectionAlreadyExistsError` | 是 |
| `open` 持久化 metric 非 COSINE | 抛 `SchemaMismatchError` | 是 |
| `open` schemaAssert 任一字段不符 | 抛 `SchemaMismatchError`（附字段名） | 是 |
| `open` embedding.dimension 不符 | 抛 `DimensionMismatchError` | 是 |

---

## 6. 影响范围

| 影响对象 | 影响类型 | 影响描述 | 是否破坏性变更 |
|---|---|---|---|
| `src/zvec-engine/types.ts` | 新增 | 配置/文档/schema 结构 | 否（新模块） |
| `src/zvec-engine/schema/builder.ts` | 新增 | 配置 → ZVecCollectionSchema | 否 |
| `src/zvec-engine/schema/validator.ts` | 新增 | 铁律校验 | 否 |
| `src/zvec-engine/errors.ts` | 新增（被引用） | 6 种异常类型 | 否 |

---

## 7. 待定问题

| 编号 | 问题 | 影响范围 | 建议决策时间 | 负责人 |
|---|---|---|---|---|
| T-01 | jieba 对代码符号标识符（`syncRelation` / `ki/path/to`）的 token 行为是否满足精确召回；若不满足，是否引入双 FTS 字段（content_zh + content_code）。**注**：双 FTS 字段方案的可行性未实测（zvec 是否允许同集合 2 个 FTS 字段未知），若 zvec 不支持，备选方案为改用 `whitespace` 分词 + 应用层二次过滤（牺牲部分中文召回） | S-01, S-05 | 实现完成后 1 周内 | 实现者 |
