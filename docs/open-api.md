# 给外部程序的接口（`/open/v1`）：上传与取件

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
- **不带 `?scope` 时按 `default` 库判权**：Token 只授权了别的库时，连自检都会返回 403 `OPEN_API_SCOPE_FORBIDDEN`，看起来像 Token 失效。而且 403 响应里**没有 `scopes` 清单**（库名不回显，防跨租户枚举），此时只能去 ki 所在机器执行 `ki mcp token list` 看授权范围。**不确定自己授权了哪些库时，直接带上已知库名 ping 一次**，成功响应里的 `scopes` 就是完整清单。
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
  "files": { "saved": 1, "assets": 0, "skipped": 0, "skippedSample": [] },
  "totalBytes": 1843200,
  "statusUrl": "/open/v1/import/status?taskId=9a2b7c41-..."
}
```

上传完成即已**自动开始导入**，不需要再调一次「开始导入」。随后用 `taskId` 轮询进度。

同一个文件重复上传不会产生副本（按相对路径覆盖同名文档）。

### 带图上传

图片（PNG / JPEG / GIF / SVG / WebP / ICO / BMP / AVIF）与文档同批上传即可，**multipart 与 tar.gz 两种形态都收**：

```bash
# 图与 md 同目录：正文写 ![](./arch.png)
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  -F "files=@note.md" -F "files=@arch.png" \
  "http://127.0.0.1:7423/open/v1/import/upload?scope=default&group=wiki"

# 图在子目录：必须用 ;filename= 把相对路径带上（见下面第一条注意事项）
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  -F "files=@note.md" \
  -F "files=@images/arch.png;filename=images/arch.png" \
  "http://127.0.0.1:7423/open/v1/import/upload?scope=default&group=wiki"
```

- **文件名就是落点相对路径**。`curl -F "files=@images/arch.png"` 默认只发 `arch.png`，正文里的 `./images/arch.png` 就对不上、图会丢——要带目录必须显式写 `;filename=images/arch.png`（tar.gz 方式天然保留路径，不用管这条）。
- 图片按**正文里的相对引用**落库：`note.md` 里写 `![](./images/arch.png)`，入库后位于 `{group}/assets/images/arch.png`，页面与 `/open/v1/asset` 都能取到。
- 图片放哪个目录都行，只要相对路径与正文对得上；目录是否叫 `assets/` 无关。
- 附件上限看 `ping` 的 `limits.maxAssetSize`（默认 5MB），与文档的单文件上限是两个值。
- **附件不能单独导入**：整批只有图片、没有 md 时返回 400 `OPEN_API_NO_VALID_FILE`（响应里的 `files.assets` 会告诉你收下了几张图）。

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

### 算「本地已删」的候选（只算不删）

增量同步时，远端库里可能还留着本地已经删掉的文档。这个接口把它们**列出来**，供你确认：

```bash
curl -s -H "Authorization: Bearer $KI_TOKEN" -H 'Content-Type: application/json' \
  -d '{"scannedRels":["guide/a.md","guide/b.md"]}' \
  "http://127.0.0.1:7423/open/v1/import/prune?scope=default&group=guide"
