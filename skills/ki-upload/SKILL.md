---
name: ki-upload
description: 把本地文档或整个目录上传到远端 ki 并等待导入完成（走 /open/v1，用 httpflex）。触发："上传到 ki"、"推送文档"、"导入这个目录"。
---

# 把文档 / 目录上传到远端 ki

## 概述

**目的**：让"手上有一堆本地文档、要把它们变成远端 ki 里可检索的知识"这件事，一次命令完成，且**不需要在客户端安装 ki**。

**功能**：基于 Python 模块 `httpflex` 调用 ki 的第三方上传接口 `/open/v1`，支持单/多文件（multipart）与整个目录（tar.gz），自动做上传前自检、上传后轮询导入进度，最终输出一行 JSON 供解析。

**使用场景**：
- 用户说"把这些文档 / 这个目录传到 ki"、"推到知识库"、"导入这个目录"时
- 需要把本机文档同步给另一台机器上的 ki（跨机，MCP 工具读不到本机路径）
- 已有 `KI_URL` + `KI_TOKEN`，想把上传做成可重复执行的脚本步骤时
- 不适用：只想查/写单条知识（用 `use_skill("ki-search")` 的 MCP 工具）；文件已在 ki 同机（用 `ki import --source`）

## 什么时候用哪条通道

| 场景 | 通道 | 说明 |
|------|------|------|
| 本机文件 → 远端 ki（**本 skill**） | `/open/v1/import/upload` | 只依赖 curl 级能力，跨机可用，自动切分/向量化 |
| 单条知识写入（已在上下文里的正文） | MCP `ki_sync_relation` | 逐条写，适合短内容；**不做 chunk 切分**，长文档别用 |
| 文件与 ki 同机 | `ki import --source <dir>` | 最快，但前提是同一台机器 |
| 人在浏览器前 | Web 导入页 | 需要人工操作，不可自动化 |

> 判定口诀：**文件在不在你手上、ki 在不在同一台机器**。文件在远端机器上而你在本机 → 只能走本 skill 的上传接口。

## 前置条件

1. **Python ≥ 3.11**（`httpflex` 的要求）
2. **安装 httpflex**（**未发布到 PyPI**，`pip install httpflex` 会失败）：

```bash
# Debian/Ubuntu 等系统的 Python 禁止直接 pip 装包（会报 externally-managed-environment），
# 所以先建虚拟环境再装 —— 不要用 --break-system-packages 绕，那会污染系统 Python：
python3 -m venv .venv && . .venv/bin/activate
pip install "git+https://github.com/HACK-WU/httpflex.git"
# 或指定版本的发布包（版本号按仓库 Release 页为准）：
# pip install "https://github.com/HACK-WU/httpflex/releases/download/v0.1.1-beta/httpflex-0.1.1b0.tar.gz#egg=httpflex"
```

> 装好后**用同一个解释器跑脚本**：`.venv/bin/python scripts/ki_upload.py ...`。
> 用了另一个 python 会报「缺少依赖 httpflex」——这是最常见的踩坑点。

3. **服务地址与 Token**（二选一：命令行参数或环境变量）

```bash
export KI_URL=http://10.0.0.5:7423      # ki 所在机器
export KI_TOKEN=<在 ki 机器上签发>       # ki mcp token generate --scope <库名>
```

> Token 需要覆盖目标库：`--scope prod` 就得有 `prod` 的授权，否则 403。
> 不确定权限？先跑 `ping`，它会把 `scopes` 和 `limits` 一起打回来。
> 上传命令也会先自动 `ping` 一次（预检），因此**越权和超限都会在上传前就被拦下**，不会白传一整包。

## 四条命令

脚本位置：`scripts/ki_upload.py`（**执行**，不要读进上下文改写）

### 1. 自检

```bash
python scripts/ki_upload.py ping
# 或指定库，看该库的真实上限
python scripts/ki_upload.py ping --scope prod
```

### 2. 上传一组文件

