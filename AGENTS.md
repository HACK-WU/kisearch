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

## 项目现状速览

- **测试基线**：全量测试全绿（340/340），lint 零错误
- **当前 HEAD**：`204c1da`（feat(scan-kb): import 支持 --no-vector + 文档同步 + REQ-20260807-001 落盘）
- **GitNexus 索引**：2,719 symbols / 6,046 edges / 122 clusters / 230 flows（`.gitnexusignore` 已配；WSL 下必须用完整路径 `/root/.nvm/versions/node/v22.22.2/bin/gitnexus`，索引用 `--skip-agents-md` 防止改写本文件）
- **需求归档**：`.requirements/` 按 `YYYY-MM-DD-需求名/requirement.md` + `meta.json` 索引（REQ-ID 由 `req create` 分配）

## 关键认知（踩坑备忘）

- **zvec schema 白名单**：集合 schema 是创建时白名单（无 alter/drop API），加字段 = 删 vectorDir 重建，**影响所有 scope 的向量数据**（需重新导入）
- **两套独立锁**：ki 的 mcp lock（`~/.ki/mcp-stdio.lock`）与 zvec 向量库锁互不相干，`mcp stop` 管不到向量库锁；probe 超时判定 locked 无法区分"真持锁"与"空目录"，已用空目录预检兜底
- **zvec 写入非原子**：segment 文件与 idmap 分离写入，导入中断必然留 crash residue；**只读 probe 也会触发 recovery**（`engine.ts:171`）；zvec 原生日志无法低成本拦截（worker_threads 直写 stderr），ki 侧只能做"检测-提示-自愈"闭环
- **向量库损坏/残留恢复**：`ki restore <scope> --from-snapshot --rebuild-vector` 或 `rebuild-vector` 全量重建
- **环境约定**：执行 CLI 测试必须设置超时时间，防止进程挂住无法退出（涉及向量写入命令用 `timeout 60` 包裹；历史 macOS 环境用 `perl -e 'alarm N; exec @ARGV'`）
- **jiti 缓存**：修改 `.ts` 源码后，测试/运行前可能需要清 `/tmp/jiti/`（memory-lancedb-pro 插件场景）

## 近期需求（已完成）

### REQ-20260806-001 外部Wiki直接导入与自动切分（已完成）

- **原文直导**：`scan-kb import --source <dir>` 无 AI 依赖；自动切分（chunkSize 默认 1000 / overlap 150，段落边界 `\n\n → \n → 。 → ；` 优先，relation 名 = `文件名-N`，sourcePath = `文件路径#N`）；超大文件上限 2MB + 单文件 chunk 上限 500
- **增量直连**：`--mode incremental --source <dir>` 内部 git diff 驱动（add→切分写入，modified→先写新全 chunk 成功后再删旧，deleted→按文件清全 chunk）；source 块切分参数为唯一权威；无 git 明确报错
- **删除清单**：ai-results 契约、keywords 全链路（含 sync-relation 词云、migrate-keywords）、isFullText 字段、scan 子命令、restore --from-results、import-kb、scan-kb vectorize、`bulk_store` → `bulk-store`（MCP 工具名 `ki_bulk_store` 不变）
- **文件↔chunk 映射**：`buildMemoryIdMap` 多值 `Map<文件path, memoryId[]>`（按 sourcePath `#` 前缀聚合），无新增数据文件
- 批次 0~5 + 技术设计遗留全部完成（P-5 干净、P-7 MAX_CHUNKS_PER_FILE=500、向量库重建验证闭环）；P-6（FTS 规模实测）可选未做

### REQ-20260806-002 CLI命令迁移与规范化（已完成）

- CLI-01~04/06/07/08/10/11 落地（scope 统一 `resolveScope`、export `--yes`、restore `--list`、`--tags` 默认全部、数值参数文档化等）
- **CLI-05 决策**：维持现状不迁移 commander（手写解析已规范化：未知参数检测/统一错误契约/前置 -h；mcp 与 restore 迁移风险高收益低）；触发条件：新增第 6 个手写命令且复杂度上升，或 commander 能力成硬需求

### sync_relation 非向量化（已完成，未落盘 REQ 条目待补）

- 决策：非向量化时 memoryId 为空、不可被 `ki search` 召回（仅 query-group/get-module-info 可访问）、单条 + 批量均支持
- 实施：CLI `--no-vector` + MCP `vector: boolean`（默认 true）；批量模式本就不做向量写入（历史现状），`--no-vector` 仅显式声明
- 审查：无阻塞项；delete-relation 对非向量化关系提示易困惑（范围外，未改）

### 其他已完成（2026-08-05/06）

- **ki-search 混合检索优化**：默认搜全部 tag + per-tag 限流 + `TAG_PRIORITY` 排序（ki-search > ki-relation > ki-path > 自定义）+ relation content 纯化 + `group` 结构化字段（`GROUP_FIELD` 标量）
- **空库 probe bug**：`ZVecEngine.probe` 空目录预检 → `NOT_FOUND`（原挂起 3s 误判 locked），create 前移除空目录
- **GitNexus 索引**：根目录 `.gitnexusignore` + 取反强制索引 `!test/`、`!test/fixtures/`、`!bin/`