```

```json
{
  "ok": true,
  "scope": "default",
  "group": "guide",
  "scanned": 2,
  "plan": {
    "eligibleCount": 3,
    "scanned": 2,
    "coordRatio": 1,
    "deleteRatio": 0.333,
    "warn": true,
    "overLimit": false,
    "total": 1,
    "items": [{ "group": "guide/api", "relation": "旧文档", "sourcePath": "guide/api/old.md" }],
    "truncated": false,
    "unableCount": 0,
    "untouchedGroups": []
  },
  "deletable": false,
  "hint": "本通道只读：删除请到 Web「目录同步清理」勾选，或在服务端主机执行 ki import --prune --yes"
}
```

`scannedRels` 必须是**这次目录里的全部 `.md` 相对路径**，不是刚上传的那批——增量上传只发变化的文件，交那批会把没变化的文档全算成「已删」。图片不要放进来。

**没有 `skipReason` 字段 = 正常给了候选**；该字段出现表示没给候选，原因在 `skipDetail`：

| 原因 | 含义 |
|------|------|
| `GATE_COORD` | 你给的路径与库里现有文档重合不到 80%，多半是目录选错了一层 |
| `GATE_SCALE` | 这样删会删掉库里 80% 以上的文档，等于清库 |
| `EMPTY_SOURCE` | 这次没扫到任何文档 |
| `EMPTY_LIBRARY` | 库里没有可判断来源的文档，无需清理 |

**这个接口不能删**：Token 通道没有删除权限，响应里 `deletable` 恒为 `false`。删除请到 Web「写入 → 目录同步清理」勾选，或在 ki 所在机器上执行 `ki import --source <同一目录> --group <组> --prune --yes`（不带 `--yes` 只预览）。

> 本端点和上传一样，需要**可写 Token**：它用 `POST` 收清单，而只读 Token 按 HTTP 方法一律被拦（返回 `OPEN_API_TOKEN_READONLY`）。服务端关闭上传接口（`uploadApi: false`）时，它同样返回 404。

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
| `lifecycle` | 不传 = 长期保留 | 文档分类：`wiki` / `temp` / `event`，见下一节 |
| `ttlDays` | — | 仅 `lifecycle=temp`：保留天数 1–365，**必填** |
| `event` | — | 仅 `lifecycle=event`：事件 id（`evt_…`）或编号（`#3`） |

### 给上传的文档打分类（临时 / 事件）

不传分类时上传的文档是**长期保留**。要让它到期自动进回收站，或者挂到某个进行中的事件上：

```bash
# 临时保留 7 天
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  -F "files=@meeting.md" \
  "http://127.0.0.1:7423/open/v1/import/upload?scope=default&group=会议记录&lifecycle=temp&ttlDays=7"

# 挂到事件 #3（事件编号或 evt_ 开头的 id 都行）
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  -F "files=@incident.md" \
  "http://127.0.0.1:7423/open/v1/import/upload?scope=default&group=故障复盘&lifecycle=event&event=%233"
```

行为要点：

- **不传分类 = 长期保留**，即使该目录在治理配置里设了「默认临时」，上传也不会跟随（目录默认只作用于页面上手动写入的文档）。
- **重复上传同一文件、这次没传分类 → 保留它原来的分类**，不会被重置成长期保留；显式传 `lifecycle=wiki` 才会清掉期限/事件。
- 上传来的文档是**普通文档**，可以在「知识治理 → 生命周期」页改分类；而数据源（目录/Git 仓库同步）来的文档固定为长期保留，不能改。
- **绑定事件后能不能被搜到，由该事件当前阶段决定**：阶段是「隐藏」时，上传成功但立刻搜不到，响应里会把这类文档列出来（`result.lifecycle.hidden`）。
- 事件收口时，如果该事件类型设置的是「关联文档进回收站」，这批文档会跟着进回收站。
- `temp` 文档到期后进回收站（保留天数按治理配置的回收站设置），不会立刻被永久删除。

导入结果的 `result.lifecycle` 会说明这次分类的落地情况：

```json
{"requested": "temp", "applied": 3,
 "lockedSkipped": [], "lockedSkippedTotal": 0,
 "hidden": [], "hiddenTotal": 0}
```

- `lockedSkipped`：目标位置已有同名文档，而它是数据源同步来的（分类固定为长期保留）——这些文件**被跳过、没有导入**。去掉 `lifecycle`/`ttlDays`/`event` 重传即可按原口径覆盖。

### 挂事件前先确认事件状态

`lifecycle=event` 要求事件存在且**未收口**。先查一次，比传完整个包再被拒要省事得多：

```bash
# 查单个（#3 或 evt_ 开头的 id 都行）
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  "http://127.0.0.1:7423/open/v1/events?scope=default&event=%233"

# 列出未收口的事件（默认 status=open，可改 closed / all；q 按标题过滤）
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  "http://127.0.0.1:7423/open/v1/events?scope=default&q=登录"
```

查单个事件的响应：