```bash
python scripts/ki_upload.py upload ./a.md ./sub/b.md --scope prod --group wiki
```

`filename` 会保留相对目录（`sub/b.md` 落在 `sub/` 下）。文件数 > 300 时请改用 `upload-dir`。

### 3. 上传整个目录

```bash
python scripts/ki_upload.py upload-dir ./docs --scope prod
```

**打包根目录 = 知识库根目录**：`./docs/a.md` → 根，`./docs/sub/b.md` → `sub/`。与 `ki import --source ./docs` 的结果一致。默认只打包 `.md` / `.mdx`（`--all-files` 放开，服务端仍会跳过非文档）。

### 4. 查进度

```bash
python scripts/ki_upload.py status --task <taskId>
```

上传默认会**等到导入结束**再返回；`--no-wait` 只上传，之后用上面这条命令查。

## 参数速查

| 参数 | 默认 | 说明 |
|------|------|------|
| `--url` / `KI_URL` | 必填 | 服务地址，如 `http://10.0.0.5:7423` |
| `--token` / `KI_TOKEN` | 必填 | Bearer Token |
| `--scope` | `default` | 目标库 |
| `--group` | 由子目录推导 | 落点目录；不能写 `__root__`（要落根就留空） |
| `--tags` | — | 逗号分隔标签 |
| `--no-vector` | 关 | 只建全文索引，不做向量化（无 embedding key 时用） |
| `--conflict-mode` | `incremental` | `incremental` / `overwrite` / `skip` / `suffix` |
| `--chunk-size` / `--chunk-overlap` | 服务端配置 | 100–4000 / 0–500，且重叠须小于段长 |
| `--wait` / `--no-wait` | 等待 | 是否等导入结束 |
| `--wait-timeout` | 900 | 等待上限秒数 |
| `--no-precheck` | 关 | 跳过上传前的 ping 与体积预检 |
| `--allow-oversize` | 关 | 明知超单文件上限仍上传（该文件会被跳过） |
| `--include-ext` | `.md .mdx` | `upload-dir` 的打包白名单 |
| `--max-files` | 20000 | `upload-dir` 的本地文件数上限 |

## 怎么读输出

stdout 一行 JSON：

```json
{"ok": true, "mode": "tar.gz", "taskId": "6dbff65c-...", "uploadId": "c02130c6-...",
 "scope": "default", "files": {"saved": 2, "skipped": 0, "skippedSample": []},
 "import": {"state": "done", "progress": 1, "result": {"total": 2, "groups": ["根", "sub"]}}}
```

- `files.saved / skipped` 是**上传层**（服务端收下了几个文件），`import.result` 是**导入层**（真正写进库的结果）。两者都可能少于你给的文件数，看 `skippedSample` 的原因。
- `import.state` 为 `queued` + `waitingForScopeLock: true` 表示**在排队**（同库同一时刻只允许一个导入），不是卡住，别取消、别重投。
- `import.source`：`memory` = 实时进度；`ledger` = 服务重启后从任务记录读到的终态；`log` = 只剩日志，需 `ki log <taskId>` 查。
- 退出码：`0` 成功；`2` 配置/参数/依赖问题；`3` 上传或导入被判失败（JSON 里有 `code`）。

## 失败处理

