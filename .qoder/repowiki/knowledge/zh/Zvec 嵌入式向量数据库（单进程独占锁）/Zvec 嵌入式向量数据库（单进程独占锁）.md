---
kind: external_dependency
name: Zvec 嵌入式向量数据库（单进程独占锁）
slug: zvec
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
source_files:
    - src/zvec-engine/index.ts
    - src/lib/vector-client.ts
---

### Zvec 向量引擎
- 角色：ki 的本地向量检索与 Embedding 存储后端，通过 `@zvec/zvec` npm 包以 C++ 扩展形式嵌入 Node.js 进程。
- 集成点：`src/zvec-engine/`（引擎封装）、`src/lib/vector-client.ts`（对外 vector-client API，含 `probeWithRetry`、`ensureVectorAvailable`、`runWithVectorSource` 等）。
- 关键约束：**单进程独占文件锁**——导入 CLI（`scan-kb import`）持有 LOCK 期间，MCP HTTP 服务收到任何向量类请求都会触发 `probeWithRetry` 重试 3 次后抛出 `CollectionLockedException`；idle close 机制会在空闲时释放引擎，但重启后 reopen 仍可能撞上残留锁。
- 使用模式：向量集合按 scope 隔离（如 `scopes.default`），collection 不存在则自动创建；embedding 维度由配置 `embedding.dimension` 决定（当前为 4096），变更需重建集合。
- 外部依赖：Embedding 调用走 `https://api.siliconflow.cn/v1/embeddings`（SiliconFlow 提供商），API Key 从 `~/.ki/config.yaml` 的 `embedding.apiKey` 读取。
- 验证要点：修改 `src/zvec-engine/` 导出面后必须执行 `npm run build:zvec-engine` 重建 `dist/zvec-engine/**`，否则上层加载到旧产物。