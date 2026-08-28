# 配置指南

kisearch 通过一个 YAML/JSON 配置文件集中管理数据目录、向量引擎、Embedding、scope 映射与导入/清洗等行为。本文档说明配置文件的查找顺序、全部配置项及其默认值，并给出完整示例。

---

## 配置文件位置

配置文件按以下优先级查找（找到即用，后项不生效）：

1. `--config <path>` 命令行参数（按扩展名判定 YAML/JSON 解析器）
2. 环境变量 `KI_CONFIG_PATH` 显式指定路径
3. `$HOME/.ki/config.yaml`
4. `$HOME/.ki/config.yml`
5. `$HOME/.ki/config.json`
6. 内置默认值（无配置文件时）

> 提示：`config.yaml` 支持 YAML 语法；`config.json` 支持 JSON 语法。两者配置项结构完全一致，可互相转换。

配置管理 CLI 提供 `init` 子命令：

- `ki config init` — 生成配置文件模板到 `.ki/config.yaml`（含 `--dir` 指定目录、`--force` 覆盖已有）
- 配置项的实际读取/写入通过**手动编辑配置文件**完成（见下文"配置修改"）

---

## 顶层结构

> 以下为**字段概览**（冒号后是说明文字，不是值），不要直接复制为配置文件：这样写会让每个字段解析为 null，`ki doctor` 会报「值为空」。

```text
dataDir     # KB 源数据目录
backupDir   # 备份目录
vectorDir   # zvec 向量库 collection 目录
embedding   # Embedding 提供商配置
scopeMode   # scope 护栏模式（default | strict）
scopes      # scope → KB 目录映射
mcp         # MCP HTTP 传输默认值
```

---

## 配置项详解

### `dataDir`

KB 源数据目录，存放各 scope 的原始文档。

- **类型**：`string`
- **默认值**：`~/.ki/kb`（无显式配置时；不做存量路径继承——旧默认 `{项目根}/kb` / `~/.ki-data` 不再自动沿用，请迁移数据或在此显式配置）
- **说明**：相对路径会基于配置文件所在目录展开。运行时数据默认落用户目录，不随安装位置（源码仓库）漂移。
- **与 `scopes.<scope>.kbDir` 的回退关系**：某 scope 的实际数据目录 = `scopes.<scope>.kbDir`（配置了则拼 `kb/{scope}`）**或** `dataDir/{scope}`（未配置 kbDir 时）。即 `dataDir` 是 scope 级 `kbDir` 的**回退默认**；两者可同时配置，`kbDir` 优先。

### `backupDir`

备份目录，`ki backup` 等命令写入的位置。

- **类型**：`string`
- **默认值**：`~/.ki/backup`（无显式配置时；旧默认 `{项目根}/ki-backup` 不再自动沿用）

### `vectorDir`

zvec 向量库 collection 目录，存储向量数据与索引。

- **类型**：`string`
- **默认值**：`~/.ki/vector`
- **说明**：⚠️ 向量库 schema 是创建时白名单（无 alter/drop API）。**增加字段需删 vectorDir 重建，会丢失该 scope 全部向量数据并需重新导入**。

### `embedding`

Embedding 提供商配置。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | `string` | `siliconflow` | `siliconflow` \| `openai-compatible`（OpenAI 兼容客户端，实际提供商由 baseURL 决定） |
| `baseURL` | `string` | `https://api.siliconflow.cn/v1` | API 端点，决定实际对接的提供商 |
| `model` | `string` | `Qwen/Qwen3-Embedding-8B` | 模型名称 |
| `dimension` | `number` | `4096` | 向量维度，必须等于 collection.dimension（kisearch 固定 4096） |
| `apiKey` | `string` | 无 | 密钥：支持明文 `sk-xxx` 或环境变量引用 `${VAR_NAME}`；缺省则不解析（KI 层 fail-loud，不做隐式 env 回退） |

```yaml
embedding:
  provider: siliconflow
  baseURL: https://api.siliconflow.cn/v1
  model: Qwen/Qwen3-Embedding-8B
  dimension: 4096
  apiKey: ${SILICONFLOW_API_KEY}
```

> **安全建议**：`apiKey` 优先使用环境变量引用 `${VAR_NAME}`，不要把密钥明文写入配置文件。

### `scopeMode`

scope 护栏模式。

- **类型**：`'default' | 'strict'`
- **默认值**：`default`
- **说明**：
  - `default`：允许使用未在 `scopes` 显式注册的 scope（按需传入 scope 名即可）
  - `strict`：`scopes` 的 key 兼作 scope 白名单，必须显式传入已注册的 scope，否则报错（fail-loud）

