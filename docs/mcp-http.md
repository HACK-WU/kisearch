# MCP HTTP 共享单例模式

## 解决的问题

嵌入式向量库 `~/.ki/vector/` 同一时刻只能被**一个进程**持锁打开。当一台服务器连接多个 IDE，每个 IDE 各自用 `command: ki mcp`（stdio）拉起独立子进程时，只有一个进程能拿到锁，其余全部降级（`vectorAvailable: false`）。

HTTP 共享单例模式让 `ki mcp` 以**单进程 HTTP 服务**运行，作为向量库唯一持锁者，所有 IDE（本地或远程跨机）经 URL 共享同一进程 —— 从根本上消除多进程锁冲突。

## 快速开始

在服务器上手动启动一次（幂等，重复运行安全）：

```bash
# 仅本机访问（默认即回环绑定 127.0.0.1，免鉴权，开箱即用）
ki mcp --http

# 远程跨机访问（非回环绑定，强制 Token）
export KI_MCP_TOKEN='your-strong-secret'
ki mcp --http --host 0.0.0.0 --port 7423
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
| `--http` | — | 启用 Streamable HTTP 传输（不传则走 stdio，行为完全不变） |
| `--host <h>` | `127.0.0.1` | 监听地址。默认回环（`127.0.0.1`/`localhost`/`::1`）免鉴权；对外监听改 `0.0.0.0` 并必须带 Token |
| `--port <n>` | `7423` | 监听端口（1-65535） |
| `--token <t>` | — | Bearer Token；推荐用环境变量 `KI_MCP_TOKEN`。**非回环绑定时必填** |
| `--allowed-hosts <a,b>` | — | 开启 DNS rebinding 保护并限定允许的 Host 头（逗号分隔） |
| `--status` | — | 只读诊断：读取 lock 文件并探活，输出当前 HTTP 单例运行状态（JSON），不启动服务、跳过预检 |

CLI 参数优先于配置文件默认值。

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
  "healthz": { "ok": true, "name": "KiSearch", "pid": 12345, "version": "...", "host": "0.0.0.0", "port": 7423 },
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

Token 来源仅限 `--token <t>` 或环境变量 `KI_MCP_TOKEN`（推荐 env），**绝不写入配置文件明文**。鉴权中间件对 `/mcp` 所有方法校验 `Authorization: Bearer <token>`，常量时间比较，失败返回 401。

> ⚠️ **回环绑定时提供 Token 会被忽略**：回环地址鉴权已禁用，若此时仍传 `--token` 或设了 `KI_MCP_TOKEN`，启动会打印提示告知 Token 不生效，避免误以为已鉴权。如需鉴权请绑定非回环地址。

## 幂等单例守护

`ki mcp --http` 启动流程：

1. 向 `host:port/healthz` 发探活（免鉴权，短超时）。若命中健康的 KiSearch 实例 → 打印“已有健康实例，复用，退出”并 `exit(0)`。探活地址会将 `0.0.0.0` / `::` / `localhost` 归一到 `127.0.0.1`，确保同机不同写法命中同一实例。
2. 否则 `listen`。监听失败按错误码给出可诊断提示：`EADDRINUSE`（端口被占用且探活未命中健康实例，提示排查/换端口）、`EACCES`（<1024 端口需提权，建议换高位端口）、`EADDRNOTAVAIL`（本机无该地址）、`ENOTFOUND`（host 无法解析）——均 fail-loud，不自动 kill。
3. 成功监听后写 `~/.ki/mcp-http.lock`（记录 `pid` / `host` / `port` / `startedAt`），退出时清理。

因此在多台 IDE 的启动脚本里重复执行 `ki mcp --http` 是安全的：第一台真正拉起服务，其余探活命中后直接退出、复用同一持锁进程。

### 排查

- 查看当前持锁守护进程：`cat ~/.ki/mcp-http.lock`
- 探活：`curl http://<host>:7423/healthz` → `{"ok":true,"name":"KiSearch","pid":...,"version":"..."}`
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
- Token 请使用足够强度的随机串，通过环境变量注入，避免出现在 shell 历史或配置文件中。

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
- [架构与协作关系](./architecture.md) — KiSearch 与向量数据库的分层关系
- [向量引擎与内存](./vector-engine-mem.md) — 嵌入式向量库与锁机制
