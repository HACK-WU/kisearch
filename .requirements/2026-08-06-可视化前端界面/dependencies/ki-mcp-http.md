# ki MCP HTTP 服务（前端后端底座）

## 基本信息

| 字段 | 内容 |
|------|------|
| 类型 | 内部服务（本项目自身能力，作为前端集成对象） |
| 用途 | 前端后端底座：经 MCP 协议（Streamable HTTP）调用 ki 的全部能力 |
| 本地文档 | `docs/mcp-http.md`（MCP HTTP 共享单例模式）、`docs/cli.md`（mcp 命令 + 工具清单） |
| 启动方式 | `ki mcp --http [--host <h>] [--port <n>]` |

## 地址汇总（重要）

| 用途 | 地址 |
|------|------|
| MCP 端点 | `http://127.0.0.1:7423/mcp`（Streamable HTTP，POST 请求 + SSE 下行） |
| 健康探活 | `http://127.0.0.1:7423/healthz`（`GET`，返回 `{ok, name, pid, version}`） |
| 状态自查 | `ki mcp --status`（JSON：running/target/healthz/lock/hint） |
| lock 文件 | `~/.ki/mcp-http.lock`、`~/.ki/mcp-stdio.lock` |

## 关键能力（MCP 工具全集，11 个）

| 工具名 | 类型 | 功能 |
|--------|------|------|
| `ki_search` | 读 | 语义检索（hybrid：向量 + BM25） |
| `ki_query_group` | 读 | Group 树 + Relations |
| `ki_get_module_info` | 读 | 读取 KB Markdown 原文 |
| `ki_manage_index_list` | 读 | 列出 scope + 顶层 Group |
| `ki_scope_list` | 读 | scope 列表（KB + 向量两层） |
| `ki_tag_list` | 读 | tag 列表 |
| `ki_manage_index_create` | 写 | 创建 Group 节点 |
| `ki_manage_index_delete` | 写 | 删除空 Group 节点 |
| `ki_sync_relation` | 写 | 写入 Relation |
| `ki_store` | 写 | 存储单条文本 |
| `ki_bulk_store` | 写 | 批量存储 |
| `ki_delete_relation` | 写 | 删除 Relation |

> **零破坏性约束**：MCP 工具集无 `doc delete` / `scope clear|delete` 等破坏性操作（仅在 CLI 暴露）。前端管理页删除类功能需经 CLI 通道或降级。
>
> **导入缺口**：`scan-kb import`（直导/切分/增量）无对应 MCP 工具（REQ-F06 待补）。

## 认证与配置

- **回环绑定（默认 `127.0.0.1`）免鉴权**，开箱即用
- 非回环绑定（`--host 0.0.0.0`）强制 Bearer Token：`--token` > 环境变量 `KI_MCP_TOKEN` > 托管文件 `~/.ki/mcp-token`
- 会话：每个客户端 `initialize` 新建会话（`mcp-session-id`），默认上限 256 个并发会话，30 分钟空闲回收

## 限流与配额

- 会话上限 256（超出返回 503）
- 空闲会话 30 分钟回收

## 风险与注意事项

- **锁语义**：`ki mcp --http` 是向量库唯一持锁者；前端调用方不得再起 stdio 实例（会冲突）
- **幂等启动**：重复执行 `ki mcp --http` 安全（探活命中即复用退出），前端启动脚本可直接拉起
- **URL 一致性**：所有客户端必须使用完全一致的 URL（host/port），避免各自拉起独立进程
- 前端应通过官方 MCP SDK 通信（见 `mcp-sdk.md`），而非手写 JSON-RPC
