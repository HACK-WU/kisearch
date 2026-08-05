# memory-lancedb-pro

`memory-lancedb-pro/` 目录是一个独立的项目。它的地址是：`git@github.com:CortexReach/memory-lancedb-pro.git`

## 项目简介

**memory-lancedb-pro** 是一个面向 [OpenClaw](https://github.com/openclaw/openclaw) 代理的**生产级长期记忆插件**（OpenClaw Plugin），基于 LanceDB 向量数据库，可为 AI Agent 提供跨会话、跨 Agent、跨时间的长期记忆能力：自动捕获偏好、决策与项目上下文，并在后续会话中自动召回。

- 核心能力：自动捕获（Auto-Capture）、智能抽取（Smart Extraction）、智能遗忘（Weibull 衰减）、混合检索（向量 + BM25 + 交叉编码器重排）、上下文注入、多作用域隔离（Multi-Scope）、任意 OpenAI 兼容 Embedding 提供商。
- 适用生态：OpenClaw（主）、Claude Code（通过配套 Skill）。
- 安装方式：`openclaw plugins install memory-lancedb-pro@beta` 或 `npm i memory-lancedb-pro@beta`（npm 需手动在 `openclaw.json` 的 `plugins.load.paths` 配置绝对路径）。

## 关键约定（针对本仓库中的 memory-lancedb-pro 子目录）

- **独立 Git 仓库**：`memory-lancedb-pro/` 是独立 repo，与父仓库 `knowledge-indexer` 的提交、分支互不相关，改动需进入该目录单独提交/推送。
- **不要与内置 `memory-lancedb` 混淆**：本目录是 Pro 增强版，新增了 BM25 全文检索、混合融合、交叉编码器重排、生命周期衰减、多层抽取等能力。
- **插件类型**：安装在 OpenClaw 的 `plugins.slots.memory` 槽位，配置键为 `memory-lancedb-pro`。
- **生命周期 Hook（OpenClaw 2026.3+）**：自动召回使用 `before_prompt_build` 钩子（非已废弃的 `before_agent_start`）；命令钩子（如 `command:new`）通过 `api.registerHook` 注册，生命周期钩子通过 `api.on` 注册。
- **jiti 缓存**：修改插件 `.ts` 源码后，必须 `rm -rf /tmp/jiti/` 再 `openclaw gateway restart`，否则改动不生效。

## 常见操作

```bash
# 在 openclaw.json 中绑定插件
"plugins": {
  "slots": { "memory": "memory-lancedb-pro" },
  "entries": {
    "memory-lancedb-pro": {
      "enabled": true,
      "config": {
        "embedding": { "provider": "openai-compatible", "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small" },
        "autoCapture": true, "autoRecall": true, "smartExtraction": true,
        "extractMinMessages": 2, "extractMaxChars": 8000,
        "sessionMemory": { "enabled": false }
      }
    }
  }
}

# 验证与重启
openclaw config validate
openclaw gateway restart
openclaw memory-pro stats
```

## 相关文档

- OpenClaw 集成手册：`memory-lancedb-pro/docs/openclaw-integration-playbook.md`
- 记忆架构分析：`memory-lancedb-pro/docs/memory_architecture_analysis.md`
- v1.1.0 变更与升级说明：`memory-lancedb-pro/docs/CHANGELOG-v1.1.0.md`
- 社区一键安装脚本：[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)
- 配套 Skill（供 Claude Code / OpenClaw 使用）：[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)

# CodeWikiHub

`CodeWikiHub/` 目录是一个独立的项目仓库。它的地址是：`git@github.com:HACK-WU/CodeWikiHub.git`

## 项目简介

**CodeWikiHub** 是一个用于**集中存放各种项目 Wiki 文档**的仓库。它把多个项目的知识库 / Wiki 文档聚合到同一个地方，便于统一检索与维护。

- 用途：存放各项目的 Wiki 文档（架构说明、接口、使用指南等），作为跨项目的文档中枢。
- 当前内容：`scripts/pre-commit/`（含 `check_commit_message.py` 提交信息检查、`check_sensitive.py` 敏感信息检查），用于在提交前做规范化与安全检查。

## 关键约定

- **独立 Git 仓库**：`CodeWikiHub/` 是独立 repo（远程 `origin` 为 `git@github.com:HACK-WU/CodeWikiHub.git`），与父仓库 `knowledge-indexer` 及 `memory-lancedb-pro` 互不相关，改动需进入该目录单独提交/推送。
- **提交前检查**：提交会经过 `scripts/pre-commit/` 下的脚本（提交信息格式校验、敏感信息扫描），请确保提交信息规范且不含敏感数据。
- **文档归档**：新增项目 Wiki 时，建议按项目分目录归档，保持与现有结构一致。

# 变更记录

## [需求] ki-search 混合检索体验优化（per-tag 限流 + relation content 纯化 + group 结构化字段） 2026-08-05

### 背景

- 需求 2.4「默认搜全部 tag」落地后暴露体验问题：ki-relation 辅助向量 content 混入 group 关键词/路径，BM25 命中面广虚高 → 霸屏主结果 + 误匹配

### 已实施

- [x] `src/search.ts`：默认不传 tags → `vectorListTags` + 按 tag 分查（每 tag 最多 limit 条）+ `TAG_PRIORITY` 排序（ki-search > ki-relation > ki-path > 自定义）
- [x] `src/lib/path-vectorize.ts`：`buildRelationContent` 只返回关系名（删 `| Group:`）；`buildGroupPathContent` 保留路径；`PathVectorizeEntry` 加 `group` 字段并透传
- [x] `src/lib/vector-client.ts`：schema 新增 `GROUP_FIELD` 标量字段（indexed）；`VectorSearchResult.group`；`vectorStore`/`vectorBulkStore` 支持 `group`
- [x] 调用方（rebuild-vector / import / incremental / sync-relation）：relation 向量条目传 `group` 字段
- [x] 测试更新（rebuild-vector relation 断言改为纯关系名 + group 字段）；lint 零错误
- [x] **schema 迁移**：zvec scalarFields 白名单，加字段需重建全库集合——已备份旧库（`~/.ki/vector.bak.20260805-2250`）→ 删集合 → restore monitor 重建（300 向量，新 schema）

### 关键认知

- zvec 集合 schema 是创建时白名单（无 alter/drop API），加字段 = 删 vectorDir 重建，**影响所有 scope 的向量数据**（需重新导入）
- `extractPathFromContent` 只取 `|` 前的内容，relation 的 `| Group:` 从未被消费，纯副作用（BM25 误匹配）→ 删除无回归
- MCP server 是懒加载（启动不 open 集合），`lsof` 无句柄即未持锁，CLI 重建可执行

## [Bug] 空向量库目录 probe 误判 locked，导致全部向量命令不可用 2026-08-05

### 现象

- `ki doc list` 报"向量库被其他进程占用（LOCKED）"，`ki mcp stop` 显示无实例可停；实际无任何进程持锁
- 根因：`ZVecEngine.probe` 对**空目录**执行 `ZVecOpen` 时原生挂起不返回，3s 超时误判 `locked:true`；`ensureVectorAvailable`/`getEngine` 对 `exists && locked` 直接判不可用，空库永远无法走 create 自愈

### 修复

- `src/zvec-engine/engine.ts` `probe`：空目录预检 → 直接返回 `NOT_FOUND`（实测从 5s 挂起误报 → 1ms NOT_FOUND）
- `src/lib/vector-client.ts` `getEngine`：create 前移除空目录（zvec create 要求 dbPath 不存在）
- `src/lib/vector-client.ts` `lockedHint`：文案补充"确认无进程仍报错→可 restore 重建"
- 新增 `test/zvec-engine.test.mjs` 空目录 probe 用例；zvec-engine 121/121、vector-cli 28/28 全绿
- 端到端验证：`ki doc list` 空库自动创建集合恢复可用

### 关键认知

- ki 的 mcp lock（`~/.ki/mcp-stdio.lock`/`mcp-http.lock`）与 zvec 向量库锁是**两套独立锁**，`mcp stop` 管不到向量库锁
- probe 超时判定 locked 无法区分"真持锁"与"目录存在但无集合"，已用空目录预检兜底

## [需求] search 输出原文定位字段（memoryId 反查） 2026-08-05

### 已完成

- [x] `ki search` 结果新增 `group` / `relation` / `sourcePath` 三字段（反查 relations-cache.json 定位原文）
- [x] 新建 `src/lib/relation-map.ts`：memoryId → `{group, relation, sourcePath}` 映射，TTL(10min) + 文件 mtime/size 双失效缓存
- [x] 新增 `test/relation-map.test.ts` 8 用例（构建/跳过/缺失/损坏/缓存命中/mtime失效/TTL过期/scope隔离）
- [x] `docs/cli.md` search 章节补充"原文定位字段"说明
- [x] 端到端验证：monitor scope 命中结果正确附带三字段

### 关键实现

- 缓存条目 `{ builtAt, mtimeMs, size, map }`；命中需 mtime+size 均未变且未超 TTL
- mtime 在毫秒精度下可能相同 → 叠加 size 校验兜底原地改写
- `SearchHit extends VectorSearchResult`（search.ts），下游 MCP/CLI 无破坏
- 文件缺失/损坏返回空 Map，search 降级为不带附加字段，不抛错

### 待办

- [ ] 与 search 输出增强相关的变更尚未提交 git（含 scope 字段 9 命令、scopeMode 修复等此前变更）

## [需求] search 加 isFullText + rebuild-vector 恢复路径信息 2026-08-05

### 已完成

- [x] `ki search` 结果新增 `isFullText` 字段：content 以 `[摘要]` 开头 = false（AI 摘要），否则 true（原文全文）
- [x] `rebuild-vector` 的 `collectContentEntries` 内容向量格式对齐 import 的 `buildVectorizeContent`：`[摘要] {描述}\n[关键词] {关系名}\n[路径] {sourcePath}`（sourcePath 缺失回退 groupPath）
- [x] 新增 `test/search-is-full-text.test.ts` 5 用例 + `test/rebuild-vector.test.ts` 更新至 15 用例
- [x] `docs/cli.md` search 章节补充 isFullText 与 content 格式说明

### 关键实现

- isFullText 判断契约：`isFullTextContent(content) = !content.startsWith('[摘要]')`
  - 摘要类写入方（scan-kb import 的 buildVectorizeContent、rebuild-vector 的 collectContentEntries）统一 `[摘要]` 前缀
  - 全文类（sync-relation 的 moduleInfo、ki store 用户输入）为原始文本
- 真相澄清：scan-kb import 的 `[路径]` 步骤从未删除（batch-vectorize.ts）；monitor 之前无路径是 rebuild-vector 重建时丢失（index.json 只存描述文本）
- 改动不涉及 zvec 向量层 schema（scalarFields 白名单迁移成本高），用 content 前缀契约实现
- 端到端验证：monitor 重建 300 向量，search content 带 `[摘要]/[关键词]/[路径]` + isFullText=false；ki store 数据 isFullText=true

### 已知风险（未解决）

- [ ] index.json 现在存文件全文（import.ts phase4 moduleInfo），若对全文类数据跑 rebuild-vector 会误标 `[摘要]`；monitor 的 index.json 是摘要风格（旧数据），当前不受影响

## [需求] ki-search 输出增强与全文标记（已实施） 2026-08-05

### 需求落盘

- 需求文档：`.requirements/2026-08-05-ki-search输出增强与全文标记/requirement.md`（含需求上下文、已确认方案、当前进度、文件路径清单）
- meta.json 索引已更新（REQ-20260805-001，status: 已确认）

### 已实施（2026-08-05）

- [x] `import-kb.ts` `upsertImportedRelation`：新建/更新打 `isFullText: true`
- [x] `batch-vectorize.ts`：`buildVectorizeContent` 只返回 `summary`（纯化）；`vectorizeOne`/`bulkVectorize` 经 `keywords` 参数传 vector-client
- [x] `rebuild-vector.ts`：`collectContentEntries` 回退纯值 `text=String(v)` + `keywords=[关系名]`，去掉 `[路径]` 与 relationsCache 参数
- [x] `relation-map.ts`：entry 改为 `{group, relation, keywords, isFullText}`（keywords 取 group 级、isFullText 从 rel 读）
- [x] `search.ts`：SearchHit 去 `sourcePath` 加 `keywords`；`isFullText` 仅 ki-search 计算（命中读标记缺失默认 false、未命中前缀推断兜底）；默认 tags 不传（搜全部）
- [x] `vector-client.ts`：`vectorSearch` tags 可选，不传/空 → 不按 tag 过滤（`buildScopeTagFilter`）；传值 → 多 tag OR
- [x] `mcp-tools/search.ts`：`ki_search` tags 默认值改不传（undefined）
- [x] 测试更新：relation-map（8）/ rebuild-vector（13）/ search-is-full-text（5）/ vector-cli-functions（28）/ import-kb（7）/ scan-kb（6）全绿
- [x] `docs/cli.md` search 章节：去 sourcePath、加 keywords、默认 tags 行为、content 纯化说明

### 已知风险（未解决）

- [ ] index.json 现在存文件全文（import.ts phase4 moduleInfo），若对全文类数据跑 rebuild-vector 重建的 content 与 `isFullText` 标记可能不一致（标记反映导入来源语义，rebuild 反映 index.json 现有内容，两者解耦，属已接受的 trade-off）
- [ ] 端到端待人工验证：monitor rebuild 后 search 输出含 `keywords`/`isFullText`、无 `sourcePath`；`ki store` 数据 `isFullText: true`；不传 `--tags` 返回混合 tag 结果