### `scopes`

scope → KB 目录映射。每个 scope 可独立配置数据来源与导入/清洗行为。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `kbDir` | `string` | 无 | KB **基础目录**。程序自动拼接 `kb/{scope}` 子目录（如 `kbDir=/data/kb`、scope=monitor → 实际数据目录 `/data/kb/kb/monitor`），**不要**在 `kbDir` 里带上 scope 名。未配置时回退到 `dataDir/{scope}` |
| `wikiSync` | `object` | — | wiki 写回/回收站的源目录定位（`sourceDir`）与开关（`enabled`）|
| `clean` | `object` | — | 数据清洗配置 |
| `import` | `object` | — | 导入配置 |

> 注：顶层 `scopes.<scope>.sourceDir` 已废弃删除——导入源记录由 group-index 的 source 块承载；Wiki 源目录请配置在 `wikiSync.sourceDir`。旧配置文件中残留的该字段仍会被忽略（不阻断加载），但会在 `ki doctor` 报告中以 ⚠️ 提示迁移。

```yaml
scopes:
  monitor:
    kbDir: /data/kb
    wikiSync:
      enabled: true
      sourceDir: /repo/bk-monitor-wiki/wiki
```

#### `scopes.<scope>.wikiSync`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否启用 Wiki 写回（显式 `false` 时禁用一切写回，含 source 块路径）|
| `autoBackfill` | `boolean` | `true` | 写回时检测 wiki 目标目录不存在/为空则自动全量补齐历史关系（`ki wiki-backfill` 手动补齐不受此开关影响）|
| `sourceDir` | `string` | 无 | 源文档目录 |

#### `scopes.<scope>.clean`

数据清洗配置（REQ-06/07）。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 总开关，`false` 等效 `--no-clean`（连 hooks 一起关闭） |
| `rules` | `object` | 全部开启 | 内置清洗规则逐项开关 |
| `hooks` | `string[]` | 无 | 外部清洗钩子命令（stdin→stdout 管道，按序执行） |

`rules` 支持的子项及作用（默认均开启）：

| 规则 | 作用 |
|------|------|
| `bom` | 剥离 UTF-8 BOM（`\uFEFF`） |
| `frontmatter` | 剥离 YAML frontmatter 整块（`---` 开头，含闭合边界校验） |
| `htmlComment` | 剥离 HTML 注释（`<!-- ... -->`） |
| `mermaid` | 剥离 mermaid 代码块（``` ```mermaid ```） |
| `codePath` | 剥离文件路径文本（模式识别，仅代码块外的路径） |
| `codeBlock` | 剥离代码块（``` ``` 包裹的整块） |
| `keepShortSamples` | 保留 ≤15 行的短代码示例（默认 true，须与 `codeBlock` 搭配理解：开启时短代码示例不剥离） |
| `emptyChunk` | 过滤空 chunk（在切分后执行，不在 clean 函数内） |

> 执行顺序：代码块先剥离（`keepShortSamples` 保留 ≤15 行原样）→ 路径剥离仅作用于代码块外文本。

#### `scopes.<scope>.import`

导入配置（REQ-08）。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `extensions` | `string[]` | `[.md]` | 格式白名单，导入时过滤不支持的扩展名 |
| `maxFileSize` | `number` | `1048576`（1MB） | 单文件大小上限（字节），超限跳过 |

### `mcp`

MCP HTTP 传输默认值（子字段挂在 `mcp.http` 下）。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mcp.http.host` | `string` | `127.0.0.1` | 监听地址（回环免鉴权；对外监听改 `0.0.0.0`） |
| `mcp.http.port` | `number` | 内置默认端口 | 监听端口（1-65535） |
| `mcp.http.allowedHosts` | `string[]` | 无 | DNS rebinding 保护允许的 Host 头 |

**优先级**：`mcp.http` 是**传输默认值**，实际生效顺序为 `--host/--port` CLI 参数 > `mcp.http.host/port` 配置 > 内置默认（`127.0.0.1` / `7423`）。即命令行参数优先于配置文件。

> **安全说明**：MCP 接入 token 只走 CLI 参数或环境变量，**绝不写入配置文件**。

---

## 完整示例

以下是一份完整的 `config.yaml` 示例：

