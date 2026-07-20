# S-02 Filter 编译器 · 设计

> 父文档：`ZVEC_ENGINE_DESIGN.md`
> 子需求编号：S-02
> 对应文件：`src/zvec-engine/filter/compiler.ts`

---

## 1. 术语

| 术语 | 含义 | 引用 |
|---|---|---|
| `Filter` | 结构化过滤类型（and/or/not/比较） | 本文件 §4b |
| `ScalarValue` | 标量值（string/number/boolean） | 见 S-01 §4b |
| 字段白名单 | 仅允许 `ZvecEngineConfig.collection.scalarFields` 中已声明的字段名 | 本文件 §3.2 |
| zvec SQL 字符串 | zvec 原生 filter 语法（类 SQL：`tag='ki-relation' AND score > 0.8`） | 外部依赖 |

---

## 2. 现状（AS-IS）

### 2.1 现状描述

v5 §4.3 定义了 `Filter` 联合类型，并约定"基座模块内部转 zvec 字符串语法并转义"，但：
- 未定义**具体转义规则**（字符串值的引号、特殊字符、字段名合法性）
- 未定义**白名单机制**（如何防止未声明字段进入 filter）
- v5 §4.3 还预留了 `{ raw: string }` 逃生口（调用方自负转义），进一步放大注入面

### 2.2 痛点

- 字符串值若含单引号（如 `fields.tag = "it's"`）直接拼进 SQL 会破坏语法
- 字段名若来自外部输入且不校验，可能注入子句（如 `tag='x' OR '1'='1`）
- `{ raw }` 逃生口让"结构化 Filter 防注入"承诺失效

---

## 3. 方案（TO-BE）

### 3.1 方案概述

实现 `compileFilter(filter: Filter, allowedFields: Set<string>): string`，递归下降编译为 zvec SQL 字符串；字段名严格白名单，字符串值统一单引号包裹 + 内部单引号 `\'` 转义，数字/布尔原样输出；**v1 版本不暴露 `{raw}` 逃生口**。

### 3.2 关键决策点

| 决策 | 选择 | 理由 | 备选方案 | 否决原因 |
|---|---|---|---|---|
| 字段名合法性 | **白名单**：仅允许 `scalarFields` 已声明字段 | 编译期拒绝未声明字段，避免穿透 zvec | 正则校验标识符合法性 | 无法防止"合法标识符但未声明"的字段 |
| 字符串值转义 | 单引号包裹 + 内部 `'` → `\'` | 对齐 SQL 惯例，zvec 实测支持 | 双引号包裹 | zvec 文档示例用单引号；双引号在 SQL 中常用于标识符 |
| `{ raw }` 逃生口 | **v1 不暴露** | 防注入承诺 | v1 暴露并标注"可信内部" | 边界模糊，易被误用 |
| 数组值（IN 语法） | v1 不支持 | 保持类型最小 | 支持 `{ field, op: 'IN', value: ScalarValue[] }` | v1 无明确需求，留 v2 |
| 空 `and`/`or` 数组 | 抛 `InvalidFilterError` | 提前发现调用方错误 | 编译为 `1=1` / `1=0` | 静默行为不直观 |
| `not` 嵌套 `not` | 允许（递归编译） | 类型天然支持 | 拒绝 | 类型系统已约束，无需额外限制 |
| 比较符支持范围 | `==`, `!=`, `>`, `<`, `>=`, `<=` | 对齐 v5 §4.3 | 支持 `LIKE` / `MATCH` | 超出 v5 契约，zvec 通配属进阶 |

### 3.3 编译规则

