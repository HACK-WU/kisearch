# ki-upload 参考

> SKILL.md 讲「怎么用」；本文件讲「契约细节、错误码全表、脚本内部结构与改法」。
> 只在需要时读，不必一开始就加载。

## 一、`/open/v1` 契约（脚本依赖的部分）

### 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/open/v1/ping` | 自检：token 身份、授权 scope、三层上限 |
| POST | `/open/v1/import/upload` | 上传并**自动开始导入**，返回 `taskId` |
| GET | `/open/v1/import/status?taskId=` | 查进度 / 结果 |

### 上传参数（全部在 URL 查询串）

| 参数 | 默认 | 约束 |
|------|------|------|
| `scope` | `default` | 必须在该 Token 的授权集合内 |
| `group` | 由文件相对路径推导 | 不能是绝对路径、不能含 `..`、不能写 `__root__` |
| `tags` | — | 逗号分隔 |
| `vector` | `1` | `0` = 只建全文索引 |
| `conflictMode` | `incremental` | `incremental` / `overwrite` / `skip` / `suffix` |
| `conflictSuffix` | — | `suffix` 模式的后缀模板 |
| `chunkSize` | 服务端配置 | 100–4000 的整数 |
| `chunkOverlap` | 服务端配置 | 0–500 且小于 `chunkSize` |
| `archive` | — | 传 `tar.gz` 显式声明整包模式（与 Content-Type 双判） |

### 两种请求体

| Content-Type | 形态 | 相对路径怎么带 |
|--------------|------|----------------|
| `multipart/form-data` | 每个文件一个 `files` part | `filename` 里写相对路径（`sub/a.md`） |
| `application/gzip` | tar.gz 整包 | 解包后的相对路径即落点 |

两个分支的服务端落点**完全相同**，所以重复上传不会产生副本（按相对路径覆盖）。

### 上传响应

```json
{"ok": true, "uploadId": "...", "taskId": "...", "scope": "default", "group": "wiki",
 "files": {"saved": 1, "skipped": 0, "skippedSample": [{"rel": "x.txt", "reason": "扩展名不支持..."}]},
 "totalBytes": 1843200, "statusUrl": "/open/v1/import/status?taskId=..."}
```

`files.saved` 是**服务端收下的文件数**；非文档扩展名、超单文件上限的文件会进 `skippedSample`（最多 10 条），其余照常导入。

### status 响应

```json
{"ok": true, "taskId": "...", "state": "running", "phase": "vectorize", "progress": 0.62,
 "waitingForScopeLock": false, "cancelRequested": false, "source": "memory", "result": null}
```

- `state`：`queued` / `running` / `done` / `failed` / `cancelled` / `unknown`
- `phase`：`waiting` / `scan` / `vectorize` / `persist`
- `progress`：0~1 的小数（由 `done/total` 换算，可能长时间不变，不代表卡死）
- `source`：`memory`（实时）/ `ledger`（重启后从任务记录读，带 `stale: true`）/ `log`（只剩日志）
- `result`（仅 `done`）：`total` / `vectorized` / `skipped` / `errors` / `groups`（前 20 个，`根` = 知识库根）/ `groupsTotal` / `wikiWriteback`
- `result.wikiWriteback`：仅目标库配了 wiki 回写目录（`scopes.<库名>.wikiSync.sourceDir`）时出现，形如 `{"written": 2, "skipped": 0, "failed": 0}`。回写只补缺不覆盖，重复上传同一批文档会全部进 `skipped`；写回失败不影响导入结果

## 二、错误码全表