```json
{"ok": true, "scope": "default",
 "event": {"id": "evt_...", "shortId": 3, "title": "登录页白屏",
           "typeName": "bug 排查", "terminalAction": "keep",
           "stage": {"key": "st_2", "name": "已定位", "visibility": "fts-only"},
           "closed": false, "updatedAt": 1763000000000}}
```

- `closed: true` 表示已收口，**不能再挂文档**（上传会返回 `OPEN_API_EVENT_CLOSED`）。
- `stage.visibility` 是挂上去之后这批文档的检索档位：`hidden` = 语义与全文都搜不到，`fts-only` = 只能全文搜到，`full` = 都能搜到。
- `terminalAction` 是事件收口时这批文档的去留：`keep` = 转长期保留、继续可检索；`trash` = 进回收站。
- 列表最多 50 条（`limit` 取值 1–50）。

这个接口是只读的：**只读 Token 也能用**；关闭上传通道后它仍然可用（与 `ping` 同理，属诊断入口）。

### 上限与「为什么传不上去」

| 上限 | 默认 | 怎么调 |
|------|------|--------|
| 单文件大小 | **1MB** | 配置 `scopes.<库名>.import.maxFileSize`（字节），如 `20971520` = 20MB |
| 单次请求体总量 | 512MB | 配置 `mcp.http.uploadMaxBytes`（1 ~ 4GiB） |
| 归档条目数 | 20000 | 分批上传 |
| 解包后总量 | min(请求体 × 10, 4GiB) | 分批上传 |
| 图集包大小 | **20MB** | 不可调；减少视图数量后重新打包（见「部署知识地图」） |

> ⚠️ **默认的 1MB 单文件上限会挡住「一份大文档」这个首要场景**。部署时请按实际文档体积调大，否则第一次上传就会收到「超过单文件上限」。
>
> ⚠️ **经过反向代理时**，代理自己的请求体限制（nginx 的 `client_max_body_size` 默认 1MB）会在到达 ki 之前直接拒掉大包，此时 ki 日志里什么都看不到。请同步调大代理侧限制。

超限时的响应会同时给出实际值、上限值和调整方法，例如：

```json
{ "ok": false, "code": "OPEN_API_PAYLOAD_TOO_LARGE",
  "error": "请求体超过上限 200000 字节（已收 262144 字节）。可调大 mcp.http.uploadMaxBytes；若经过反向代理，还需同步调大其 client_max_body_size",
  "actual": 262144, "limit": 200000 }
```

目录里个别文件不合格（既不是文档也不是图片，或超出对应大小上限）**不会让整包失败**：它们会进 `files.skippedSample`（最多 10 条原因），其余文件照常导入。一个可用文件都没有（`files.saved = 0`）时才会整体返回 400。

`files` 的三个计数各管一件事，别看错：

- `saved`：收下的**文档**数（可导入单元）
- `assets`：收下的**附件（图片）**数，已落地，导入时按正文引用复制进 `{group}/assets/`
- `skipped`：真正被丢弃的文件数（类型不支持 / 超限），明细看 `skippedSample`

> 早期版本把图片也算进 `skipped`（原因写「扩展名不支持」），看着像图没传上去。现在图片单独计 `assets`，`skipped` 只表示真丢了文件。

### 关掉这个通道

```bash
ki mcp restart --no-upload-api     # 立即关闭（一条命令）
ki mcp restart --upload-api        # 重新打开

ki mcp status                      # 查看当前状态：uploadApi / uploadApiSource
```

也可以在配置里写 `mcp.http.uploadApi: false`，重启后生效。关闭后的行为：

- `/open/v1/import/upload`、`/open/v1/import/status` 与 `/open/v1/import/prune` 一律返回 **404**（不暴露接口是否存在）。
- `/open/v1/atlas/package` 与 `/open/v1/atlas/status`（图集部署）同样返回 **404**——它们也属于「外部往库里写」。
- `/open/v1/ping` 与 `/open/v1/events` 仍然可用（确认 Token、服务状态，以及有哪些事件可供挂载）。
- Web 页面、`/api/*`、`/mcp` 工具、`/healthz` **完全不受影响**。

