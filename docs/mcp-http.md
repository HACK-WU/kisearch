# MCP HTTP 共享单例模式

## 解决的问题

嵌入式向量库 `~/.ki/vector/` 同一时刻只能被**一个进程**持锁打开。当一台服务器连接多个 IDE，每个 IDE 各自用 `command: ki mcp`（stdio）拉起独立子进程时，只有一个进程能拿到锁，其余全部降级（`vectorAvailable: false`）。

HTTP 共享单例模式让 `ki mcp` 以**单进程 HTTP 服务**运行，作为向量库唯一持锁者，所有 IDE（本地或远程跨机）经 URL 共享同一进程 —— 从根本上消除多进程锁冲突。

## 快速开始

在服务器上手动启动一次（幂等，重复运行安全）：

```bash
# 仅本机访问（默认即回环绑定 127.0.0.1，免鉴权，开箱即用）
ki mcp --http

# 远程跨机访问（非回环绑定，强制 Token）：一键生成托管 Token 后直接启动
ki mcp token generate       # 输出 Token 明文，持久化到 ~/.ki/mcp-token（0600）
ki mcp --http --host 0.0.0.0 --port 7423   # 启动时自动读取托管 Token，无需 export
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
> ⚠️ **所有 IDE 必须使用完全一致的连接 URL**（`host`/`port` 一字不差，且不要混用 `localhost` 与 `127.0.0.1` 以外的写法）。URL 不一致会各自拉起独立进程，退回锁冲突。同样地，**不要再保留任何 IDE 的 stdio `command: ki mcp` 配置**，混用 stdio 会与 HTTP 单例争抢向量库锁。可用 `ki mcp --status` 确认当前是否只有一个持锁进程。

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--http` | — | 启用 Streamable HTTP 传输（不传则走 stdio，启动时同样经过多实例冲突守卫，见下文「stdio 启动守卫」） |
| `--host <h>` | `127.0.0.1` | 监听地址。默认回环（`127.0.0.1`/`localhost`/`::1`）免鉴权；对外监听改 `0.0.0.0` 并必须带 Token |
| `--port <n>` | `7423` | 监听端口（1-65535） |
| `--token <t>` | — | Bearer Token（显式传入，优先级最高）。**非回环绑定时必须有 Token**，推荐用 `ki mcp token generate` 托管 |
| `--allowed-hosts <a,b>` | — | 开启 DNS rebinding 保护并限定允许的 Host 头（逗号分隔） |
| `--status` | — | 只读诊断：读取 lock 文件并探活，输出当前 HTTP 单例运行状态（JSON，含托管 Token 存在性），不启动服务、跳过预检 |
| `--web` | — | HTTP 模式下同时提供前端静态页面（默认 `web/dist`，浏览器访问 `http://<host>:<port>/`）；未找到构建产物时提示但不阻塞 MCP 启动 |
| `--no-web` | — | 显式关闭前端页面（`--web` 的反义）。主要用于 `restart` 时覆盖上次 `--web` 的自动延续；与 `--web` 同时出现时 `--no-web` 优先 |
| `--daemon` / `-d` | — | **仅 HTTP 模式**：后台常驻运行，脱离终端/父进程组，SSH 断开后服务仍存活（`--web` 组合同样生效）；不带 `--http` 时报错 |

子命令 `ki mcp stop`：一键关闭本机所有 ki mcp 实例（stdio + HTTP）并清理残留 lock，见下文「一键关闭」。

子命令 `ki mcp restart`：仅 HTTP 模式，一键重启 HTTP 单例（先关闭现有实例，再以守护进程方式后台常驻重启），见下文「后台常驻与重启」。

托管 Token 子命令：

| 命令 | 说明 |
|------|------|
| `ki mcp token generate` | 一键生成密码学强随机 Token（32 字节熵）并托管到 `~/.ki/mcp-token`（0600）；**已存在时拒绝覆盖**并提示改用 reset |
| `ki mcp token show` | 查看当前托管 Token 明文（含路径与创建时间），便于配置多个 IDE 客户端；不存在时报错（`MCP_TOKEN_NOT_FOUND`）并提示先 generate，文件存在但为空时报错（`MCP_TOKEN_EMPTY`）并提示用 reset 重建 |
| `ki mcp token reset --yes` | 轮换：生成新 Token 覆盖旧值。破坏性操作，必须显式 `--yes` 确认；重置后需更新客户端并重启运行中的服务（若启动环境设有 `KI_MCP_TOKEN`/`--token`，其优先级高于托管文件，需一并更新） |

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
| `/api/health` | GET | 健康报告（`runHealthCheck` doctor 逻辑，含 zvec 探活，10s 超时） |
| `/api/doc/list` | GET | Group 路径 + 文档列表（支持 `q` 文件名模糊搜索，默认分页上限 500，带缓存） |
| `/api/import/upload` | POST | 上传文件落盘受控目录（`~/.ki/import-uploads/<uploadId>/`），返回 `uploadId` |
| `/api/import/run` | POST | 触发导入（`full`/`incremental`，异步 job，返回 `jobId`） |
| `/api/import/status` | GET | 轮询导入进度/结果（按 `jobId`） |

