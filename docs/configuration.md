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

```yaml
dataDir:     # KB 源数据目录
backupDir:   # 备份目录
vectorDir:   # zvec 向量库 collection 目录
embedding:   # Embedding 提供商配置
scopeMode:   # scope 护栏模式（default | strict）
scopes:      # scope → KB 目录映射
mcp:         # MCP HTTP 传输默认值
```

---

## 配置项详解

### `dataDir`

KB 源数据目录，存放各 scope 的原始文档。

- **类型**：`string`
- **默认值**：`<项目根>/kb`
- **说明**：相对路径会基于配置文件所在目录展开。
- **与 `scopes.<scope>.kbDir` 的回退关系**：某 scope 的实际数据目录 = `scopes.<scope>.kbDir`（配置了则拼 `kb/{scope}`）**或** `dataDir/{scope}`（未配置 kbDir 时）。即 `dataDir` 是 scope 级 `kbDir` 的**回退默认**；两者可同时配置，`kbDir` 优先。

### `backupDir`

备份目录，`ki backup` 等命令写入的位置。

- **类型**：`string`
- **默认值**：`<项目根>/ki-backup`

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
| `sourceDir` | `string` | 无 | 外部源目录（供 wiki 同步 / 增量导入） |
| `rootName` | `string` | 无 | 导入根路径名 |
| `wikiSync` | `object` | — | wiki 同步配置 |
| `clean` | `object` | — | 数据清洗配置 |
| `import` | `object` | — | 导入配置 |

```yaml
scopes:
  monitor:
    kbDir: /data/kb
    sourceDir: /repo/bk-monitor-wiki/wiki
    rootName: wiki
    wikiSync:
      enabled: true
      sourceDir: /repo/bk-monitor-wiki/wiki
```

#### `scopes.<scope>.wikiSync`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否启用 wiki 同步 |
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

MCP HTTP 传输默认值。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | `string` | `127.0.0.1` | 监听地址（回环免鉴权；对外监听改 `0.0.0.0`） |
| `port` | `number` | 内置默认端口 | 监听端口 |
| `allowedHosts` | `string[]` | 无 | DNS rebinding 保护允许的 Host 头 |

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
    sourceDir: /repo/bk-monitor-wiki/wiki
    rootName: wiki
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
    rootName: docs

mcp:
  host: 127.0.0.1
  port: 7423
  allowedHosts: [localhost]
```

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