```yaml
dataDir: /data/kb
backupDir: /data/ki-backup
vectorDir: /root/.ki/vector

embedding:
  provider: siliconflow
  baseURL: https://api.siliconflow.cn/v1
  model: Qwen/Qwen3-Embedding-8B
  dimension: 4096
  apiKey: ${SILICONFLOW_API_KEY}

scopeMode: default

scopes:
  monitor:
    # kbDir 为基础目录，程序自动拼接 kb/{scope}，实际数据目录 = /data/kb/kb/monitor
    kbDir: /data/kb
    wikiSync:
      enabled: true
      sourceDir: /repo/bk-monitor-wiki/wiki
    clean:
      enabled: true
      rules:
        bom: true
        frontmatter: true
        htmlComment: true
        mermaid: true
        codePath: true
        codeBlock: true
        emptyChunk: true
        keepShortSamples: true
      hooks: []
    import:
      extensions: [.md]
      maxFileSize: 1048576
  docs:
    kbDir: /data/kb

mcp:
  http:
    host: 127.0.0.1
    port: 7423
    allowedHosts: [localhost]
```

---

## 字段校验

配置文件在**语法解析成功后**还会做一次字段级校验（字段名 + 类型 + 取值），避免过去「拼错的字段静默落默认值、类型错变成 NaN」带来的隐性错配。规则：

| 情况 | 行为 |
|------|------|
| 字段名不在白名单（如 `datadir`） | ❌ 报错，附相近字段建议（“您是否想输入 `dataDir`？”）+ 该层可用字段列表 |
| 类型不符（如 `dimension: "4096"`） | ❌ 报错，指出期望类型与实际值 |
| 只写键名未赋值（如 `dataDir:` 后空着） | ❌ 报错，提示“实际为 null（只写了键名未赋值？）” |
| 取值非法（如 `scopeMode: strick`、`port: 99999`、`baseURL` 非 http(s) URL） | ❌ 报错，列出合法取值范围 |
| 废弃字段（`scopes.<scope>.sourceDir`） | ⚠️ 仅告警，仍按“被忽略”加载 |
| YAML 裸写 `default:`（解析为 null） | ⚠️ 仅告警，该 scope 被丢弃 |
| 字符串字段写空值（`dataDir: ""`） | ⚠️ 仅告警，实际按“未配置”落默认值 |
| YAML 合并键 `<<: *anchor` | ❌ 报错（`yaml` 库不展开合并，该写法本就不生效） |
| 根层 `x-` 前缀键（锚点模板载体） | ✅ 放行，见下方“YAML 锚点”说明 |

一次性列出全部错误（最多 10 条，超出提示“另有 N 处”），错误前缀为 `CONFIG_FIELD_INVALID`：

```text
❌ 配置加载失败：CONFIG_FIELD_INVALID: 配置文件字段校验失败：/root/.ki/config.yaml（共 2 处）
  - datadir：非预期字段，您是否想输入 "dataDir"？（可用：dataDir | backupDir | ...）
  - embedding.dimension：应为数字，实际为 string（4096）
提示：字段含义与合法取值见 docs/configuration.md
```

> - 校验失败时**所有 ki 命令（含 `ki mcp` 启动）都会直接报错退出**，不会带着错配继续跑。修好配置后重试。
> - `ki doctor` 会展示加载成功后的残余 ⚠️ 告警（`配置字段` 检查项）。
> - scope 名本身是用户自定义的自由键（如 `monitot` 这种拼错的业务名）**不会**被当作未知字段报错，只有配置字段名参与校验。
> - 空配置文件（仅注释）合法，全部走内置默认值。
> - **YAML 锚点**：整值引用可用，根层模板键建议以 `x-` 开头（这类键不参与字段名校验）：
>   ```yaml
>   x-common: &tpl
>     kbDir: /data/tmpl
>   scopes:
>     p: *tpl        # ✅ 可用：解析器会展开别名
>   ```
>   但**合并键 `<<:` 不可用**（`yaml` 库保留字面量 `<<`、不做合并），下面的写法会直接被校验拦下：
>   ```yaml
>   scopes:
>     p:
>       <<: *tpl     # ❌ 报错：看起来在合并，实际什么也不会发生
>   ```

---

## 配置修改

配置项通过**编辑配置文件**完成。首次使用可先生成模板再修改：

```bash
# 生成配置文件模板到 ~/.ki/config.yaml（--dir 指定目录，--force 覆盖已有）
ki config init
# 手动编辑配置文件
vi ~/.ki/config.yaml
```

修改后重新运行 `ki` 命令即生效（配置在命令启动时加载）。若已在运行 `ki mcp --http`，需重启服务以加载新配置。

---

## 相关文档

- [`docs/cli.md`](./cli.md) — CLI 命令完整参考
- [`docs/vector-engine-mem.md`](./vector-engine-mem.md) — 向量引擎（zvec）设计说明
- [`docs/tags-design.md`](./tags-design.md) — 三层标签设计
- [`docs/scan-kb.md`](./scan-kb.md) — 导入流程详解
