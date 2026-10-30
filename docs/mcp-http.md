# MCP HTTP 共享单例模式

## 解决的问题

嵌入式向量库的 Collection 同一时刻只能由一个写入 owner 打开。当前 `ki mcp --http --daemon` 会成为指定 `vectorDir` 的**唯一 zvec owner**，CLI、stdio MCP 和 HTTP MCP 请求统一通过本机 daemon 调度，不再由各入口直接抢锁。

stdio 模式会自动桥接到本机 daemon；CLI 在 daemon 不存在时也会按当前配置自动拉起。不同 scope 使用独立 Collection 和队列，最多 `min(4, CPU 数量)` 并行；同一 scope 仍按序执行。因此“并发提交”不等于“同一 Collection 并行写入”，但用户不再需要手动停止 MCP 或反复重试锁错误。

HTTP lock 按 `vectorDir + dataDir` 身份指纹派生，多份配置可并存且不会让 stdio bridge 误连另一实例。

## 长任务 API

restore 与 rebuild-vector 通过统一 job 机制提供进度和取消：

```text
POST /api/restore/run
GET  /api/restore/status?jobId=<id>
POST /api/restore/cancel   {"jobId":"<id>"}
```

`/api/restore/run` 必须包含 `scope`；还原使用 `rebuildVector: true` 可在还原完成后继续重建向量，独立重建使用 `rebuildOnly: true`。阶段为 `restore` / `rebuild`，取消沿用批次边界语义：不会强行中断当前 tar、embedding 或 zvec 批次；当前批次完成后停止后续写入。取消响应为 `202` 的 `cancelling`，需继续轮询 status 确认最终状态。

`GET /healthz` 额外返回 `vectorResources`，包含当前/峰值打开句柄数、打开/释放次数及耗时累计，可用于性能基线。

## 快速开始

在服务器上手动启动一次（幂等，重复运行安全）：

```bash
# 仅本机访问（默认即回环绑定 127.0.0.1，免鉴权，开箱即用）
ki mcp --http

# 远程跨机访问（非回环绑定，强制 Token）：生成授权 Token 后直接启动
ki mcp token generate --scope team-a   # 输出短 ID + Token 明文，持久化到 ~/.ki/mcp-tokens.json（0600）
ki mcp --http --host 0.0.0.0 --port 7423   # 鉴权基于多 Token 存储，无需 export
```

各 IDE 在 `mcp.json` 中用 URL 型条目接入：

```json
{
  "mcpServers": {
    "ki": {
      "url": "http://<host>:7423/mcp",
      "headers": { "Authorization": "Bearer your-strong-secret" }
    }
  }
}
```

> 回环绑定（仅本机）免鉴权时，可省略 `headers`。
>
> ⚠️ HTTP 客户端仍应使用一致的 `host`/`port`，以便连接同一服务；本机 IDE 也可以继续使用 stdio `command: ki mcp`，它会桥接到该 daemon，不会另开 zvec owner。可用 `ki mcp --status` 和 `/healthz` 查看 owner、布局版本及队列状态。

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--http` | — | 启用 Streamable HTTP 传输（不传则走 stdio，启动时同样经过启动守卫，见下文「HTTP 启动守卫」与「stdio 启动守卫」） |
| `--host <h>` | `127.0.0.1` | 监听地址。默认回环（`127.0.0.1`/`localhost`/`::1`）免鉴权；对外监听改 `0.0.0.0` 并必须带 Token |
| `--port <n>` | `7423` | 监听端口（1-65535） |
| `--token <t>` | — | 全权临时 Token（进程级，优先级高于多 Token 存储，也可用环境变量 `KI_MCP_TOKEN`）。**非回环绑定时需有 Token**（临时全权或存储中的授权 Token），推荐 `ki mcp token generate --scope <...>` 托管 |
| `--allowed-hosts <a,b>` | — | 开启 DNS rebinding 保护并限定允许的 Host 头（逗号分隔） |
| `--status` | — | 只读诊断：读取 HTTP lock + stdio 多实例 lock + 探活，输出实例全貌（JSON，含 `stdioInstances` 存活 stdio 列表与 `managedTokens.count`），不启动服务、跳过预检。读取时**顺带清理已死进程的陈旧 stdio lock**（非纯只读，但为有益副作用） |
| `--web` | — | HTTP 模式下同时提供前端静态页面（默认 `web/dist`，浏览器访问 `http://<host>:<port>/`）；未找到构建产物时提示但不阻塞 MCP 启动 |
| `--no-web` | — | 显式关闭前端页面（`--web` 的反义）。主要用于 `restart` 时覆盖上次 `--web` 的自动延续；与 `--web` 同时出现时 `--no-web` 优先 |
| `--daemon` / `-d` | — | **仅 HTTP 模式**：后台常驻运行，脱离终端/父进程组，SSH 断开后服务仍存活（`--web` 组合同样生效）；不带 `--http` 时报错 |

子命令 `ki mcp stop`：一键关闭本机所有 ki mcp 实例（stdio + HTTP）并清理残留 lock，见下文「一键关闭」。

子命令 `ki mcp restart`：仅 HTTP 模式，一键重启 HTTP 单例（先关闭现有实例，再以守护进程方式后台常驻重启），见下文「后台常驻与重启」。

多 Token 子命令（scope 授权）：

| 命令 | 说明 |
|------|------|
| `ki mcp token generate --scope <scope>` | 生成强随机 Token（32 字节熵）+ 短 ID，落盘到 `~/.ki/mcp-tokens.json`（0600）。**必须显式指定 `--scope`**（单个 / 逗号分隔多个 / `all` 表示全部），缺省报错（`MCP_TOKEN_SCOPE_REQUIRED`） |
| `ki mcp token list` | 列出所有 Token（含短 ID、明文、授权 scope、创建时间） |
| `ki mcp token update <id> --scope <scope>` | 按短 ID 修改授权 scope；id 不存在报错（`TOKEN_NOT_FOUND`） |
| `ki mcp token delete <id>` | 按短 ID 删除 Token，立即失效；id 不存在报错（`TOKEN_NOT_FOUND`） |