`ki mcp status` 里的 `uploadApiSource` 说明这个值从哪来：`lock` = 运行中实例的真实值，`config` = 配置里写的，`default` = 都没设（默认开启）。如果实例当前没在运行，状态会按配置/默认显示「下次启动会怎样」，不会拿上一次残留的运行状态充数。

### 下载文档与图片（只读）

上传之外，同一通道也能把库里的**文档正文**与**附件（图片）**取出来。两个只读端点：

| 端点 | 取什么 | 关键参数 |
|------|--------|----------|
| `GET /open/v1/doc` | 文档正文 + 文中图片清单（清单里每个 `ref` 就是下面要传的 `path`） | `scope`、`group`、`relation` |
| `GET /open/v1/asset` | 附件原始字节 | `scope`、`group`、`path` |

```bash
# 取正文（返回 JSON：content 是正文，images 是附图清单）
curl -H "Authorization: Bearer $KI_TOKEN" \
  "http://127.0.0.1:7423/open/v1/doc?scope=prod&group=%E6%95%85%E9%9A%9C%E5%A4%8D%E7%9B%98&relation=%E7%99%BB%E5%BD%95%E8%B6%85%E6%97%B6"

# 取图（返回二进制，直接落盘；path 里的 / 要编码成 %2F）
curl -H "Authorization: Bearer $KI_TOKEN" \
  "http://127.0.0.1:7423/open/v1/asset?scope=prod&group=%E6%95%85%E9%9A%9C%E5%A4%8D%E7%9B%98&path=shots%2Ftimeout.png" \
  -o timeout.png
```

几条要知道的口径：

- **视图名不能用**：`scope` 必须是真实库名——视图是多个库的检索范围，附件是按库存放的。
- **`path` 整体编码**：`shots/timeout.png` 里的 `/` 必须写成 `%2F`，否则会被当成新的查询分隔。
- **后缀白名单**：PNG / JPEG / GIF / WebP / SVG / ICO / BMP / AVIF。其它后缀一律 404。
- **「文件不存在」与「格式不支持」返回同一个 404**（故意不区分，避免被用来探测目录结构）。
- **不支持断点续传（`Range`）与 `ETag`**：单附件默认上限 5MB，一次整包拉取。
- **只读 Token 也能下载**；它限制的是写入，不是读。

关掉读出口（与上传开关**互不影响**）：

```yaml
mcp:
  http:
    downloadApi: false   # 默认 true；改完需重启服务（ki mcp restart）生效
```

关闭后 `/open/v1/asset` 与 `/open/v1/doc` 一律返回 404，`ping` 仍可用——它的 `capabilities.download` 会回显为 `false`，程序据此判断即可。

> 关闭只作用于这一条通道：Web 页面看图的 `/api/*` 不受影响（它是既有能力，不属于本接口）。

### 部署知识地图（图集）

「图集」是用 `project-atlas` 生成的单页知识地图（一个 zip，里面是一个可交互的 HTML）。
**这套接口解决的是「图集在本机打好了，但要装进另一台机器上的 ki」**——两台机器之间只能走 HTTP。

装了 `ki-client` 的机器一条命令即可：

```bash
ki-client atlas upload --scope prod --file dist/atlas.zip
```

没装的话，`curl` 同样能装（图集包原样作为请求体发过去，不要 base64、不要 multipart）：

```bash
curl -X POST -H "Authorization: Bearer $KI_TOKEN" -H "Content-Type: application/zip" \
  --data-binary @dist/atlas.zip \
  "http://127.0.0.1:7423/open/v1/atlas/package?scope=prod"
```

装完核对（客户端 `ki-client atlas status --scope prod` 是同一条查询）：

```bash
curl -s -H "Authorization: Bearer $KI_TOKEN" \
  "http://127.0.0.1:7423/open/v1/atlas/status?scope=prod"
```

