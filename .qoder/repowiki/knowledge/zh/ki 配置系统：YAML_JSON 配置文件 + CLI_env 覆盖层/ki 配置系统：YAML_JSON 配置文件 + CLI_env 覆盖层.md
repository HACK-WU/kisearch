---
kind: configuration_system
name: ki 配置系统：YAML/JSON 配置文件 + CLI/env 覆盖层
category: configuration_system
scope:
    - '**'
source_files:
    - src/lib/config.ts
    - src/config.ts
    - docs/configuration.md
    - .e2e-run/ki-config.yaml
    - .e2e-run/ki-config.json
    - src/lib/cli-args.ts
---

## 1. 系统与工具

ki 使用自实现的配置加载器（`src/lib/config.ts`），基于 `yaml` 库解析 YAML，同时兼容 JSON；通过 Commander.js 暴露 `ki config init` 子命令生成带注释的模板。没有引入外部配置框架（如 dotenv、configstore），而是以单文件模块集中实现查找、解析、路径展开、默认值合并与进程内缓存。

## 2. 关键文件

- `src/lib/config.ts` — 核心配置加载、类型定义、默认值、路径展开、scope 护栏、配置写回（删除 scope）
- `src/config.ts` — `ki config init` 子命令，生成 `$HOME/.ki/config.yaml` 模板并创建数据目录
- `docs/configuration.md` — 用户文档，完整描述优先级、字段、示例
- `.e2e-run/ki-config.yaml` / `.e2e-run/ki-config.json` — e2e 隔离配置样例（YAML 与 JSON 双格式）
- `src/lib/cli-args.ts` — 通用 CLI 参数校验工具（未知 flag 检测、数值边界校验）

## 3. 架构与设计约定

### 配置文件查找优先级（严格有序，找到即停）

1. `--config <path>` 命令行参数（按扩展名判定 YAML/JSON 解析器）
2. 环境变量 `KI_CONFIG_PATH` 显式指定路径
3. `$HOME/.ki/config.yaml`
4. `$HOME/.ki/config.yml`
5. `$HOME/.ki/config.json`
6. 内置默认值（无配置文件时输出提示并回退）

### 路径展开规则

- `$HOME` 前缀和 `~` 前缀统一展开为 `os.homedir()`
- 相对路径相对于**配置文件所在目录**解析（非 CWD）
- `resolveDefaultDataPaths()` 提供统一的默认数据/备份目录（`~/.ki/kb`、`~/.ki/backup`），被 `loadConfig` 与 `ki config init` 模板共用，避免逻辑漂移

### 进程内缓存

`loadConfig` 返回对象在进程内缓存一次（`_cached`），测试可通过 `resetConfigCache()` 清除。这保证同一进程多次调用不会重复读盘。

### 配置结构分层

| 层级 | 字段 | 说明 |
|---|---|---|
| 顶层 | `dataDir` / `backupDir` / `vectorDir` | KB 源数据、备份、zvec collection 目录 |
| 向量 | `embedding.provider/baseURL/model/dimension/apiKey` | OpenAI 兼容 embedding 提供商配置 |
| 安全 | `scopeMode: 'default' | 'strict'` | scope 护栏模式 |
| 多租户 | `scopes.<name>.kbDir/wikiSync/clean/import` | 每个 scope 的数据目录映射、Wiki 同步、清洗、导入行为 |
| 传输 | `mcp.http.host/port/allowedHosts` | MCP HTTP 监听默认值（token 不入配置） |

### 密钥处理策略

`embedding.apiKey` 支持两种写法：明文 `sk-xxx` 或环境变量引用 `${VAR_NAME}`（正则 `^\$\{[A-Za-z_][A-Za-z0-9_]*\}$`）。未配置或引用的环境变量为空时，返回 `undefined`，由 KI 层 fail-loud，**不做任何隐式环境变量回退**。MCP token 明确不写入配置文件。

### Scope 护栏

- `default`：未传 scope 时静默落 `default`，任意 scope 自动创建
- `strict`：必须显式传入已注册 scope（`scopes` key 兼白名单），否则抛错
- `resolveScope()` 仅负责模式策略，字符合法性由 `scope.ts::validateScope` 负责

## 4. 约定与约束

- **配置文件位置固定**：用户级目录 `$HOME/.ki/`，运行时数据不落源码仓库，避免随安装位置漂移
- **YAML 优先**：`config.yaml` > `config.yml` > `config.json`；读到旧版 JSON 时会打印迁移提示
- **默认值不可继承**：不沿用旧默认 `{项目根}/kb`、`~/.ki-data`、`{项目根}/ki-backup`，需用户显式配置或迁移数据
- **向量 schema 不可变**：增加字段需删 `vectorDir` 重建，会丢失该 scope 全部向量数据
- **`KI_DATA_DIR` 仅用于 `ki config init` 模板生成**：运行时 `resolveDefaultDataPaths(includeEnv=false)` 忽略该环境变量（见 docs/cli.md 约定）
- **scope 级 `kbDir` 自动拼接 `kb/{scope}`**：不要在 `kbDir` 中带上 scope 名
- **配置修改方式**：手动编辑配置文件；`removeScopeFromConfigFile()` 可写回删除 scope（YAML 用 Document API 保留注释）
- **CLI 参数优先于配置**：如 `mcp.http` 的 host/port 遵循 `--host/--port` > `mcp.http.*` > 内置默认
- **未知 CLI 参数**：通过 `detectUnknownFlags` 检出并给出 Levenshtein 近似的建议参数，输出 JSON 错误契约并退出码 1
- **e2e 隔离**：测试通过 `KI_CONFIG_PATH` 指向独立配置文件，配合 `resetConfigCache()` 保证用例间互不干扰