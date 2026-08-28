---
kind: configuration_system
name: ki 配置系统：YAML/JSON 配置文件 + 字段级 Schema 校验 + 进程内缓存
category: configuration_system
scope:
    - '**'
---

## 1. 系统概览

kisearch 使用自研的轻量配置加载器，集中管理知识库路径、向量引擎、Embedding 提供商、scope 映射与 MCP HTTP 传输等运行时参数。核心由 `src/lib/config.ts`（加载与解析）、`src/lib/config-schema.ts`（字段级 Schema 校验）和 `src/config.ts`（`ki config init` 模板生成）三部分组成，并通过 `docs/configuration.md` 对外文档化。

## 2. 配置文件来源与优先级

配置加载顺序严格遵循以下优先级（找到即用，后项不生效）：

1. `--config <path>` 命令行参数（按扩展名 `.yaml/.yml` 走 YAML 解析，`.json` 走 JSON 解析）
2. 环境变量 `KI_CONFIG_PATH` 显式指定的路径
3. `$HOME/.ki/config.yaml`
4. `$HOME/.ki/config.yml`
5. `$HOME/.ki/config.json`
6. 内置默认值（无配置文件时输出提示并回退到默认）

配置文件查找入口为 `loadConfig(explicitPath?)`，首次调用后结果以模块级 `_cached` 变量缓存，后续调用直接返回；测试通过 `resetConfigCache()` 清除缓存。

## 3. 配置结构与默认值

### 顶层 KiConfig 结构

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dataDir` | string | `~/.ki/kb` | KB 源数据目录，相对路径基于配置文件所在目录展开 |
| `backupDir` | string | `~/.ki/backup` | 备份目录 |
| `vectorDir` | string | `~/.ki/vector` | zvec collection 目录 |
| `embedding` | EmbeddingConfig | siliconflow/Qwen/Qwen3-Embedding-8B/4096 | 向量嵌入提供商配置 |
| `scopeMode` | 'default' \| 'strict' | 'default' | scope 护栏模式 |
| `scopes` | Record<string, ScopeConfig> | {} | scope → KB 目录映射 |
| `mcp.http` | McpHttpConfig | host=127.0.0.1, port=7423 | MCP HTTP 传输默认值 |

### embedding.apiKey 解析规则

支持两种写法（二选一），**不做任何隐式 env 回退**：
- 明文密钥：`apiKey: sk-xxxx`
- 环境变量引用：`apiKey: ${VAR_NAME}` → 从 `process.env.VAR_NAME` 读取，未设置则返回 undefined（由 KI 层 fail-loud）

此外，zvec 侧的 siliconflow 客户端在缺失配置时还会回退读 `SILICONFLOW_API_KEY` 环境变量（属于 embedding 实现细节，非配置层行为）。

### scope 护栏（resolveScope）

- `default` 模式：scope 缺省/空 → `'default'`，任意值放行（zvec 自动建）
- `strict` 模式：必须显式传入非空 scope，且必须在 `config.scopes` 白名单中，否则抛错

## 4. 字段级 Schema 校验（fail-loud）

所有配置在 YAML/JSON 语法解析成功后、宽容归一化之前，会调用 `validateConfigFields(raw)` 进行字段级校验（名称 + 类型 + 取值）。校验策略：

- **未知字段名** → 报错，附 Levenshtein 相近字段建议（如 `datadir` → `dataDir`）
- **类型不符** → 报错（如 `dimension: "4096"` 应为 number）
- **非法枚举/取值** → 报错（如 `scopeMode: strick`、端口不在 1-65535、baseURL 非 http(s) URL）
- **废弃字段**（如 `scopes.<scope>.sourceDir`）→ 仅告警，仍按“被忽略”加载，不打破存量配置
- **YAML 裸写 `default:`（解析为 null）** → 仅告警，该 scope 被丢弃
- **空字符串字段** → 仅告警，实际按“未配置”落默认值
- **YAML 合并键 `<<: *anchor`** → 报错（`yaml` 库不展开合并，该写法本就不生效）
- **根层 `x-` 前缀键** → 放行（作为锚点模板载体）

错误一次性收集全部问题（最多展示 10 条，超出提示“另有 N 处”），错误前缀为 `CONFIG_FIELD_INVALID`；校验失败时所有 ki 命令（含 `ki mcp` 启动）直接报错退出。

## 5. 路径展开与默认数据目录

- 路径中的 `$HOME` / `~` 会被展开为 `os.homedir()`
- 相对路径相对于配置文件所在目录解析
- `resolveDefaultDataPaths(includeEnv?)` 提供统一默认路径逻辑：`dataDir=~/.ki/kb`、`backupDir=~/.ki/backup`；仅 `includeEnv=true`（`ki config init` 模板生成）时允许 `KI_DATA_DIR` 覆盖
- 运行时（`loadConfig`）**不做**环境变量回退——这是明确的设计约束（见注释「KI_DATA_DIR 不作运行时配置来源」）

## 6. 配置写回能力

`removeScopeFromConfigFile(scope)` 可从配置文件的 `scopes` 中移除指定 scope 条目：
- YAML：使用 `yaml` Document API 保留注释与格式
- JSON：解析后删除再写回
- 写回后调用 `resetConfigCache()` 清除进程内缓存
- 无配置文件或 scope 不存在 → 返回 `{ removed: false }`（非错误）

## 7. 配置管理 CLI

`src/config.ts` 暴露 `ki config init` 子命令：
- 生成带注释的 YAML 模板到 `$HOME/.ki/config.yaml`（支持 `--dir` 指定目录、`--force` 覆盖已有）
- 同时创建 `dataDir` / `backupDir` / `vectorDir` 三个目录（REQ-15）
- 幂等检查：已存在且不传 `--force` 时输出提示而非覆盖

## 8. 测试与 E2E 隔离

- 测试通过 `test/test-config.ts` 在每个测试进程创建临时配置文件（`mkdtempSync`），写入 `KI_CONFIG_PATH` 指向该文件，确保测试互不干扰
- E2E 环境使用 `.e2e-run/ki-config.yaml` + `env.sh` 中的 `KI_CFG` 指向隔离配置
- 测试中可通过 `registerTestScope(scope)` 动态向临时配置追加 scope 注册

## 9. 关键约定与约束

- 配置文件优先 YAML，其次 JSON（读到旧版 `.json` 时打印一次迁移提示）
- MCP token **绝不**写入配置文件，只走 CLI 参数或环境变量（`KI_MCP_TOKEN`）
- 运行时数据恒落用户目录 `~/.ki/`，不随安装位置漂移
- 新增 scope 需在 `scopes` 中显式注册（`strict` 模式下强制）
- 向量库 schema 是创建时白名单，增加字段需删 `vectorDir` 重建（会丢失该 scope 全部向量数据）
- 配置变更需重启服务（`ki mcp --http`）才生效