```json
{"ok": true, "scope": "prod", "exists": true,
 "title": "订单链路", "branch": "master", "baseline": "1c3dabf",
 "generatedAt": "2026-11-24T10:00:00.000Z",
 "size": 254753, "packageSize": 108195,
 "sha256": "9bad814a…", "packageSha256": "3f21c0de…",
 "archived": true, "uploadedAt": "2026-11-25T02:11:03.000Z", "uploadedBy": "open-api:8f3c2a1b"}
```

几条要知道的口径：

- **两个指纹不是一回事**：`sha256` 是图集 HTML 的指纹，`packageSha256` 是你上传的那个 zip 的指纹。**判断「这个包是不是已经装过」要用 `packageSha256`**——用它比对 `sha256sum dist/atlas.zip` 即可。
- **重复上传会覆盖，旧版进 `archive/`**（只留一版，可用于回滚）。内容没变就别重传：`ki-client atlas upload` 会先比对 `packageSha256`，一致就跳过（`--force` 强行重传）。手工 `curl` 时请自己先查一次 status。
- **一次一整包，不支持分片**。图集包上限 **20MB**（解压后总量上限 50MB、单文件 10MB），超了请减少视图数量（建议 6~8 页）再重新打包，不要靠删代码快照瘦身。
- **`scope` 走 query，且只能从 query 传**（请求体是原始 zip 字节，没有别的地方能放）。库不存在、只读库、Token 未授权、视图名这四种情况都在**收请求体之前**就拒掉，不会让你白传 20MB。
- **装完页面立刻能看到**：图集落在该库的 `.atlas/` 目录，Web 的「知识地图」页读的是同一份数据，不需要重启服务。
- 装之前请先确认这是**你自己生成的包**：图集 HTML 在页面里是带脚本权限的，等同可执行代码。来源不明的 zip 不要往这里传。

关闭上传通道后，`/open/v1/atlas/package` 与 `/open/v1/atlas/status` 一并返回 404（与 `/open/v1/import/*` 同一个开关 `uploadApi`）；`ping` 里的 `capabilities.atlas.upload` 会变成 `false`，程序据此判断即可。

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
| 400 | `OPEN_API_INVALID_LIFECYCLE` | 分类参数不合法：`temp` 缺 `ttlDays`、`wiki` 带了 `ttlDays`/`event`、`ttlDays` 不在 1–365、`lifecycle` 取值不认识等。`reason` 给出精确原因（如 `TTL_REQUIRED`） |
| 400 | `OPEN_API_EVENT_NOT_FOUND` | 指定的 `event` 不存在；`available` 列出可用的未收口事件（最多 5 个）。查询事件接口下该 code 的状态码是 **404** |
| 400 | `OPEN_API_EVENT_CLOSED` | 该事件已收口，不能再挂新文档；改挂进行中的事件，或先在页面重开该事件 |
| 400 | `OPEN_API_VIEW_NOT_WRITABLE` | 把知识视图当成库名了——视图是多库的检索范围，不能作为写入目标 |
| 400 | `OPEN_API_VIEW_UNSUPPORTED` | 取件时传了视图名——附件按库存放，视图不能作为取件目标，改用成员库名 |
| 403 | `OPEN_API_PATH_FORBIDDEN` | 附件路径非法或越界：`group` 含 `..`、`path` 带 `../`、或绝对路径 |
| 404 | `OPEN_API_NOT_FOUND`（取件接口） | 文档 / 附件不存在、后缀不在白名单，或读出口被关闭（`downloadApi: false`） |
| 404 | `OPEN_API_ATLAS_SCOPE_NOT_FOUND` | 装图集的目标库不存在（不会被就地创建）。先用 `ki scope add` 建库，或检查 `scope` 拼写 |
| 400 / 413 | `OPEN_API_ATLAS_PACKAGE_INVALID` | 图集包不合格。`atlasCode` 给数字码（1401 未烘焙或有外链 / 1402 包内根目录没有唯一 HTML / 1403 超限 / 1404 条目路径不安全 / 1407 zip 形态不支持），`hint` 给修法；**用 `pack_atlas.py … --zip` 重新打包是最常见的解** |
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
