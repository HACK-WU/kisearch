# 给外部程序的上传接口（`/open/v1`）

> **给谁看**：需要把文件推到远端 ki 的程序（AI Agent、CI 脚本、自建采集器），以及给它们签发 Token 的运维。
> 客户端只需要 `curl` 与 `tar`，**不需要安装 ki**。

## 这个接口解决什么

典型场景是：AI Agent 与 ki **不在同一台机器**。Agent 那边有 MCP 工具、有 shell、有要导入的文档，**但没有 ki**（任何 `ki` 命令都不可达）。所以唯一可用的通道是标准 HTTP——而前端页面用的 `/api/import/upload` 只吃 JSON+base64、请求体上限 16MB，标准 HTTP 客户端用不上。

`/open/v1/*` 就是为这一类调用方准备的：`curl -F` 或 `tar | curl` 直接推，导入仍走 ki 自己的导入内核（切分、附件、Group、向量化一步不落），因此与 `ki import --source` 的产物一致。

三个前缀各走各的鉴权，互不影响：

| 前缀 | 谁在用 | 鉴权方式 | 默认 |
|------|--------|----------|------|
| `/mcp` | IDE 里的 MCP 客户端 | Bearer Token（本机回环可免） | 永远开 |
| `/api/*` | 浏览器页面 | 页面登录 / 本机免登录 | 永远开 |
| `/open/v1/*` | 第三方程序 | **只认 `Authorization: Bearer`** | 默认开，可关 |

`/open/v1/*` 的特殊之处：**不读浏览器 Cookie、本机回环也必须带 Token**。也就是说，拿着浏览器登录态或者从本机 curl 都进不来，必须用 `ki mcp token generate --scope <库名>` 签发的 Token。

给**不在 ki 所在机器上的程序**（典型是 AI Agent）用的上传通道：对方只需要 `curl` 与 `tar`，**不需要安装 ki**，也不需要把文件内容读进模型上下文。

三个前缀各走各的鉴权，互不影响：

| 前缀 | 谁在用 | 鉴权方式 | 默认 |
|------|--------|----------|------|
| `/mcp` | IDE 里的 MCP 客户端 | Bearer Token（本机回环可免） | 永远开 |
| `/api/*` | 浏览器页面 | 页面登录 / 本机免登录 | 永远开 |
| `/open/v1/*` | 第三方程序 | **只认 `Authorization: Bearer`** | 默认开，可关 |

`/open/v1/*` 的特殊之处：**不读浏览器 Cookie、本机回环也必须带 Token**。也就是说，拿着浏览器登录态或者从本机 curl 都进不来，必须用 `ki mcp token generate --scope <库名>` 签发的 Token。

## 怎么用

### 第一步：自检

```bash
export KI_TOKEN='<你的 Token>'
curl -s -H "Authorization: Bearer $KI_TOKEN" http://127.0.0.1:7423/open/v1/ping
```

```json
{
  "ok": true,
  "api": "open/v1",
  "tokenId": "8f3c2a1b",
  "scopes": ["default"],
  "readOnly": false,
  "uploadApi": true,
  "limits": {
    "scope": "default",
    "maxRequestBody": 536870912,
    "maxFileSize": 1048576,
    "maxAssetSize": 5242880
  }
}
```

- `limits.maxFileSize` 是**单文件**上限，`limits.maxRequestBody` 是**整次请求**上限，两者是两回事。
- 想确认某个库的上限，加 `?scope=<库名>`（不在 Token 授权范围内会返回 403）。
- 上传前先看一眼这里，能避免拿着 5MB 文档去撞默认 1MB 的单文件上限。

### 上传一份文档

```bash
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  -F "files=@big.md" \
  "http://127.0.0.1:7423/open/v1/import/upload?scope=default&group=wiki"
```

```json
{
  "ok": true,
  "uploadId": "3f1c9a2e-...",
  "taskId": "9a2b7c41-...",
  "scope": "default",
  "group": "wiki",
  "files": { "saved": 1, "skipped": 0, "skippedSample": [] },
  "totalBytes": 1843200,
  "statusUrl": "/open/v1/import/status?taskId=9a2b7c41-..."
}
```

上传完成即已**自动开始导入**，不需要再调一次「开始导入」。随后用 `taskId` 轮询进度。

同一个文件重复上传不会产生副本（按相对路径覆盖同名文档）。

### 上传一个目录（保留层级）

```bash
tar czf - -C ./docs . | curl -s -H "Authorization: Bearer $KI_TOKEN" \
  -H 'Content-Type: application/gzip' --data-binary @- \
  "http://127.0.0.1:7423/open/v1/import/upload?scope=default"
```

**打包的根目录 = 知识库的根目录**，这句必须记住，否则层级会整体下沉一级：

| 打包命令 | 结果 | 建议 |
|----------|------|------|
| `tar czf - -C ./docs .` | `a.md` 落在根、`sub/b.md` 落在 `sub` | ✅ 推荐，与 `ki import --source ./docs` 结果一致 |
| `tar czf - docs/` | 全部多出一层 `docs/` | ⚠️ 层级下沉一级 |
| `tar czf - -C ./docs sub/` | 只导 `sub/` 子树 | ✅ 合法，用于只导部分目录 |