| 现象 | 含义与出路 |
|------|------------|
| `OPEN_API_TOKEN_REQUIRED` / `INVALID` | 没带 token / token 无效：核对 `KI_TOKEN`（本机访问同样要带） |
| `OPEN_API_TOKEN_READONLY` | 只读 Token 不能上传：换读写 Token 或 `ki mcp token update <id> --read-write` |
| `OPEN_API_SCOPE_FORBIDDEN` | Token 未授权该库（响应对库名脱敏，具体以服务端日志为准） |
| `OPEN_API_SCOPE_READONLY` | 目标库被设成只读：`ki scope readonly <库名> --off` |
| `FILE_TOO_LARGE_PREFLIGHT` | 本地预检就拦下了：文件超单文件上限，让运维调大 `scopes.<库名>.import.maxFileSize`（默认仅 1MB） |
| `VECTOR_UNAVAILABLE` | 导入阶段失败：该库没有可用的 embedding（未配 `apiKey` 或密钥失效）。**加 `--no-vector`** 先以全文模式入库（正文仍可被全文检索，之后可用 `ki restore <库名> --rebuild-vector` 补齐向量） |
| `OPEN_API_PAYLOAD_TOO_LARGE` | 超过单次请求体上限：分批，或调大 `mcp.http.uploadMaxBytes` |
| `OPEN_API_ARCHIVE_UNSAFE` | 归档里有 `..` / 绝对路径 / 链接文件，整包被拒且不落盘 |
| `OPEN_API_ARCHIVE_TOO_LARGE` | 条目数、解包体积或压缩比超限：分批传 |
| `OPEN_API_NO_VALID_FILE` | 一个可用文件都没有：看 `skippedSample` 的原因 |
| `OPEN_API_NOT_FOUND` | 路径拼错，或**上传接口被关闭**（`--no-upload-api`） |
| `OPEN_API_DAEMON_DRIFT` | 服务端配置身份变了，重试无用，需重启 ki daemon |
| 连不上 / 超时 | 检查 `KI_URL`、端口、防火墙；`ping` 单独验证 |

> 反向代理（nginx）默认 `client_max_body_size` 1MB，会在请求到达 ki 之前拒掉大包，此时 ki 日志里什么都没有 —— 遇到「大包必失败、小文件正常」先查代理。

## 已知坑（都是实测结论，别踩第二次）

1. **`httpflex` 在 4xx/5xx 时会丢掉响应体**（返回 `data: null`、`message: "HTTP 403: Forbidden"`）。脚本对 GET 失败会**补读一次**错误体拿到 `OPEN_API_*` 码；POST 失败不能重发（会重复上传），改用状态码映射给方向。
2. **`files=` / `data=` 只能作为构造参数**传（httpflex 没有对应的 request 形参），且绑定该实例的**每一次**请求 —— 所以脚本一次上传造一个客户端，用完 `close()`。
3. **POST 的请求数据会被序列化成 JSON 请求体**，因此 `/open/v1` 的参数**只能拼在 URL 查询串**上，请求数据一律传 `{}`（拼错位置的参数会被忽略，表现为"参数没生效"）。
4. **`base_url` 必须用类属性**：用构造参数 `url=` 再配 `endpoint` 会拼出非法 URL（实测报 `Invalid URL '/upload': No scheme supplied`）。
5. **不要给上传开重试**：httpflex 的 `enable_retry` 是实例级，重试会把整包再传一遍；脚本只在 ping/status 上开。

## 反模式

- ❌ 把文件 base64 塞进 JSON 调 `/api/import/upload`（16MB 上限 + 客户端要读全量进内存）
- ❌ 逐篇 `ki_sync_relation` 传大文档（不做 chunk 切分，检索质量差且开销大）
- ❌ 把文件内容 `Read`/`cat` 进上下文再上传（本 skill 全程只传字节，不读内容）
- ❌ 上传后不等 `import.state` 就宣布成功（上传成功 ≠ 导入成功）
- ❌ 用默认 1MB 上限去传大文档（先 `ping` 看 `limits.maxFileSize`）

## 验证上传真的生效

```bash
# 用 MCP 检索验证（推荐，AI 侧就能做）
use_skill("ki-search")  →  ki_search(scope: "prod", query: "<文档里的一句话>")
```

或让运维在 ki 机器上看：`ki search --scope prod "<关键词>"`、`curl "/api/doc/list?scope=prod"`。

## 更多资源

- `/open/v1` 的完整契约、错误码全表、脚本内部结构与扩展点：见 [reference.md](reference.md)
- 依赖清单：`scripts/requirements.txt`
- 服务端一侧的接口说明（运维视角）：ki 仓库的 `docs/open-api.md`