> ⚠️ Windows / WSL 挂载盘（如 NTFS 路径）上 POSIX 0600 权限语义可能不严格生效，托管文件的保护强度依赖文件系统；此类环境建议确保用户主目录位于 Linux 原生文件系统（如 ext4）。

CLI 参数优先于配置文件默认值。

## 前端页面服务（`--web`）与 `/api/*` 扩展路由

`ki mcp --http --web` 在提供 MCP 协议的同时，一并提供**可视化前端静态页面**（浏览器访问 `http://127.0.0.1:7423/`）和**`/api/*` 扩展接口**（方案 A，补齐 MCP 缺失能力，如导入与文档列表）。

```bash
# 启动（需先构建前端产物）
cd web && npm install && npm run build
ki mcp --http --web

# 浏览器打开 http://127.0.0.1:7423/ → 前端页面（总览/浏览/搜索/上传导入/知识写入）
```

### 静态页面

- 页面由 `web/dist` 提供，经 Vite 构建产物（React SPA）。
- **SPA fallback**：非 `/api`、`/mcp` 的 GET 请求若文件不存在，回退返回 `index.html`，由前端路由接管（深链可直达）。
- 有**路径穿越防护**：解析后的路径必须落在 `webDir` 内，否则 403。
- `--web` 已指定但未找到 `index.html` 时打印警告，MCP 服务仍正常启动。
- 前端经 MCP SDK（`StreamableHTTPClientTransport`）同源调用 `/mcp` 工具，`/api/*` 走同源 fetch，无需 CORS。