| Filter 节点 | 输出形式 | 示例 |
|---|---|---|
| `{ field: 'tag', op: '==', value: 'ki-relation' }` | `tag = 'ki-relation'` | — |
| `{ field: 'score', op: '>', value: 0.8 }` | `score > 0.8` | — |
| `{ field: 'archived', op: '==', value: false }` | `archived = false` | — |
| `{ field: 'name', op: '==', value: "it's" }` | `name = 'it\'s'` | 单引号转义 |
| `{ and: [f1, f2] }` | `(f1_sql) AND (f2_sql)` | 括号保证优先级 |
| `{ or: [f1, f2] }` | `(f1_sql) OR (f2_sql)` | — |
| `{ not: f1 }` | `NOT (f1_sql)` | — |

**字段名渲染**：直接输出字段名（zvec 侧无引号包裹字段名的语法）；字段名合法性已在白名单阶段保证（白名单本身是合法标识符集合）。

---

## 4. 接口设计 + 数据模型

### 4a. 接口设计

```typescript
// filter/compiler.ts
export function compileFilter(filter: Filter, allowedFields: ReadonlySet<string>): string;
export function buildAllowedFields(scalarFields: ScalarFieldDef[], ftsField?: string): ReadonlySet<string>;
```

| 接口 | 输入 | 输出 | 异常 |
|---|---|---|---|
| `compileFilter` | `Filter` + 白名单 | zvec SQL 字符串 | `InvalidFilterError` |
| `buildAllowedFields` | scalarFields + 可选 ftsField | 白名单 Set | — |

**说明**：`buildAllowedFields` 把 `scalarFields[*].name` + 可选 `fts.field` 合入白名单（FTS 字段也是 STRING 标量，可被过滤）。

### 4b. 数据模型

#### Filter 类型（v5 §4.3 原样继承，去掉 `{raw}` 逃生口）

```typescript
export type Filter =
  | { field: string; op: '==' | '!=' | '>' | '<' | '>=' | '<='; value: ScalarValue }
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter };
```

#### 内部 AST（编译过程）

```typescript
type CompiledClause = string;  // 已编译的 SQL 片段

interface CompileContext {
  allowedFields: ReadonlySet<string>;
  depth: number;               // 防深递归 DoS，上限 32
}
```

---

## 5. 异常处理

| 场景 | 行为 | 是否对外暴露 |
|---|---|---|
| 字段名不在白名单 | 抛 `InvalidFilterError('field "xxx" not declared in scalarFields')` | 是 |
| 字符串值含未转义特殊字符 | 内部转义，不抛错 | 否（透明处理） |
| `and`/`or` 数组为空 | 抛 `InvalidFilterError('and/or requires at least 1 clause')` | 是 |
| 嵌套深度 >32 | 抛 `InvalidFilterError('filter nesting too deep')` | 是 |
| 值类型与 op 不匹配（如 `>` 用于 string） | **不校验**，交给 zvec 报错 | 否（zvec 侧类型错误） |
| `value` 为 `undefined`/`null`/`NaN` | 抛 `InvalidFilterError` | 是 |

---

## 6. 影响范围

| 影响对象 | 影响类型 | 影响描述 | 是否破坏性变更 |
|---|---|---|---|
| `src/zvec-engine/filter/compiler.ts` | 新增 | Filter → SQL 编译 | 否 |
| `src/zvec-engine/types.ts` | 新增（被引用） | `Filter` 类型定义 | 否 |
| `src/zvec-engine/errors.ts` | 引用 | `InvalidFilterError` | 否 |
| v5 §4.3 `{raw}` 逃生口 | **移除** | v1 不暴露 | 是（对 v5 契约的收敛） |

---

## 7. 测试方案

| 类型 | 范围 | 工具 |
|---|---|---|
| 单元测试 | 7 种 Filter 节点编译 | node:test |
| 单元测试 | 白名单拒绝未声明字段 | node:test |
| 单元测试 | 字符串含单引号/双引号/反斜杠/换行的转义 | node:test |
| 单元测试 | 嵌套 32 层上限 | node:test |
| 单元测试 | `and/or` 空数组、null/undefined/NaN 值 | node:test |

不在测试范围内：
- zvec 实际执行 filter 的端到端测试（属 S-06 集成测试）