| HTTP | code | 出路 |
|------|------|------|
| 401 | `OPEN_API_TOKEN_REQUIRED` | 加 `Authorization: Bearer <token>`（本机也要带） |
| 401 | `OPEN_API_TOKEN_INVALID` | Token 不存在/被删/所属账号被禁用 → `ki mcp token list` 核对 |
| 403 | `OPEN_API_TOKEN_READONLY` | 只读 Token → 换读写 Token |
| 403 | `OPEN_API_SCOPE_FORBIDDEN` | 未授权该库；任务也按同规则保护（越权查他人任务也是 403） |
| 403 | `OPEN_API_SCOPE_READONLY` | 目标库只读 → `ki scope readonly <库名> --off` |
| 400 | `OPEN_API_BAD_REQUEST` | 参数非法（`group` 绝对路径、`conflictMode` 非法值等） |
| 400 | `OPEN_API_INVALID_CHUNK` | `chunkSize` / `chunkOverlap` 越界或非整数 |
| 400 | `OPEN_API_VIEW_NOT_WRITABLE` | 把知识视图当库名了（视图是检索范围，不可写） |
| 400 | `OPEN_API_BAD_MULTIPART` | multipart 缺 boundary 或结构不完整 |
| 400 | `OPEN_API_UNSUPPORTED_CONTENT_TYPE`（实际是 415） | 只支持 multipart 与 `application/gzip` |
| 400 | `OPEN_API_ARCHIVE_UNSAFE` | 归档含越界路径/链接条目，整包拒收 |
| 400 | `OPEN_API_ARCHIVE_TOO_LARGE` | 条目数 > 20000、解包体积超限或压缩比异常 |
| 400 | `OPEN_API_ARCHIVE_BROKEN` | 归档无法解析/解包（不是 tar.gz 或已损坏） |
| 400 | `OPEN_API_NO_VALID_FILE` | 没有任何可用文件 |
| 404 | `OPEN_API_NOT_FOUND` | 路径不存在；上传接口被关闭时同此码 |
| 405 | `OPEN_API_METHOD_NOT_ALLOWED` | 方法不对（响应带 `Allow`） |
| 413 | `OPEN_API_PAYLOAD_TOO_LARGE` | 超 `mcp.http.uploadMaxBytes`（响应含 `limit` / `actual`） |
| 404 | `OPEN_API_TASK_NOT_FOUND` | `taskId` 拼错或已过保留期（7 天） |
| 409 | `OPEN_API_DAEMON_DRIFT` | 服务端配置身份漂移，需重启 daemon |
| 500 | `OPEN_API_STORAGE_FAILED` / `OPEN_API_INTERNAL` | 服务端磁盘/权限/未预期错误，详情只在服务端日志 |

## 三、脚本结构与扩展点

```
skills/ki-upload/
├── SKILL.md
├── reference.md
└── scripts/
    ├── ki_upload.py       # 全部逻辑（约 460 行，无第三方依赖除 httpflex）
    └── requirements.txt
```

脚本内部分层：

| 层 | 函数 | 说明 |
|----|------|------|
| 客户端工厂 | `build_client()` | 每次请求造一个实例，承载 `files=` / `data=` 这类构造期参数 |
| 统一调用 | `call()` | 把 httpflex 的 `{result, code, message, data}` 规整成 data 或抛 `UploadError` |
| 错误补读 | `make_get_probe()` | GET 失败后补读服务端 JSON 错误体（httpflex 会丢） |
| 预检 | `precheck_limits()` | 上传前查 `limits`，把必然失败的请求挡在本地 |
| 分支 | `cmd_upload()` / `cmd_upload_dir()` | multipart / tar.gz |
| 等待 | `wait_for_task()` | 轮询到终态，`queued` 与 `running` 分开报 |

常见改法：

- **换成纯 `requests`**（不想装 httpflex）：把 `build_client()+call()` 换成一个 `requests.post(url, params=..., files=..., headers=...)`，其余逻辑（预检、等待、错误映射）可原样保留。当初选 httpflex 是为了统一返回结构 + GET 侧重试。
- **接 CI**：`--no-wait` + 轮询 `status`，把 `taskId` 存到构建产物里；失败按退出码 3 判定。
- **换落点策略**：`--group` 由命令行给，脚本不猜；目录上传想"每个顶层子目录一个 group"，就分别调 `upload-dir ./docs/<sub> --group <sub>`。

## 四、与 httpflex 版本绑定的实测记录

以下结论在 **httpflex 0.1.1-beta**（Python 3.12）上实测成立，升级后建议重跑验证：

| # | 事实 | 影响 |
|---|------|------|
| 1 | 构造参数 `files=` 透传给底层 `requests`，生成标准 multipart（`filename` 原样保留，支持 `sub/a.md`） | 上传能力可用，**但文档未记载** |
| 2 | 构造参数 `data=<文件对象>` + 自定义 `headers` 可发原始字节流，`Content-Length` 正确 | tar.gz 分支可用 |
| 3 | `endpoint` 里带 query string 原样发出 | 参数可以拼在 URL 上 |
| 4 | POST 的 `request_data` 变成 JSON 请求体（不冲突时 `files=` 仍生效） | **参数务必放 query**，请求数据传 `{}` |
| 5 | 构造参数 `url=` 与 `endpoint` 组合会拼出非法 URL | `base_url` 必须用类属性 |
| 6 | 4xx/5xx 时 `data: null`、`message: "HTTP 403: Forbidden"`，响应体被丢弃；自定义 `response_validator` 在非 2xx 时**不会被调用** | 错误保真度靠 GET 补读 + POST 状态码映射 |
| 7 | 返回统一为 `{result, code, message, data}`，不抛异常 | 判断成功用 `result is True` |