### `/api/*` 扩展路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康报告（复用 `runHealthCheck` doctor 逻辑，含 zvec 探活）。embedding 探测按 4s 单次预算收紧、网络类失败记 warn，整体 deadline 由探测预算派生 |
| `/api/search-config` | GET | 语义检索默认 `timeout`（秒），仅返回非敏感配置 |
| `/api/doc/list` | GET | Group 路径 + 文档列表（支持 `q` **名称 / 路径**模糊搜索：`group` 与导入源 `sourcePath` 按最长重叠段合并为「逻辑路径」，无 `sourcePath` 时退回 `group/name`；检索词与候选都做归一 —— 反斜杠与全角 `／` 统一为 `/`、去分隔符两侧空白、折叠重复 `/`、去 `./` 与前导/尾随 `/`、大小写不敏感，**纯分隔符/空白视为无检索词**（按不过滤返回）；带 `q` 时每条命中文档附 `matchedBy`（`name` / `path`）与 `logicalPath`。默认分页上限 500，带缓存） |
| `/api/asset` | GET | 读取 group 级附件（`?scope&group&path`，导入时复制的本地图片）；纯文件读取免重启生效；`group`/`path` 双锚点防穿越，非图片后缀与缺失均 404 JSON（不走 SPA fallback） |
| `/api/import/upload` | POST | 上传文件落盘受控目录（`~/.ki/import-uploads/<uploadId>/`）；分批上传可传 `batchIndex`/`batchCount`，最后一批传 `finalize` 后由后端启动导入并返回 `jobId`；同内容重试幂等 |
| `/api/import/upload-status` | GET | 按 `scope`、`uploadId` 查询上传会话状态与 `jobId`，用于标签页重开后找回已启动的导入任务 |
| `/api/import/run` | POST | 兼容原有两步调用：显式触发导入（异步 job，返回 `jobId`）；同一 `uploadId` 且参数一致时返回已有任务，不重复启动。可选 body：`skipDuplicates?: boolean`（缺省 `false`，跳过「内容与库中一致但 `sourcePath` 不同」的疑似重复文档，判定由服务端按预检同一判据重算）、`pickMode?: 'dir'\|'files'\|'mixed'`（本次选择方式，**只有 `'dir'` 才会计算清理候选**）、`pruneStale?: boolean`（是否计算清理候选，缺省关）、`preserveRels?: string[]`（上传失败文件，视为「本次有」，当前无生产调用方）。参数不一致时：job **运行中** → `409 { code: 'IMPORT_JOB_PARAMS_MISMATCH' }`；job **已终态** → 允许新建 job。剔除后为空 → job `failed` + `errorCode: 'ALL_FILES_DUPLICATES'`（`/api/import/status` 会回传 `errorCode`）。切分参数越界（段长 100–4000、重叠 0–500、重叠须小于段长）→ `400 INVALID_CHUNK`，校验在建 job 之前 |
| `/api/import/preflight` | POST | **重复导入预检（只读，无任何写入）**：body `{ scope, uploadId, onlyRelPaths? }`；返回本次文件与库中已有文档「原文一致但 `sourcePath` 不同」的清单 `{ files:{scanned,matched}, duplicates:[{rel,existingGroup,existingRelation,existingSourcePath}], truncated }`，供前端确认后再调 `/api/import/run` |
| `/api/import/prune` | POST | **目录同步清理（破坏性，不可恢复）**：删除「库中存在、本次目录已没有」的文档。body `{ scope, group?, uploadId?, scannedRels?, preserveRels?, token?, selected, dryRun? }`。服务端**重算**候选并校验 `token`（候选集指纹），对不上 → `409 PRUNE_TOKEN_STALE`；`selected` 必填（缺失 → `400`，不允许「缺省 = 全删」）；`dryRun:true` 只重算并返回 `{ plan }`（含新 token），不删除。候选为空 → `200 { allDone: true }`；候选 > 500 → `400 PRUNE_OVER_LIMIT`；闸门（坐标重合率 <80% / 删除占比 >80%）不通过 → `400 PRUNE_CHECK_DISABLED`。删除复用 `executeBatchDelete`（scope 写锁 + 草稿卫兵 + 物理删除，**无回收站**） |
| `/api/datasource/list` | GET | **数据源列表（只读，跨 scope）**：`?scope=` 可选；省略时**必须按 token 授权范围过滤** `sources/missing/corrupt`（只读白名单只约束「以 default 身份能否调用」，不限制返回范围）。返回 `{ total, sources[], missing[], corrupt[] }`；`sources[].type` 为 `directory\|git`，`sources[].git` 为 `{repoRoot,relativeRoot,branch,managed,shortCommit,commitTime,untrackedMarkdown}`（非 git 为 `null`），`sources[].syncAvailability` 为 `{allowed,nextAvailableAt,retryAfterSec,reason}`（`active` / `cooldown` / `null`；旧 daemon 不返回）。`sources[].activeState` 取自任务台账 `operation='datasource-sync'`（`'queued' \| 'running' \| null`，同 scope 运行优先于排队），`sources[].activeStartedAt` 为本次开始时间（排队中为 `null`），`sources[].running = activeState !== null`（派生值），`stale` = 超过 24h 未同步（从未同步也为 true）。另有 `sources[].schedule`（定时计划 + 服务端算出的 `nextRunAt`；旧 daemon 不返回 → 页面显示「当前 daemon 不支持定时同步」）与顶层 `schedulerDisabled`（`KI_DISABLE_DATASOURCE_SCHEDULER=1` 的只读回显）；顶层 `capabilities` 为 `{ datasourceUpdate, scopeReadonly }`（旧 daemon 不返回 → 页面隐藏「编辑」按钮与只读开关，不做假成功） |
| `/api/datasource/detail` | GET | **数据源详情（只读，单 scope）**：`?scope=` 必填；返回完整 `datasource.json`（含 `lastSync.result` / `lastSync.git` / `lastSync.warnings` 与 `pendingDelete`）+ `running` / `activeState` / `activeStartedAt` / `syncAvailability`（口径同 list）。`lastSync.result.files` 含 `fullScanned` / `changed`；`lastSync.result.created[]{group,relation}` + `createdTotal` + `createdTruncated` 是上次同步**新建**的文档（`create`/`suffix` 计入、`overwrite` 不计；旧快照不返回这三个字段）；`pendingDelete.candidateSourcePaths` 与 `seenRels` 是服务端内部基线，**不下发**；`schedule` 与 `schedulerDisabled` 口径同 list；`source.revision` 为配置修订号（仅在登记 / 编辑同步参数时 +1，用于编辑弹窗乐观锁；旧记录缺省 0） |
| `/api/datasource/sync` | POST | **页面触发同步**：body `{ scope, full? }`。同 scope 已有 `datasource-sync` 的 queued/running → `409 SYNC_ALREADY_RUNNING`（带 `taskId`）；普通目录 `lastSync.state='ok'` 且不足 30 分钟 → `429 SYNC_RATE_LIMITED`（带 `nextAvailableAt` / `retryAfterSec`）；源目录不可达 → `409 SOURCE_UNREACHABLE`；任务台账不可读 → `503 TASK_REGISTRY_UNAVAILABLE`。成功 `200 { ok:true, scope, taskId, mode:'incremental'\|'full', state:'queued' }`；返回后任务异步执行，进度/终态见 `/api/tasks` 与 `datasource.json.lastSync`（`partial` 不启动冷却） |
| `/api/datasource/add-remote` | POST | **页面添加 Git 数据源（S-05）**：body `{ scope, url, branch?, subdir?, group?, vector?, conflictMode?, conflictSuffix?, readonly? }`。`readonly:true` 时在**登记成功后**把 scope 写入 `config.scopeReadonly`（添加失败不写、不留只读空库）；写配置失败不回滚登记，改由任务结果 `result.readonlyWarning` 显式回报（页面按警告展示并给出 `ki scope readonly <scope>` 命令）。同步前置校验：`INVALID_SCOPE` / `INVALID_GIT_URL` / `GIT_URL_CREDENTIALS` / `GIT_SCHEME_UNSUPPORTED` / `INVALID_SUBDIR` / `INVALID_BRANCH` / `INVALID_GROUP` → 400；`DATASOURCE_EXISTS` / `SYNC_ALREADY_RUNNING` → 409；台账不可读 → 503；无权限 → 403。成功 `200 { ok:true, scope, taskId, state:'queued' }`：scope 不存在时由登记流程自动初始化（页面支持新建 Scope，名称校验同 CLI）；同一 `remote + 分支` 已有托管 clone 时复用该副本（不重复 clone），并在建任务前校验子目录（不存在 → `400 INVALID_SUBDIR`，错误含仓库顶层目录）；任务 `datasource-add-remote` 在服务端 clone/复用 + 登记（持 scope 与 remote/clone 锁），完成后自动入队 `datasource-sync`（`full`），其任务 id 见 add 任务详情的 `result.syncTaskId`（null = 入队失败）。clone 失败以任务 `errorCode` 回报（`GIT_AUTH_FAILED` / `GIT_REPO_NOT_FOUND` / `GIT_NETWORK_FAILED` / `GIT_BRANCH_NOT_FOUND` / `GIT_CLONE_TIMEOUT` / `SOURCE_EMPTY` / `CLONE_FAILED`）；`file://` 默认拒绝，仅 `KI_DATASOURCE_ALLOW_FILE_URL=1` 的隔离测试环境放行 |
| `/api/datasource/update` | POST | **编辑同步参数（唯一写入口，不触发同步任务）**：body `{ scope, baseRevision?, patch:{ conflictMode?, conflictSuffix?, vector?, chunkSize?, chunkOverlap? } }`。只覆盖传入字段；身份字段（scope / 源目录 / Git URL / 分支 / 子目录 / 落点 Group）不可改（换源需移除后重加）。`chunkSize` 留空 = 默认 1000、`chunkOverlap` 留空 = 默认 150，重叠必须小于段长；`chunkSize` 取值 100–4000、`chunkOverlap` 取值 0–500，越界 → `400 INVALID_CHUNK`（只校验本次传入的字段，库里存的旧超界值不会阻塞改其它字段）。**不触碰 `lastSync` / `schedule`**：新参数自下次同步起生效，历史文档不回填（页面另提供「保存后立即全量同步」走 `/api/datasource/sync`）。`baseRevision` 与 `source.revision` 不一致 → `409 DATASOURCE_STALE`（多标签页乐观锁）；同 scope 有 `datasource-sync` 排队/运行 → `409 SYNC_IN_PROGRESS`（scope 写锁也会以 `SCOPE_OPERATION_BUSY` 兜底）；未登记 → 404；校验失败 → 400（`INVALID_CONFLICT` / `INVALID_CHUNK` / `INVALID_VECTOR`）。成功 `200 { ok:true, scope, record, changed[] }`（`changed` 为空表示无实际变更，不 bump revision） |
| `/api/datasource/prune` | POST | **数据源待删候选的唯一删除接口**（同步触发的写入口是 `/api/datasource/sync`）：body `{ scope, token, selected:[{group,relation}], dryRun? }`。服务端按当前源目录重算候选（扩展名/group/基线均与同步同源）并校验 token（失配 `409`）；`selected` 必填且 ≤500（超出 → `400 PRUNE_SELECTION_TOO_LARGE`），只删「所选 ∩ 可见候选」；**强制 `wikiDelete:false`** —— 只删知识库记录，不动源目录文件。成功回执带剩余 `pendingDelete`（新 token），支持分批删除 |
| `/api/datasource/schedule` | POST | **定时同步配置的唯一写入口**：body `{ scope, schedule: { enabled, mode:'interval'\|'at', intervalValue?, intervalUnit?:'minute'\|'hour'\|'day', at?, repeat?:'once'\|'daily', baseRevision? } }`。写 `datasource.json` 的 `schedule` 字段（scope 写锁 + 原子写），保存后立即重算调度器。校验失败 `400`：`SCHEDULE_INVALID` / `SCHEDULE_INVALID_MODE` / `SCHEDULE_INVALID_INTERVAL` / `SCHEDULE_INTERVAL_TOO_SMALL`（< 1 分钟）/ `SCHEDULE_INTERVAL_TOO_LARGE`（> 365 天）/ `SCHEDULE_AT_INVALID`（含夏令时跳变时刻）/ `SCHEDULE_INVALID_REPEAT`；`baseRevision` 与当前 `revision` 不一致 → `409 SCHEDULE_STALE`（多标签页乐观锁，带当前值）。成功 `200 { ok:true, scope, schedule, nextRunAt, schedulerDisabled }`；`schedulerDisabled` 为 `KI_DISABLE_DATASOURCE_SCHEDULER=1` 的只读回显（保存成功但不会自动执行）。运行态字段（`enabledAt` / `consecutiveFailures` / `lastAutoAt` / `lastAutoFor` / `lastAutoState` / `lastSkipReason` / `lastSkipAt`）只由服务端写，不接受客户端提交。其中 `enabledAt` 是**启用锚点**：「关闭 → 开启」时写入、关闭时清空、改间隔不重置；周期模式的 `nextRunAt` 依次以 `lastSync.at` → `lastAutoAt` → `enabledAt` 为基准（从未同步过的源靠锚点才不会让下次时间随每次读取向后滑）。三者都缺失（旧版本写入 / 从旧快照恢复）时按**已到期**返回（`nextRunAt = now`、`due`），调度器会补跑一次再回到正常节奏 |
| `/api/import/status` | GET | 轮询导入进度/结果（按 `jobId`） |
| `/api/import/cancel` | POST | 请求在当前 embedding/zvec 批次完成后取消导入（body: `{ "jobId": "..." }`） |