### 查询进度

```bash
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  "http://127.0.0.1:7423/open/v1/import/status?taskId=9a2b7c41-..."
```

```json
{
  "ok": true,
  "taskId": "9a2b7c41-...",
  "state": "running",
  "phase": "vectorize",
  "progress": 0.62,
  "waitingForScopeLock": false,
  "cancelRequested": false,
  "source": "memory",
  "result": null
}
```

几点值得注意：

- **`waitingForScopeLock: true` + `phase: "waiting"` 表示「在排队」，不是卡住**。同一个库同一时刻只允许一个导入，第二个任务会等前一个结束；这时不要去取消或重复提交。
- **`source` 说明这份状态有多可信**：`memory` = 实时进度；`ledger` = 服务重启后从任务记录里读到的终态（带 `stale: true`，不是实时）；`log` = 记录也过期了，只知道这个任务确实跑过，可执行 `ki log <taskId>` 看历史日志。
- `state` 为 `done` 时 `result` 里有文件数、错误数与前 20 个 `group`（`groupsTotal` 是总数）。`根` 代表知识库根目录。
- 该库配了 wiki 回写目录时，`result` 里还会多一个 `wikiWriteback`：`{ "written": 2, "skipped": 0, "failed": 0 }`，见下一节。
- **越权查看别人的任务是 403 而不是 404**：任务确实存在，只是不在你的 Token 授权范围内。

### 会顺带写回 wiki 目录吗

会——**前提是该库配了 wiki 回写目录**（`scopes.<库名>.wikiSync.sourceDir`）。导入成功的文档会各生成一个 Markdown 文件，落在 `<该目录>/<group>/<文档名>.md`，与用命令行导入或用 MCP 工具写知识得到的结果一致。

- **只补缺、不覆盖**：目标位置已有同名文件时跳过，不会刷掉你在 wiki 仓库里手改过的内容。想让库里的版本重写过去，用 `ki wiki-backfill <库名> --force`。
- **没配就不发生**：该库没配 `wikiSync.sourceDir` 时，上传只进知识库，`result` 里也不会出现 `wikiWriteback`。
- **失败不影响导入**：写回出错只记服务端日志，这次导入仍算成功；对照 `result.wikiWriteback.failed` 判断有几篇没写出去。
- **`skipped` 偏大是正常的**：重复上传同一批文档时，这些文件早已在 wiki 目录里，会全部计入 `skipped`。
- **服务重启后再查同一任务**：状态改为从任务记录读（`source: "ledger"`），那份记录只存文件数与错误数，`result` 里不再有 `wikiWriteback`——不等于没写回，要复核请在下一次上传后当次读取，或看服务端日志。

### 上传参数（都放在 URL 查询串里）

| 参数 | 默认 | 说明 |
|------|------|------|
| `scope` | `default` | 目标知识库；不在 Token 授权集合内返回 403 |
| `group` | 由文件所在子目录推导 | 落点目录；不能是绝对路径、不能含 `..`、不能写保留名 `__root__`（要落根就留空） |
| `tags` | — | 逗号分隔的自定义标签 |
| `vector` | `1` | `0` = 只建全文索引、不做向量化（等价 `ki import --no-vector`） |
| `conflictMode` | `incremental` | `incremental` / `overwrite` / `skip` / `suffix` |
| `conflictSuffix` | — | `conflictMode=suffix` 时的后缀模板 |
| `chunkSize` | 配置值 | 切分长度 100–4000 |
| `chunkOverlap` | 配置值 | 切分重叠 0–500，且必须小于 `chunkSize` |

### 上限与「为什么传不上去」

| 上限 | 默认 | 怎么调 |
|------|------|--------|
| 单文件大小 | **1MB** | 配置 `scopes.<库名>.import.maxFileSize`（字节），如 `20971520` = 20MB |
| 单次请求体总量 | 512MB | 配置 `mcp.http.uploadMaxBytes`（1 ~ 4GiB） |
| 归档条目数 | 20000 | 分批上传 |
| 解包后总量 | min(请求体 × 10, 4GiB) | 分批上传 |

> ⚠️ **默认的 1MB 单文件上限会挡住「一份大文档」这个首要场景**。部署时请按实际文档体积调大，否则第一次上传就会收到「超过单文件上限」。
>
> ⚠️ **经过反向代理时**，代理自己的请求体限制（nginx 的 `client_max_body_size` 默认 1MB）会在到达 ki 之前直接拒掉大包，此时 ki 日志里什么都看不到。请同步调大代理侧限制。

超限时的响应会同时给出实际值、上限值和调整方法，例如：

```json
{ "ok": false, "code": "OPEN_API_PAYLOAD_TOO_LARGE",
  "error": "请求体超过上限 200000 字节（已收 262144 字节）。可调大 mcp.http.uploadMaxBytes；若经过反向代理，还需同步调大其 client_max_body_size",
  "actual": 262144, "limit": 200000 }
```

