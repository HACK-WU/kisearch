# 文档索引

按「我想做什么」找文档。全部文档都在本目录，文件名为准；不确定从哪开始，先看 [快速开始](../README.md#quickstart)。

## 第一次用

| 我想… | 看这篇 |
|---|---|
| 安装、初始化配置、首次导入 | [build-kb.md](./build-kb.md) |
| 了解配置项（数据目录 / embedding / llm / scope） | [configuration.md](./configuration.md) |
| 把外部 Markdown 目录导进来（参数、幂等、预检、清理） | [import.md](./import.md) |
| 确认导入/写入是否成功 | [verify-index.md](./verify-index.md) |

## 日常操作

| 我想… | 看这篇 |
|---|---|
| 查知识（索引直查 / 语义检索 / 未命中怎么办） | [query-kb.md](./query-kb.md) |
| 管理 Group（创建 / 删除 / 列表 / 分区） | [group.md](./group.md) |
| 备份与恢复 scope | [backup-restore.md](./backup-restore.md) |
| 看几个完整的使用场景 | [workflows.md](./workflows.md) |

## 参考

| 内容 | 文档 |
|---|---|
| 全部 CLI 命令与参数 | [cli.md](./cli.md) |
| 配置项逐条说明与字段校验 | [configuration.md](./configuration.md) |
| MCP HTTP 共享单例、鉴权、`/api/*` 路由 | [mcp-http.md](./mcp-http.md) |
| 13 个 MCP 工具及参数 | [mcp-tools.md](./mcp-tools.md) |
| 常见报错与恢复方式 | [error-handling.md](./error-handling.md) |

## 机制与设计

| 内容 | 文档 |
|---|---|
| 数据文件、运行链路、导入链路、向量层与三层标签 | [architecture.md](./architecture.md) |
| 文档多语言代码块写法（`::: code-group`） | [markdown-multilang.md](./markdown-multilang.md) |

## Agent 集成

| 内容 | 文档 |
|---|---|
| Skill / Rule 安装，以及「先查、再判断、后写入」工作流 | [agent-integration.md](./agent-integration.md) |
| Agent 常用命令语法（codekb 规则的公共参考） | [ki-command-guide.md](./ki-command-guide.md) |
| Agent 检索/写入行为规则（四步走、白名单/黑名单） | [codekb-agent-guide.md](./codekb-agent-guide.md) |

> `ki-command-guide.md` 与 `codekb-agent-guide.md` 是**给 AI 工具读的规则文件**，不是入门教程；人类读者优先看上面各节。

## 归档

以下为内部一次性产物，保留供追溯，不再维护：

- [archive/req-chat-mcp-tools-refactor.md](./archive/req-chat-mcp-tools-refactor.md) —— AI 对话工具化改造的 PM 需求报告
- [archive/assessment-langchain-adoption.md](./archive/assessment-langchain-adoption.md) —— 是否引入 LangChain 的技术评估

## 约定

- 命令、参数、工具数量以代码为准：CLI 见 [`bin/ki.mjs`](../bin/ki.mjs)、MCP 工具见 [`src/lib/mcp-tools/`](../src/lib/mcp-tools/)、Web 页面见 [`web/src/router/routes.tsx`](../web/src/router/routes.tsx)。
- 指南类文档写「场景 + 步骤 + 验证」，参考类文档写「语法 + 参数 + 示例」，同一事实只在最合适的一篇里写全，其余引用。