**其余路由**（鉴权与入队规则同上）：

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/tags` | GET | scope 下 tag 及文档数；会打开 Collection，走 write 通道 |
| `/api/doc/get` | GET | 读取单篇文档原文；只读 `read` 通道，导入期间不被排队 |
| `/api/doc/edit` | GET / POST | 读取 / 保存文档编辑 |
| `/api/import/config` | GET | 当前 scope 的导入配置（扩展名 / 大小上限）+ 向量维度快照 |
| `/api/import/incomplete` | GET | 未完成重试清单；只读 `read` 通道 |
| `/api/import/retry-incomplete` | POST | 按清单重试未完成文件 |
| `/api/restore/status` | GET | restore / rebuild 任务进度与结果 |
| `/api/vector/status` | GET | 向量维度快照（读取，不排队） |
| `/api/vector/status/refresh` | POST | 主动刷新维度快照；引擎 5s 未响应时降级返回上次快照 |
| `/api/vector/optimize` | POST | 触发索引整理（同 `ki index-optimize`） |
| `/api/tasks` | GET | 任务列表（只含计数，明细走单条） |
| `/api/tasks/:id` | GET | 任务详情 |

`/api/search-config` 返回 `{ "ok": true, "timeout": 3 }` 形式的秒级默认值；只读接口沿用 `/api/*` 的鉴权规则，配置读取异常按现有 API 错误契约返回 JSON 错误，不暴露 embedding API 密钥或端点。

`/api/import/status` 的 `job` 会返回 `state`（`running`/`done`/`failed`/`cancelled`）、`phase`（`scan`/`vectorize`/`persist`）、`progress` 和 `cancelRequested`。服务重启后内存中的 job 状态不保留，需要重新提交或查看 daemon 日志。

导入完成结果中的 `stats.conflicts` 和 `conflicts[]` 会报告同名文件的原 relation、最终 relation 及动作；向量更新只清理受影响文档，无关 Scope 文档不会被全量清空。

Web 导入页在第一批上传前生成 UUID `uploadId` 并存入浏览器，每批发送 `{scope, uploadId, batchIndex, batchCount, files}`——**不再在最后一批带 `finalize`**：全部批次上传完成后，前端先调 `/api/import/preflight` 做重复导入预检，`files.matched === 0` 直接调 `/api/import/run`（body 带 `group?/chunkSize?/chunkOverlap?/vector?/tags?/conflictMode?/conflictSuffix?`）启动导入，`matched > 0` 则展示清单等用户确认：可选「跳过重复文档」（`run` 带 `skipDuplicates: true`，服务端重算并剔除重复项后导入其余）、「仍然导入（会新建副本）」或「取消」（**取消则不导入任何内容**）。`skipDuplicates` 只在 Web 提供（CLI 无对应参数）。全部文件均为疑似重复时按钮禁用；服务端兜底 `ALL_FILES_DUPLICATES`，前端按 `errorCode` 渲染为可纠正提示（不落红色失败态）并恢复面板供改选。`/api/import/run` 对同一 `uploadId` 幂等——已有 job 时返回它，不重复启动。标签页重开时，前端先用 `/api/import/upload-status` 查询 `uploadId`：已生成 `jobId` 则继续查询导入结果，尚未传完则清除本地任务记录，由用户重新选择文件。旧客户端仍可先调用 `/api/import/upload`，再调用 `/api/import/run`。

**目录同步清理（`POST /api/import/prune`）**：导入页可选「导入后提示清理」，`run` 带 `pruneStale:true` + `pickMode:'dir'` 时，导入结果会多一个 `prune` 块（`{ total, items:[{group,relation,sourcePath,untouched}], token, skipReason?, … }`），**只提示不自动删**。用户勾选后再调 `/api/import/prune`。三条不可破的同源约束：① `scannedRels` 必须与 run 用**同一扩展名白名单**重扫暂存目录（`scopes.<scope>.import.extensions`）；② `group` 取 run 时写入的 `uploadId` 会话快照，不用前端表单实时值；③ `preserveRels` 两侧一致。任一不同源 → 候选集漂移 → `token` 恒失配（`409`）。删除成功后候选集已变，前端会用 `dryRun:true` 重算换新 token（否则「失败项可重试」无法成立）。双闸门：本次路径与库中 `sourcePath` 重合率 <80%（多半是选错目录层级）或候选占比 >80% 时整体关闭，不产候选。

上传中站内切页不会取消任务；关闭或刷新标签页后，未传完的文件需要重新选择并上传。尚未启动导入的暂存目录在空闲满 24 小时后，于**下一次新上传**时惰性清理，不做定时扫描。已启动导入的上传目录会登记为源目录，后续编辑/同步可能使用，因此不参与这项清理。`/api/import/status` 的 job 仍是进程内状态，服务重启后可能无法查询，客户端应显示“状态待确认”。

- `/api/*` 与 MCP 会话隔离；鉴权规则与 MCP 一致（非回环绑定强制 Bearer Token）。
- 前端**不启动/不关闭任何服务**，仅检测 MCP HTTP 状态并给出手动指引；向量可视化 zvec-studio 作为独立工具由用户手动启动，前端不集成跳转入口。

### `/api/chat/*`（侧边栏 AI 对话）

需在配置文件的 `llm` 段填写 `baseURL` / `model` / `apiKey`（见 [`docs/configuration.md`](./configuration.md#llm)）。**未配置时接口仍可访问**：`GET /api/chat/config` 返回 `200 + enabled:false`，生成类接口返回 `503 CHAT_DISABLED`。会话文件落在 `{chatDir}/{scope}/`，与 `kb/` **完全分离**。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/chat/config` | GET | 对话可用性：`enabled` / `model` / `baseURLHost` / `requestTimeoutMs` / `supportsTools` / `retrievalEnabled` / `ackRequired` / `maxToolRounds`。**不含 `apiKey` 与完整 URL 路径**；未就绪时仍 200 |
| `/api/chat/config/ack` | POST | 隐私确认（`{"ack":true}`，幂等）→ 原子写落盘 `llm.kbDisclosureAck: true` 并即时生效。**不支持取消确认**（撤销入口在配置文件） |
| `/api/chat/conversations` | GET | 会话列表（`?scope=&archived=0\|1&limit=&cursor=`），按 `(updatedAt, id)` 倒序；损坏文件该条标 `corrupted:true`、其余正常返回 |
| `/api/chat/conversations` | POST | 新建会话（`{scope, title?, systemPrompt?}`；title ≤48 字、systemPrompt ≤4000 字） |
| `/api/chat/conversations` | DELETE | 清空该 scope 全部会话（`?scope=`，幂等；**绝不触碰 `kb/`**） |
| `/api/chat/conversations/:id` | GET | 会话详情（含消息） |
| `/api/chat/conversations/:id` | PATCH | 改 `title` / `systemPrompt`；无任何可改字段 → 400 |
| `/api/chat/conversations/:id` | DELETE | 物理删除（级联删该会话的本地图片；**绝不动 `kb/`**） |
| `/api/chat/conversations/:id/archive` | POST | 归档 / 恢复（`{archived:boolean}`，幂等） |
| `/api/chat/conversations/:id/messages` | POST | 发消息（**SSE**） |
| `/api/chat/conversations/:id/regenerate` | POST | 重新生成（**SSE**；不新增 user 消息、`messageCount` 不变） |
| `/api/chat/conversations/:id/messages/:msgId` | PATCH | 编辑并重发（**SSE**；服务端在同一把会话锁内原子截断其后全部消息；只能编辑 user 消息） |

**SSE 事件序**（前端按 `data.type` 分派，**不使用** SSE `event:` 字段）：

```text
meta → [tool_start → tool_end]* → reasoning* → content* → sources? → usage? → done
```

- `done.warning`：`tool-rounds-exhausted`（已达检索轮次上限）/ `conversation-too-long`（建议新建会话）。
- `degraded.reason`：`tools-unsupported`（上游不支持工具调用）/ `retrieval-unavailable`（检索不可用）/ `semantic-degraded`（语义检索降级为全文）。**至多一条**，且必须向用户可见（N17 禁止静默降级）。
- 中止：客户端 abort → 服务端落盘已生成部分并回 `aborted`；`content` 为空则不落盘（不产生空气泡）。
- 错误分层：流建立**前**失败 → HTTP 状态码（`403 DISCLOSURE_REQUIRED` / `503 CHAT_DISABLED` / `409 CONVERSATION_GENERATING` / `404 CONVERSATION_NOT_FOUND`）；流建立**后**失败 → `error` 事件（不抛）。
- 鉴权与其他 `/api/*` 一致；**访问他 scope 的会话返回 403 而非 404**（防状态码探测枚举）。
- 同一会话**同时只允许一次生成**，并发请求返回 `409 CONVERSATION_GENERATING`。

## 状态自查（`ki mcp --status`）

用于确认「当前是否只有一个持锁进程」以及各 IDE 是否连到同一实例：

```bash
ki mcp --status --host 127.0.0.1 --port 7423
```

输出为 JSON 契约：

```json
{
  "ok": true,
  "running": true,
  "target": { "host": "127.0.0.1", "port": 7423 },
  "healthz": { "ok": true, "name": "kisearch", "pid": 12345, "version": "...", "host": "0.0.0.0", "port": 7423 },
  "lock": { "pid": 12345, "host": "0.0.0.0", "port": 7423, "startedAt": "..." },
  "managedTokens": { "count": 2 },
  "hint": "..."
}
```

- `managedTokens.count`：多 Token 存储（`~/.ki/mcp-tokens.json`）中的 Token 数量，仅报告数量、不回显明文。

- `running=false` 且 `lock` 非空：可能是残留 lock（进程已退出）——直接重启即可，启动时会真实探活覆盖。
- `healthz.host/port` 即该实例对外声明的绑定地址，可据此核对所有 IDE 的 URL 是否一致。

## 条件鉴权

是否启用 Bearer Token 鉴权**由绑定地址决定**：

- **回环地址**（`127.0.0.1` / `localhost` / `::1`）：无网络暴露面，**免鉴权**，Token 可省略。
- **非回环地址**（`0.0.0.0` / 外网 IP，即远程跨机）：**强制 Bearer Token**，未提供则拒绝启动（fail-loud）。

Token 来源优先级：`--token`/环境变量 `KI_MCP_TOKEN`（全权临时 Token）> 多 Token 存储 `~/.ki/mcp-tokens.json`（`ki mcp token generate --scope <...>` 创建），**绝不写入配置文件明文**；非回环启动时会在 stderr 明示本次生效的 Token 来源。鉴权中间件对 `/mcp` 所有方法校验 `Authorization: Bearer <token>`，按明文在存储中匹配（常量时间比较）得到授权 scope 集合，失败返回 401。

**scope 越权校验（RBAC）**：鉴权通过后，中间件会拦截 MCP `tools/call` 请求，提取其 `arguments.scope`（缺省 `default`；完全省略 `arguments` 字段时按缺省 `default` 参与校验），校验是否在该 Token 的授权 scope 集合内（`all` 通配全部）；越权返回 `403`。**例外**：无 scope 参数的枚举工具（`ki_scope_list`、`ki_scope_list`）不做此单点校验，直接放行给工具层按授权集合过滤输出。`/api/*` 接口同样按其 scope 参数（query 或 body）做越权校验。

**枚举工具按授权过滤**：无 scope 参数的枚举工具（`ki_scope_list`、`ki_scope_list`）会在**工具层按授权 scope 集合过滤返回结果**——持有限定 scope Token 的客户端只能看到自己被授权的 scope，无法通过枚举泄露其他 scope 的存在与结构（多租户下 scope 名往往即项目/客户代号）。免鉴权（回环）或 `all` 权限时不过滤。

> ⚠️ **回环绑定时提供 Token 会被忽略**：回环地址鉴权已禁用，若此时仍传 `--token` 或设了 `KI_MCP_TOKEN`，启动会打印提示告知 Token 不生效，避免误以为已鉴权。同理，回环绑定不会读取多 Token 存储。如需鉴权请绑定非回环地址。

## 幂等单例守护

`ki mcp --http` 启动流程（探活与冲突检测均在启动预检之前执行）：

1. 向 `host:port/healthz` 发探活（免鉴权，短超时）。若命中健康的 kisearch 实例 → 打印“已有健康实例（含 pid），复用，退出”并 `exit(0)`，**全程不执行启动预检**——即使在缺 embedding API Key 等环境不完整的 shell 里重复执行也能正常复用。探活地址会将 `0.0.0.0` / `::` / `localhost` 归一到 `127.0.0.1`，确保同机不同写法命中同一实例。
2. 检查升级前遗留的 stdio 实例 lock（`~/.ki/mcp-stdio-<pid>.lock`，每实例一个，pid 存活校验）。若存在存活的旧版直连 stdio 实例 → 拒绝启动（`exit 1`）并指明冲突来源 pid；新版本 stdio 是 daemon 桥，不会产生这类 zvec owner 冲突。
3. 通过守卫后执行启动预检，再 `listen`。embedding 网络/可重试服务故障会重试 1 次，仍失败时记录为 ⚠️ 警告并继续启动；未配置 `embedding.apiKey` 也只告警并继续。配置文件、目录、无效密钥或维度不匹配等硬错误仍 fail-loud。监听失败按错误码给出可诊断提示：`EADDRINUSE`（端口被占用且探活未命中健康实例，提示排查/换端口）、`EACCES`（<1024 端口需提权，建议换高位端口）、`EADDRNOTAVAIL`（本机无该地址）、`ENOTFOUND`（host 无法解析）——均 fail-loud，不自动 kill。
4. 成功监听后写按身份派生的 `~/.ki/mcp-http-<fingerprint>.lock`（记录 `pid` / `host` / `port` / `startedAt`），退出时清理。

因此在多台 IDE 的启动脚本里重复执行 `ki mcp --http` 是安全的：第一台真正拉起服务，其余探活命中后直接退出、复用同一持锁进程——且不要求这些环境都能通过预检。

## stdio 启动与 daemon 桥接

stdio 模式（默认 `ki mcp`）不直接打开 zvec，也不再与 HTTP 单例抢锁：

1. 客户端先按当前配置连接对应 Unix Socket daemon；daemon 不存在时自动拉起 `ki mcp --http --daemon` 并等待健康握手。
2. stdio 的 MCP 消息通过 Streamable HTTP 桥接到 daemon，工具执行和 scope 队列与 CLI/HTTP 请求共用。
3. daemon 配置指纹、协议版本或存活检查失败时，stdio 以明确错误退出；不会静默切换到 direct zvec 路径。

> 多个 stdio 客户端可以同时启动，它们共享同一个 daemon owner；`~/.ki/mcp-stdio-<pid>.lock` 仅用于 `stop`/`status` 进程管理，不代表 zvec 持锁者。HTTP daemon 退出后，stdio 客户端需要重新连接或由 IDE 重启。

## 一键关闭（`ki mcp stop`）

关闭本机所有 ki mcp 实例并清理 lock，适用于「迁移到 HTTP 单例前清场」或「手动排障后恢复干净状态」：

```bash
ki mcp stop
```

工作方式：

1. **定位**：遍历 `~/.ki/mcp-stdio-<pid>.lock`（每实例一个）与 `~/.ki/mcp-http-<fingerprint>.lock` 取服务进程 pid，并探活 `/healthz` 兜底（lock 被手动删过但服务仍在跑的场景）；
2. **身份校验**：发信号前读 `/proc/<pid>/cmdline` 确认目标确为 ki mcp 进程，pid 已被无关进程复用时跳过不杀（仅清陈旧 lock）；
3. **关闭**：SIGTERM 优雅退出（走退出钩子自动释放 lock 与向量库锁），超时 SIGKILL 兜底；
4. **清理**：移除残留/陈旧/损坏的 lock 文件，输出 JSON 报告（每个目标的处置结果 + 被清理的 lock 列表）。

相比手动 `kill <pid>`，它直接对真正的服务进程（即持锁者本体）发信号——`ki mcp` 实际是多层进程链（ki 壳 → npm exec → sh → node mcp-server），手动 kill 顶层壳会留下持锁的孤儿进程，造成「关了还提示冲突、lock 不释放」的假象。

> 若被关闭的 stdio 实例由 IDE 以 command 型配置拉起，IDE 可能自动重启它；迁移 HTTP 单例的正确顺序是：先改 IDE 配置为 URL 型 → `ki mcp stop` → `ki mcp --http`。

> **已知局限**：升级前启动的旧 stdio 进程不写 lock、也无 HTTP 端口，三个定位来源均无法发现它（与启动守卫的「存量进程盲区」同源）；如怀疑仍有此类残留，用 `ps -ef | grep mcp-server` 人工确认后 kill，属一次性迁移成本。

## 后台常驻与重启（`--daemon` / `ki mcp restart`）

### 后台常驻（`--daemon` / `-d`）

`ki mcp --http` 默认**前台运行**（阻塞终端）。如需在服务器上长期部署、断开 SSH 后服务仍存活，加 `--daemon`（或 `-d`）：

```bash
ki mcp --http --daemon          # 后台常驻，终端立即返回
ki mcp --http -d                # 短别名，等价
ki mcp --http --web --daemon    # 含前端页面，同样后台常驻
```

- 守护进程脱离终端与父进程组，`ki` 壳退出后服务继续运行，`SSH` 断开不受影响。
- 启动后终端立即返回，可用 `ki mcp --status` 确认是否就绪（启动含预检，需数秒）。
- **不带 `--http` 时 `--daemon`/`-d` 报错**（`MCP_DAEMON_REQUIRES_HTTP`）：stdio 模式依赖 stdin/stdout 通信，后台运行会丢失传输通道。
- 后台直接启动的进程 stdout/stderr 不落盘（丢弃），排障依赖 `ki mcp --status` 与 `curl http://<host>:<port>/healthz`；`ki mcp restart` 会在停止旧实例前由父进程执行并输出启动预检报告，便于看到 embedding 警告。

### 一键重启（`ki mcp restart`）

```bash
ki mcp restart                  # 沿用上次运行的 host/port，后台常驻重启
ki mcp restart --host 0.0.0.0 --port 7423   # 显式覆盖 host/port 后重启
ki mcp restart --no-web         # 重启但关闭前端页面（覆盖上次 --web 的自动延续）
```

- **仅 HTTP 模式**；语义 = 关闭现有实例 + 以守护进程方式后台重启（重启后默认后台常驻）。
- **幂等**：无运行实例时 `restart` 等价于直接启动（`ok:true` 且提示「已直接后台启动」）。
- **配置保留**：`host`/`port` 解析优先级为 CLI 参数 > lock 文件（上次运行值）> 配置文件 > 默认值；`--token`/`--allowed-hosts` 等其余参数透传给重启后的进程（Token 走既有三级优先级）。
- **`--web` 自动延续**：上次以 `--web` 启动（lock 记录 `web:true`）且本次未显式指定时，重启自动补回 `--web`；用 `--no-web` 可显式关闭，用 `--web` 可显式开启（`--no-web` 优先级高于 `--web`）。
- 输出 JSON 报告：`target`（重启后的 host/port）、`stopped`（被关闭的旧实例）、`cleanedLocks`（清理的 lock）。

> ⚠️ 重启后服务仍需数秒完成预检，`restart` 返回的 `ok:true` 表示已发起后台启动；请用 `ki mcp --status` 确认就绪后再让 IDE 接入。

### 排查

- 查看当前持锁守护进程：`ls ~/.ki/mcp-http-*.lock` 后读取对应文件；stdio 实例：`ls ~/.ki/mcp-stdio-*.lock`（每实例一个，文件名即 pid）
- 旧版单文件残留：`~/.ki/mcp-stdio.lock`（无 pid 后缀）为历史遗留格式，新版已不读它；若确认无旧版进程在跑，可手动 `rm ~/.ki/mcp-stdio.lock` 清理
- 关闭全部实例并清理 lock：`ki mcp stop`
- 探活：`curl http://<host>:7423/healthz` → `{"ok":true,"name":"kisearch","pid":...,"version":"..."}`
- 若端口被占用且探活失败：确认是否为非 ki 进程占用，或换用 `--port` 另起端口。
- **鉴权失败（401）**：Token 无效或缺失。核对客户端 `Authorization: Bearer` 与 `ki mcp token list` 输出的明文完全一致（整段复制勿手抄）；若用全权临时 Token，确认 `--token`/`KI_MCP_TOKEN` 仍在生效。服务端 stderr 有失败原因日志。
- **越权拒绝（403）**：Token 有效但请求的 scope 不在授权内。多 scope（逗号分隔）调用逐段校验，任一段越权即整体拒绝。用 `ki mcp token update <id> --scope <scope>` 扩大该 Token 的授权（或确认客户端请求的 scope 正确）；服务端 stderr 日志含被拒的具体 scope 与授权范围。注意：无 scope 参数的枚举工具（`ki_scope_list`/`ki_scope_list`）无参调用不受此校验限制，出现 403 说明请求的是带 scope 参数的工具或 /api 接口。

## 会话模型

- 每个客户端的 `initialize` 会新建一个 `StreamableHTTPServerTransport` + 一个 McpServer 实例，`mcp-session-id` 标识会话。
- 所有会话的 McpServer 共享 `vector-client` 的模块级单例 engine → 单进程单锁，并发请求由 worker 串行化。
- `POST /mcp`：带命中的 `mcp-session-id` 则复用；无 session 且为 `initialize` 则新建会话；否则 400。
- `GET /mcp`（SSE 下行）、`DELETE /mcp`（关闭会话）按 session id 查表转发。
- **会话上限**：默认最多 256 个并发会话，超出后新的 `initialize` 返回 `503`，防止会话无界增长耗尽内存。
- **空闲回收**：默认 30 分钟无活动的会话会被后台定时清扫关闭（应对客户端异常断开却未发 `DELETE` 的残留会话）；被回收的客户端下次请求需重新 `initialize`。

## 远程安全建议

- 生产远程暴露建议前置 **TLS 反向代理**（如 Nginx/Caddy），HTTP 服务本身只处理明文，TLS 由反代终结。
- 配合防火墙 / 安全组收敛来源 IP；跨机 IDE 来源不定时，可用 `--allowed-hosts` 限定 Host 头以缓解 DNS rebinding。
- Token 推荐用 `ki mcp token generate --scope <...>` 托管（强随机、不进 shell 历史与配置文件，且按 scope 最小授权）；怀疑泄露时 `ki mcp token delete <id>` 立即吊销（或 `ki mcp token update <id> --scope <...>` 收敛权限）。

## 配置文件默认值

可在 `~/.ki/config.yaml` 预置 HTTP 默认监听参数（**不含 token**），CLI 参数优先：

```yaml
mcp:
  http:
    host: 0.0.0.0
    port: 7423
    allowedHosts:
      - ide.example.com
```

## 优雅退出

收到 `SIGINT` / `SIGTERM` 时：关闭所有会话 transport（含空闲清扫定时器）→ 强制断开残留的 keep-alive / SSE 长连接（`closeAllConnections`）→ `closeEngine()` 释放向量库锁 → 关闭 http server → 删除 lock 文件。整个流程有 5 秒兜底超时，超时则强制 `exit`，杜绝残留进程仍持锁。

> 注意：`kill -9`（SIGKILL）/ 断电不会触发优雅退出，lock 文件会残留但无害（下次启动真实探活后覆盖）；正常停机请用 `SIGTERM` / `SIGINT`（`Ctrl-C`）。

## 相关文档

- [CLI 参考 · `mcp` 命令](./cli.md) — 完整命令与工具清单
- [架构与协作关系](./architecture.md) — 分层关系、向量层与三层标签