目录里个别文件不合格（扩展名不支持、超单文件上限）**不会让整包失败**：它们会进 `files.skippedSample`（最多 10 条原因），其余文件照常导入。一个可用文件都没有时才会整体返回 400。

### 关掉这个通道

```bash
ki mcp restart --no-upload-api     # 立即关闭（一条命令）
ki mcp restart --upload-api        # 重新打开

ki mcp status                      # 查看当前状态：uploadApi / uploadApiSource
```

也可以在配置里写 `mcp.http.uploadApi: false`，重启后生效。关闭后的行为：

- `/open/v1/import/upload` 与 `/open/v1/import/status` 一律返回 **404**（不暴露接口是否存在）。
- `/open/v1/ping` 仍然可用（用来确认 Token 与服务是否正常）。
- Web 页面、`/api/*`、`/mcp` 工具、`/healthz` **完全不受影响**。

`ki mcp status` 里的 `uploadApiSource` 说明这个值从哪来：`lock` = 运行中实例的真实值，`config` = 配置里写的，`default` = 都没设（默认开启）。如果实例当前没在运行，状态会按配置/默认显示「下次启动会怎样」，不会拿上一次残留的运行状态充数。

### 常见错误码

| HTTP | code | 含义与出路 |
|------|------|------------|
| 401 | `OPEN_API_TOKEN_REQUIRED` | 没带 `Authorization: Bearer`。本机访问也一样要带 |
| 401 | `OPEN_API_TOKEN_INVALID` | Token 不存在、已删除或所属账号被禁用；用 `ki mcp token list` 核对 |
| 403 | `OPEN_API_TOKEN_READONLY` | 只读 Token 不能上传；换一个读写 Token 或 `ki mcp token update <id> --read-write` |
| 403 | `OPEN_API_SCOPE_FORBIDDEN` | Token 授权不含该库（或该任务属于别的库） |
| 403 | `OPEN_API_SCOPE_READONLY` | 目标库被设为只读（`ki scope readonly <库名> --off` 可解） |
| 404 | `OPEN_API_NOT_FOUND` | 路径拼错，或上传接口已被关闭 |
| 413 | `OPEN_API_PAYLOAD_TOO_LARGE` | 请求体超 `mcp.http.uploadMaxBytes` |
| 415 | `OPEN_API_UNSUPPORTED_CONTENT_TYPE` | 只支持 `multipart/form-data` 与 `application/gzip` 两种形态 |
| 400 | `OPEN_API_BAD_REQUEST` | 参数非法（如 `group` 写绝对路径、`conflictMode` 不是四个取值之一） |
| 400 | `OPEN_API_INVALID_CHUNK` | `chunkSize` 不在 100–4000，或 `chunkOverlap` 不在 0–500 且小于 `chunkSize` |
| 400 | `OPEN_API_VIEW_NOT_WRITABLE` | 把知识视图当成库名了——视图是多库的检索范围，不能作为写入目标 |
| 400 | `OPEN_API_BAD_MULTIPART` | multipart 请求缺 boundary 或结构不完整（请用 `curl -F`，不要手拼请求体） |
| 400 | `OPEN_API_ARCHIVE_UNSAFE` | 归档里有越界路径或链接文件，整包拒收且不落盘 |
| 400 | `OPEN_API_ARCHIVE_TOO_LARGE` | 条目数/解包体积/压缩比超限，分批上传 |
| 400 | `OPEN_API_NO_VALID_FILE` | 一个可用文件都没有，看 `files.skippedSample` 的原因 |
| 404 | `OPEN_API_TASK_NOT_FOUND` | `taskId` 拼错或已过保留期（任务记录 7 天） |
| 405 | `OPEN_API_METHOD_NOT_ALLOWED` | 路径对但方法不对（响应带 `Allow` 头） |
| 409 | `OPEN_API_DAEMON_DRIFT` | 服务的配置身份已变（如改过数据目录），**重试无用**，需按响应提示重启服务 |
| 400 | `OPEN_API_ARCHIVE_BROKEN` | 归档损坏或无法读取（重新打包再传） |
| 500 | `OPEN_API_STORAGE_FAILED` / `OPEN_API_INTERNAL` | 服务端磁盘/权限或未预期错误，详情只在服务端日志（不向调用方回显内部路径） |

> 本接口**不提供**「清理库中已删除文档」的能力（那需要前端导入页或 `ki` 侧的目录同步清理）。重复上传只会覆盖同名文档，不会删除其它文档。
## 相关文档

- [CLI 参考 · `mcp token`](./cli.md) — 签发 / 查看 / 改权限 / 删除 Token
- [MCP HTTP 共享单例模式](./mcp-http.md) — 服务怎么起、端口与监听地址、`--web`、状态自查
- [常见报错与恢复](./error-handling.md) — 跨接口的错误排查思路
- [配置项逐条说明](./configuration.md) — `mcp.http.uploadApi` / `uploadMaxBytes` / `import.maxFileSize`
