# zvec-studio（应用 + REST API）

## 基本信息

| 字段 | 内容 |
|------|------|
| 类型 | 外部服务 + 第三方 API（向量数据库可视化管理工具） |
| 官方仓库 | https://github.com/zvec-ai/zvec-studio |
| 官方 API 文档 | https://github.com/zvec-ai/zvec-studio/blob/main/docs/api.md |
| 本地参考副本 | `/root/knowledge-indexer/zvec-studio/`（本仓库内，仅参考） |
| 用途 | ①向量数据可视化（集合/文档/向量检索浏览）②前端导航"向量可视化"跳转目标 ③可按需调用其 REST API |
| 启动方式 | `zvec-studio`（pip 安装后命令）或从源码 `make dev`；内部进程拉起用 `zvec-studio` 命令 |
| 版本要求 | pip `zvec-studio` 或源码；Node ≥ 20、pnpm ≥ 9、Python ≥ 3.10（源码运行） |

## 地址汇总（重要）

| 用途 | 地址 |
|------|------|
| 应用首页 | `http://127.0.0.1:7861`（**已决策改用 7861**，避免与默认冲突） |
| API Base | `http://127.0.0.1:7861/api/v1` |
| Swagger UI | `http://127.0.0.1:7861/docs` |
| ReDoc | `http://127.0.0.1:7861/redoc` |
| OpenAPI Schema | `http://127.0.0.1:7861/openapi.json` |
| 健康检查 | `GET /api/v1/healthz`（liveness）、`GET /api/v1/readyz`（readiness） |

> 端口通过启动参数 `--port 7861` 指定（`cli.py` 默认 7860）。前端一键启动命令：`zvec-studio --port 7861`。

## 接口清单（按需，完整见官方 api.md）

### 集合（Collections）
| 接口 | 方法 | 用途 |
|------|------|------|
| `/collections` | GET | 列出打开的集合 |
| `/collections` | POST | 创建并打开集合 |
| `/collections/{name}` | GET | 集合详情（schema + stats） |
| `/collections/{name}/documents:browse` | POST | 过滤浏览文档（`filter` + `limit`） |
| `/collections/{name}/searches` | POST | 向量检索（单/多向量 + reranker） |

### 文档（Documents）
| 接口 | 方法 | 用途 |
|------|------|------|
| `/collections/{name}/documents` | POST | 单条/批量插入 |
| `/collections/{name}/documents/{id}` | GET/DELETE | 按主键取/删 |
| `/collections/{name}/documents:upsert` | POST | 按 id upsert |
| `/collections/{name}/documents:deleteBatch` | POST | 批量删除 |
| `/collections/{name}/documents:deleteByFilter` | POST | 按过滤表达式删除 |

### 向量检索（Vector search）
- `POST /collections/{name}/searches`，请求体：`{ vector | queries, topK, filter, outputFields, rerankerName }`
- 响应：`{ results: [{id, score, fields}], tookMs, traceId }`
- 支持多向量查询（1-8 个）、per-query 索引参数（HNSW ef / IVF nprobe）、融合重排（rrf / weighted）

### AI 扩展（Embeddings / Rerankers）
- `/ai/embeddings` CRUD + `:embed`（编码 texts → vectors）
- `/ai/rerankers` CRUD + `:rerank`（交叉编码器重排；融合类 rrf/weighted 只能在集合查询中引用）

### 文件系统
- `GET /fs/list?path=...&show_hidden=false`（目录选择器用）

## 认证与配置

- **无认证**（本机 127.0.0.1 回环部署）
- 配置：`~/.zvec-studio/config.json`（最近打开路径持久化）
- 每次响应携带 `X-Trace-Id` 头

## 限流与配额

- 无明确限流；文档浏览 `limit` 由请求方控制
- 最近打开列表最多 10 条

## 错误码（RFC 7807）

| HTTP | code | 含义 |
|------|------|------|
| 400 | `INVALID_FILTER_EXPRESSION` / `DIMENSION_MISMATCH` | 过滤 DSL 解析失败 / 查询向量维度不符 |
| 404 | `COLLECTION_NOT_FOUND` / `DOCUMENT_NOT_FOUND` | 集合未打开 / 主键不存在 |
| 409 | `COLLECTION_ALREADY_EXISTS` | 重复 create/open |
| 422 | `INVALID_SCHEMA` | schema 校验失败 |
| 503 | `AI_DEPENDENCY_MISSING` | 可选 ML 包未安装 |

## 风险与注意事项

- **与本项目的关系**：zvec-studio 是**独立的官方工具**（查看的是其自有 collection 数据），不是 ki 的向量库界面。ki 的向量数据位于 `~/.ki/vector/`（zvec collection），zvec-studio 能否直接打开该库需在设计中验证（取决于 zvec-studio 的 open 机制是否支持任意 collection 路径）
- 内部启动需处理：未安装（引导 pip install / 源码）、端口 7860 被占用（探测 + 提示）
- 前端集成定位为"跳转 + 一键启动"（REQ-F09），API 调用为可选增强
- 破坏性维护动词（`:destroy`、`:optimize`）勿在 ki 前端暴露