- `/api/*` 与 MCP 会话隔离；鉴权规则与 MCP 一致（非回环绑定强制 Bearer Token）。
- 前端**不启动/不关闭任何服务**，仅检测 MCP HTTP 状态并给出手动指引；向量可视化 zvec-studio 作为独立工具由用户手动启动，前端不集成跳转入口。

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
  "hint": "..."
}
```

- `running=false` 且 `lock` 非空：可能是残留 lock（进程已退出）——直接重启即可，启动时会真实探活覆盖。
- `healthz.host/port` 即该实例对外声明的绑定地址，可据此核对所有 IDE 的 URL 是否一致。

## 条件鉴权

是否启用 Bearer Token 鉴权**由绑定地址决定**：

- **回环地址**（`127.0.0.1` / `localhost` / `::1`）：无网络暴露面，**免鉴权**，Token 可省略。
- **非回环地址**（`0.0.0.0` / 外网 IP，即远程跨机）：**强制 Bearer Token**，未提供则拒绝启动（fail-loud）。

Token 来源三级优先：`--token` > 环境变量 `KI_MCP_TOKEN` > 托管文件 `~/.ki/mcp-token`（`ki mcp token generate` 生成），**绝不写入配置文件明文**；非回环启动时会在 stderr 明示本次生效的 Token 来源。鉴权中间件对 `/mcp` 所有方法校验 `Authorization: Bearer <token>`，常量时间比较，失败返回 401。

> ⚠️ **回环绑定时提供 Token 会被忽略**：回环地址鉴权已禁用，若此时仍传 `--token` 或设了 `KI_MCP_TOKEN`，启动会打印提示告知 Token 不生效，避免误以为已鉴权。同理，回环绑定不会读取托管文件。如需鉴权请绑定非回环地址。

## 幂等单例守护

`ki mcp --http` 启动流程（探活与冲突检测均在启动预检之前执行）：

1. 向 `host:port/healthz` 发探活（免鉴权，短超时）。若命中健康的 kisearch 实例 → 打印“已有健康实例（含 pid），复用，退出”并 `exit(0)`，**全程不执行启动预检**——即使在缺 embedding API Key 等环境不完整的 shell 里重复执行也能正常复用。探活地址会将 `0.0.0.0` / `::` / `localhost` 归一到 `127.0.0.1`，确保同机不同写法命中同一实例。
2. 检查 stdio 实例 lock（`~/.ki/mcp-stdio.lock`，pid 存活校验）。若存在存活的 stdio 实例 → 拒绝启动（`exit 1`）并指明冲突来源 pid，避免 HTTP 单例与 stdio 进程争抢向量库锁后静默降级。
3. 通过守卫后执行启动预检，再 `listen`。监听失败按错误码给出可诊断提示：`EADDRINUSE`（端口被占用且探活未命中健康实例，提示排查/换端口）、`EACCES`（<1024 端口需提权，建议换高位端口）、`EADDRNOTAVAIL`（本机无该地址）、`ENOTFOUND`（host 无法解析）——均 fail-loud，不自动 kill。
4. 成功监听后写 `~/.ki/mcp-http.lock`（记录 `pid` / `host` / `port` / `startedAt`），退出时清理。

因此在多台 IDE 的启动脚本里重复执行 `ki mcp --http` 是安全的：第一台真正拉起服务，其余探活命中后直接退出、复用同一持锁进程——且不要求这些环境都能通过预检。

## stdio 启动守卫

stdio 模式（默认 `ki mcp`）同样在启动时强制检查多实例冲突，**不允许多进程静默共存降级**：

1. **已有健康 HTTP 单例**（按配置/默认地址探活 `host:port/healthz`）→ 拒绝启动（`exit 1`），提示将本 IDE 配置改为 URL 型接入 `{ "url": "http://<host>:<port>/mcp" }`。
2. **已有存活的 stdio 实例**：守卫以**原子独占方式**创建自身 lock（`~/.ki/mcp-stdio.lock`，pid + startedAt），创建失败即说明已有存活实例 → 拒绝启动（`exit 1`）并提示冲突 pid。独占创建保证多个 IDE **同时**拉起 stdio 时也只有一个胜出，不存在预检窗口内的竞态共存。
3. lock 在守卫阶段（预检之前）即登记，退出时自动清理（含预检失败路径）；`kill -9` 残留的陈旧锁会在下次启动的存活校验中自动清理，不会误拦。

> ⚠️ 被拒绝的 stdio 进程会在 stderr 给出完整出路后非 0 退出；部分 IDE 会自动重拉 MCP 进程，若 MCP 日志中反复出现该提示，请按提示将该 IDE 的配置迁移为 URL 型接入。
>
> 注意：守卫基于 lock 文件，升级前启动的存量 stdio 进程没有 lock，对守卫不可见，需手动清理一次（`ps -ef | grep 'ki mcp'`）。

## 一键关闭（`ki mcp stop`）

关闭本机所有 ki mcp 实例并清理 lock，适用于「迁移到 HTTP 单例前清场」或「手动排障后恢复干净状态」：

```bash
ki mcp stop
```

工作方式：

1. **定位**：读 `~/.ki/mcp-stdio.lock`、`~/.ki/mcp-http.lock` 取服务进程 pid，并探活 `/healthz` 兜底（lock 被手动删过但服务仍在跑的场景）；
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
- 后台进程的 stdout/stderr 不落盘（丢弃），排障依赖 `ki mcp --status` 与 `curl http://<host>:<port>/healthz`。

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

- 查看当前持锁守护进程：`cat ~/.ki/mcp-http.lock`；stdio 实例：`cat ~/.ki/mcp-stdio.lock`
- 关闭全部实例并清理 lock：`ki mcp stop`
- 探活：`curl http://<host>:7423/healthz` → `{"ok":true,"name":"kisearch","pid":...,"version":"..."}`
- 若端口被占用且探活失败：确认是否为非 ki 进程占用，或换用 `--port` 另起端口。

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
- Token 推荐用 `ki mcp token generate` 托管（强随机、不进 shell 历史与配置文件）；怀疑泄露时 `ki mcp token reset --yes` 立即轮换并重启服务。

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
- [架构与协作关系](./architecture.md) — kisearch 与向量数据库的分层关系
- [向量引擎与内存](./vector-engine-mem.md) — 嵌入式向量库与锁机制