## 当前需求（进行中）

### REQ-20260807-001 向量库导入中断防护与自愈（草案，待确认）

- **背景**：导入中断 → zvec crash residue + probe 只读 recovery 冲突（idmap put 失败 ERROR 刷屏）+ 被中断批次"索引已重建、idmap 未登记"的数据完整性风险
- REQ-01 导入中断安全收尾：`scan-kb import` 捕获 SIGINT/SIGTERM，写"导入中断"状态标记 + 明确提示
- REQ-02 中断标记检测与恢复引导：`getEngine` 前置检测中断标记 + probe 异常 → 引导 `rebuild-vector` / `restore --rebuild-vector`
- REQ-03 probe 异常提示增强：`lockedHint` 补"崩溃残留可重建"恢复引导
- REQ-04 中断恢复测试：kill -9 模拟中断 → 引导提示 + 重建后召回完整
- REQ-05 导入进度可观测性（O-01 切分进度分母 / O-02 并行进度条冲突 / O-03 向量化分批进度 / O-05 非 TTY 降级）
- REQ-06 向量化前数据清洗（O-04：剥离 BOM/frontmatter、过滤空 chunk、空白规范化，`--no-clean` 逃生阀，默认开启）
  - **推演结论（2026-08-07，基于源码核实；用户澄清确认方案 C）**：🔴 阻断 B1——调研文档 §5 建议"清洗落点在 readFileToChunks 内"**错误**：该落点使 chunk.text 被清洗，而 chunk.text 同时流向 local KB（`phase4WriteRelations` import.ts:479-486 因 `e.path` 含 `#N` 降级用 `e.text`=chunk.text）→ local KB 失原文 → 破坏 REQ-002 原文召回。**采纳方案 C**（用户原则：local KB 存原内容，清洗后数据只去向量化）：`readFileToChunks` 不内嵌清洗返回原文 chunk，清洗移到向量化前（`bulkVectorize` 入口 `entries.map` 清洗）。方案 A（phase4 读全文）弃用（致 local KB 膨胀+语义错配）。另补：cleanMarkdownText 异常兜底、frontmatter 闭合 `---` 行尾校验、URL 路径前置排除。报告：`review/scenario-rehearsal.md` + `review/challenge-report.md`
- REQ-07 自定义数据清洗钩子（config `scopes.<scope>.clean.hooks` 注入外部清洗脚本，stdin→stdout 管道，内置规则+钩子按序执行，超时 10s 容错，`--clean-rules` 覆盖规则开关）
- 需求文档：`.requirements/2026-08-07-向量库导入中断防护与自愈/requirement.md`（v3）
- 调研文档：`.requirements/2026-08-07-向量库导入中断防护与自愈/reference/code-survey.md`（清洗方案：零依赖纯 Node 正则 + NFC；落点 readFileToChunks）

### REQ-20260807-002 ki-search 返回原文支持（草案，待确认）

- 背景：数据清洗（REQ-06）使向量 content 非原文；search 需支持返回 local KB 原文
- 方案：`ki_search` 新增 `include_original`（默认 true）/ CLI `--include-original`/`--no-original`；复用 `executeGetModuleInfo({scope,group,relation})` 取原文，按 group 聚合读 index.json
- 降级：获取失败（group/relation 缺失、文件缺失）→ 返回原 search 信息 + `originalRetrieved:false` + **`originalHint` 失败提示**（无定位信息 / 本地 KB 缺失含 sync-relation、rebuild-vector 恢复引导 / 异常原因），不抛错
- 需求文档：`.requirements/2026-08-07-ki-search返回原文支持/requirement.md`（REQ-01~05）

### scan-kb import --no-vector 非向量化（已完成，未落盘 REQ 条目）

- CLI `--no-vector`（full/incremental 均支持），仅写 KB 层、memoryId 为空、不可被 `ki search` 召回（对齐 sync-relation 决策）
- 实施：`import.ts`/`incremental.ts` 加 `vector` 参数（跳过向量写入与向量删除）；`ImportStats`/`IncrementalStats` 加 `vector` 字段
- 验证：full 端到端 `vectorized=0` + `vector/` 目录完全不创建 + KB 层正常；incremental-direct 3/3 全绿
- 边界：非向量化增量时旧向量不删（混用向量/非向量模式属边界场景，文档已标注）

## 相关资产

- `.module-experts/`：PROJECT.md + INDEX.md + 6 个业务专家（存储配置/MCP 服务/向量引擎/检索客户端/知识导入/关系索引），expert-audit 验收未执行
- zvec 官方 AI 向导文档：<https://zvec.org/llms.txt>
- GitNexus：可用 `context`/`impact`/`query`/`cypher` 查询调用链

---
代码编写过程中，涉及到临时文件时，存放在当前工作区的.temp 目录下，只做新增操作操作。不做删除操作。

---
执行终端命令时，如果时具备一定时长的命令，比如10秒以上时，需要添加time out 命令前缀，避免进程挂住无法退出。
