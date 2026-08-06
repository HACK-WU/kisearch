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

# zvec-studio

`zvec-studio/` 目录是一个独立的项目，**在这里仅作为参考使用**（不参与本仓库的构建/提交）。

## 项目简介

**zvec-studio** 是 [Zvec](https://github.com/alibaba/zvec) 向量数据库的**可视化管理工具**：不用写代码，直接浏览数据、测试查询、管理 Schema。

- 形态：pip 安装的 Web 工具（`zvec-studio`，默认 7860 端口）+ 实验性桌面应用。
- 仓库结构（pnpm workspace monorepo）：
  - `apps/backend/`：Python 后端（uv 管理，包名 `zvec_studio`），提供 REST API（FastAPI，OpenAPI 文档在 `/api/v1/openapi.json`）
  - `apps/frontend/`：React + Vite 前端（见下方技术栈）
  - `apps/desktop/`：Rust 桌面应用
  - `packages/api-client/`：前端 API client 包（由 `openapi-typescript` 从后端 OpenAPI 生成）

## 前端技术栈（apps/frontend，主要参考对象）

- React 18 + TypeScript + Vite 5
- React Router v7 + TanStack Query + i18next（i18n）
- API client 由 `openapi-typescript` 从后端 OpenAPI 自动生成（`gen:api` 脚本）
- 目录组织：`pages/`（页面）、`components/`（组件）、`features/`（业务逻辑）、`lib/`（工具）、`layouts/`、`router/`、`styles/`
- 测试：vitest + Testing Library + msw（API mock）+ Playwright（e2e）

## 后续计划（对本仓库的意义）

为当前项目（ki，knowledge-indexer）实现一个**可视化界面**，参考 zvec-studio 的前端实现：

- [ ] 文档数据查看页面：浏览已索引的文档/向量数据（对应 ki 的 scope、doc、search 能力）
- [ ] 上传文档页面：将文档导入知识库（对应 ki 的 import / scan-kb 能力）

实现时可参考 zvec-studio 的前端架构（pages/components/features 分层、TanStack Query 数据获取、openapi-typescript 生成类型安全 client）。

# 变更记录

## [记录] 建立 GitNexus 代码索引 + .gitnexusignore 2026-08-06

### 已完成

- [x] 新建根目录 `.gitnexusignore`（语法同 .gitignore，last-match-wins），忽略：node_modules/dist/kb/ki-backup/.idea/.e2e-run/.codebuddy/.workbuddy/.requirements/.module-experts、独立子项目（zvec-studio、zvec-probe、zvec-probe-node、zvec-mcp-server、CodeWikiHub、memory-lancedb-pro）、测试运行数据（test_data、test_wiki）
- [x] 取反强制索引：`!test/`、`!test/fixtures/`、`!bin/`（gitnexus 默认硬编码忽略 `fixtures`/`bin`，需显式取反，见 ignore-service.js DEFAULT_IGNORE_LIST）
- [x] `gitnexus analyze --skip-agents-md` 索引完成：2,719 nodes / 6,046 edges / 122 clusters / 230 flows
- [x] 验证：test/ 537 节点、src/ 1070 节点、bin/ki.mjs 15 节点、test/fixtures 74 节点；被忽略目录 0 节点
- [x] 跳过 2 个大文件（>512KB）：`test/zvec-lock-demo/data/0/emb.index.1.proxima` 等（zvec 测试数据）

### 环境踩坑（重要）

- 系统 PATH 中的 `gitnexus` 指向 Windows 侧安装（`/mnt/c/nvm4w/nodejs/gitnexus`），其原生模块（`@ladybugdb/core/lbugjs.node`）是 Windows 编译的，在 WSL 下报 `invalid ELF header`
- **WSL 下必须用完整路径**：`/root/.nvm/versions/node/v22.22.2/bin/gitnexus`（WSL 侧已 `npm i -g gitnexus`）
- 安装时 onnxruntime-node 二进制下载失败（微软 CDN 不通），用 `--ignore-scripts` 安装后需手动补 ladybugdb 二进制：`node .../node_modules/@ladybugdb/core/install.js`
- FTS 扩展 load-only（未预装），`--embeddings` 语义搜索不可用；基本索引/图检索正常
- 索引用 `--skip-agents-md` 防止 gitnexus 改写 AGENTS.md

## [记录] AGENTS.md 新增 zvec-studio 参考项目说明 2026-08-06

- 记录 zvec-studio 为独立参考项目（Zvec 向量数据库可视化管理工具，monorepo：Python FastAPI 后端 + React/Vite 前端 + Rust 桌面端 + api-client 包）
- 明确后续计划：为 ki 实现可视化界面（文档数据查看页 + 上传文档页），前端参考 zvec-studio 的 pages/components/features 分层、TanStack Query、openapi-typescript 生成 client

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

---

## [需求] 外部Wiki直接导入与自动切分（实施中，批次 3~5 未完成） 2026-08-06

### 需求落盘

- 需求文档：`.requirements/2026-08-06-外部Wiki直接导入与自动切分/requirement.md`（REQ-20260806-001，状态：实施中，v15，15 条需求 REQ-01~15 + 26 项假设 H-01~H-26）
- CLI 迁移独立需求：`.requirements/2026-08-06-CLI命令迁移与规范化/requirement.md`（REQ-20260806-002，已确认，承接范围 A/B 之外的 11 项优化点 CLI-01~11）
- 数据流设计：`design/data-flow.md`（已通过 design-review + challenger 质疑 + scenario-rehearsal，9 项评审问题 + 6 项质疑意见 + 4 项推演问题均已修复）
- 实现计划：`design/implementation-plan.md`（6 批：基线/切分直导/增量/删除/CLI/配套）
- 评审与推演报告：`design/design-review.md`、`review/challenge-report.md`、`review/scenario-rehearsal.md`

### 需求核心决策（已确认）

- **原文直导**：`scan-kb import --source <dir>` 无 AI 依赖直接导入 Markdown 目录，`--results`（ai-results 存量路径）与 `--source` 二选一
- **自动切分**：内存执行（无独立命令），固定长度（默认 1000 字符）+ 段落边界优先（`\n\n → \n → 。 → ；`），overlap 150；relation 名 = `文件名-N`（deploy-01）；sourcePath = `文件路径#N`（文件级 diff 前缀聚合键）
- **增量直连**：`--mode incremental --source <dir>` 内部 git diff 驱动（复用 handleDiff），无 AI；add→切分写入，modified→先写新全 chunk 成功后再删旧，deleted→按文件清全 chunk；source 块切分参数为唯一权威（D-8），无 git 明确报错（D-9/H-25）
- **删除清单**：ai-results 导入、keywords 全链路（含 sync-relation 词云、migrate-keywords 命令、export/wiki frontmatter）、isFullText 字段、scan 子命令、restore --from-results、import-kb（@deprecated）、scan-kb vectorize、bulk_store → bulk-store 改名（MCP 工具名 ki_bulk_store 不变，数据结构同步）
- **文件↔chunk 映射方案②**：`buildMemoryIdMap` 改多值 `Map<文件path, memoryId[]>`，遍历 relations-cache 按 sourcePath `#` 前缀聚合，无新增数据文件；每次增量现场重建（质疑意见1 修复）
- 其他：切分参数持久化 source 块（H-18）、全量直导写入 scope sourceDir 绝对路径（H-20/setScopeSourceDir）、进度跳过文件级最小粒度、超大文件上限（2MB）+ 单文件 chunk 上限（500）、docs/skills 拆独立任务（REQ-14）、test 纳入本次（REQ-15）

### 已实施（批次 0~2）

- [x] **批次 1（切分器 + 直导核心）**：
  - `src/lib/chunker.ts`（新建）：`splitIntoChunks` 递归字符切分，overlap 逻辑修复（`nextStart = max(pos+1, cut-overlap)` 保证推进）；`test/chunker.test.ts` 9 用例全绿
  - `src/lib/import.ts`：`handleDirectImport`（复用 5-Phase 后半段）+ `HandleDirectImportArgs` + `collectMarkdownFiles`（递归、跳过隐藏/node_modules）+ `deriveChunkRelation`/`deriveChunkSourcePath`/`readFileToChunks`（已导出）
  - `src/lib/ai-results.ts`：`deriveGroupPath` 导出 + `ScanResultEntry.chunkRelation` 字段
  - `src/lib/scope.ts`：`GroupIndexSource` 加 `chunkSize/chunkOverlap`；`setSource` 允许 commit 为空（直导非 git 场景）
  - `src/lib/config.ts`：`setScopeSourceDir`（YAML 用 parseDocument 保留注释/JSON 回写，仅未配置时写入，写回后 resetConfigCache）
  - `src/scan-kb.ts`：`import` 子命令 `--results`/`--source` 二选一 + `--chunk-size/--chunk-overlap` 参数
- [x] **批次 2（增量直连）**：
  - `src/lib/diff.ts`：`DiffEntry` 加 `memoryIds`；`buildMemoryIdMap` 改多值映射（按 `#` 前缀聚合到文件级 key，兼容无 `#` 旧数据）
  - `src/lib/incremental.ts`：`handleIncrementalDirect`（4-Phase：校验 source 块→deleted 清理→add/modify 向量化→持久化+更新 commit）+ `chunkifyFile`；modified 删旧对齐 deleted 分支（清 relations-cache/local KB/路径向量，修复 deploy-02~08 残留 bug）
  - `src/scan-kb.ts`：`--source` + `--mode incremental` 走 handleIncrementalDirect

### 端到端验证结果（wiki-test scope，`/root/.ki-data/wiki-test/`）

- [x] 全量直导：deploy.md 14.7KB → 10 chunks（deploy-01..10），relation 命名/sourcePath/source 块持久化/keywords 未写入/memoryId 关联全部正确
- [x] 检索：`ki search --scope wiki-test --query "告警收敛"` alarm-01 命中第一（注意：`npx jiti src/search.ts --query ...` 直接运行，不带 `search` 子命令参数）
- [x] 增量 add（new.md）+ delete（alarm.md）：add=1/delete=1/errors=0，commit 8713b8ee→4bbfcd93，alarm-01 消失、new-01 添加、deploy chunks 保留
- [x] 增量 modified（deploy 8 chunks→1 chunk）：删旧修复后 KB 层正确
- [ ] 路径向量（ki-path/ki-relation）写入验证未闭环——**受向量库锁异常阻塞**（见下方阻塞点）

### 阻塞点（重要）

- **向量库锁异常**：调试路径向量时误删 RocksDB LOCK 文件导致集合半损坏，`ZVecOpen` 挂起不返回（引擎已知行为，probe 超时误判 locked）。已 pkill 挂起进程恢复现场，向量库未删除（mv 未执行）。**后续所有涉及向量写入的命令必须用 `timeout 60` 包裹，禁止无超时执行**（AGENTS.md 底部已加此约定）
- 陈旧锁处理记录：`/root/.ki/vector/LOCK`（零字节）与 `fts.2.rocksdb/LOCK`、`scalar.index.1.rocksdb/LOCK` 等 RocksDB 锁经 flock 测试均可获取（非真持锁），但 zvec probe 对锁文件存在即判 locked

### 待办（批次 3~5，需求清单一半未实现）

- [ ] **批次 3（删除旧链路 REQ-04/05/09/13）**：删除 ai-results 导入契约、keywords 全链路（sync-relation/query-group/migrate-keywords/export/wiki frontmatter）、isFullText（import.ts:226/incremental.ts:161 唯一 false 来源）、scan 子命令（含 scan-pending/scan-index）、restore --from-results、import-kb、vectorize；bulk_store → bulk-store 改名（MCP ki_bulk_store 名不变）
- [ ] **批次 4（CLI 简化 REQ-10/11/12）**：短别名（-s/-q/-t/-g/-r/-i/-o）、位置参数（`ki search "sas"`）、sync_relation 超长 module-info 警告（>1000 字符）
- [ ] **批次 5（配套 REQ-14/15）**：docs 17 个 + skills 5 个文档同步（拆独立任务）；test 30+ 文件重构 + 删除 ai-results fixtures
- [ ] 技术设计遗留：P-5（grep 清点 `scan-index|getScanIndexPath` 消费方）、P-6（FTS 规模量化实测）、P-7（超大文件上限数值确认：2MB / 500 chunk）
- [ ] **重建向量库后补验路径向量**：备份 + 删除 `/root/.ki/vector` 让引擎 create 自愈，重跑直导 + 增量全链路（用 timeout 包裹）

### 相关资产

- `.module-experts/`：PROJECT.md + INDEX.md + 6 个业务专家（存储配置/MCP 服务/向量引擎/检索客户端/知识导入/关系索引）已创建完成，expert-audit 验收未执行
- zvec 官方 AI 向导文档：<https://zvec.org/llms.txt>（已记录到 PROJECT.md）
- GitNexus 已配置：`gitnexus analyze` 索引 2719 symbols / 230 flows，可用 `context`/`impact`/`query` 查询调用链

---
执行cli  测试时，必须设置超时时间，防止一直被挂着。无法退出。