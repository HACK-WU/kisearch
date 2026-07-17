# 第三方依赖文档索引

> 关联需求：REQ-20260717-001（KiSearch 基于 zvec(Node) 构建常驻 MCP 向量服务）
> 整理日期：2026-07-17

## 依赖总览

| 依赖名称 | 类型 | 用途 | 详情文档 | 信息完整度 |
|---|---|---|---|---|
| zvec | SDK / 嵌入式向量数据库 | KiSearch 向量引擎（替换 lancedb） | [zvec.md](./zvec.md) | ✅ 完整（官方文档 + 实测） |

## 说明

- 本需求仅涉及 1 个第三方依赖（zvec），故直接收集、未走 task-dispatch 并行。
- zvec 为进程内嵌入式向量库（Rust 内核），提供 Node (`@zvec/zvec`) 与 Python (`zvec`) 双 SDK，引擎质量与语言无关。
- KiSearch 采用 Node SDK，并在其之上自建 MCP server（官方 MCP server 为 Python/uvx，与本需求 Node 形态不符，见 zvec.md §6）。
- 选型实证（Recall@5 95%、查询 0.8ms）见 `../reference/benchmark-zvec-vs-mem.md`。
