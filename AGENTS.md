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

- **测试基线**：全量测试全绿，lint 零错误
- **当前 HEAD**：方案 D（REQ-20260807-001）已提交（含 clean.ts 清洗、local KB 一对多、中断防护、原文召回）
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

### REQ-20260806-003 可视化前端界面（已完成）

- **前端工程（`web/`）**：React 18 + Vite + TanStack Query + MCP SDK（StreamableHTTPClientTransport 同源调 `/mcp`）；5 个页面：总览（F02）/浏览（F03，Group 树 + 文档列表 + 文件名模糊搜索 + 原文抽屉）/语义搜索（F04，`include_original: true` + threshold/tags）/上传导入（F05/F06，拖拽/目录 + 切分参数 + 向量化开关 + 进度轮询）/知识写入（F07，sync-relation + Group 树下拉 + Markdown 预览）
- **后端扩展（方案 A）**：`ki mcp --http --web` 一并提供前端静态页面（`web/dist`，SPA fallback + 路径穿越防护）；mcp-http 新增 `/api/health`、`/api/doc/list`（Group+文档+`q` 搜索）、`/api/import/upload|run|status` 路由
- **REQ-F09 已取消**：zvec-studio 占位跳转（前端侧边栏"向量可视化"外链）取消，不做（用户确认）
- **服务生命周期**：前端不启动/不关闭服务，仅检测 MCP HTTP 状态 + 手动指引；破坏性操作（F08）留 CLI
- **测试**：`mcp-http.test.ts` + `mcp-http-api.test.ts`；前端 `npm run build`（tsc + vite）通过
- **文档同步**：docs/mcp-http.md 补 `--web` + `/api/*` 路由章节；docs/cli.md mcp 参数表补 `--web`；README 补内置前端 + `--web` 启动说明

### REQ-20260806-001 外部Wiki直接导入与自动切分（已完成）

- **原文直导**：`scan-kb import --source <dir>` 无 AI 依赖；自动切分（chunkSize 默认 1000 / overlap 150，段落边界 `\n\n → \n → 。 → ；` 优先，relation 名 = `文件名-N`，sourcePath = `文件路径#N`）；超大文件上限 2MB + 单文件 chunk 上限 500
- **增量直连**：`--mode incremental --source <dir>` 内部 git diff 驱动（add→切分写入，modified→先写新全 chunk 成功后再删旧，deleted→按文件清全 chunk）；source 块切分参数为唯一权威；无 git 明确报错
- **删除清单**：ai-results 契约、keywords 全链路（含 sync-relation 词云、migrate-keywords）、isFullText 字段、scan 子命令、restore --from-results、import-kb、scan-kb vectorize、`bulk_store` → `bulk-store`（MCP 工具名 `ki_bulk_store` 不变）
- **文件↔chunk 映射**：`buildMemoryIdMap` 多值 `Map<文件path, memoryId[]>`（按 sourcePath `#` 前缀聚合），无新增数据文件
- 批次 0~5 + 技术设计遗留全部完成（P-5 干净、P-7 MAX_CHUNKS_PER_FILE=500、向量库重建验证闭环）；P-6（FTS 规模实测）可选未做
- **文档同步核对（2026-08-10）**：批次 5 的 16 docs + 5 skills 已同步，旧关键词命中均为"已删除说明标注"；发现并修复 `docs/error-handling.md` 残留——删除"四类：关键词相关问题"整节（REQ-05 已删 keywords）、修正 `mem delete` 命令引用（改为"增量删除失败"，`deleteMemory` 为内部函数）、config 路径 `~/.config/memory-mcp/config.yaml` → `~/.ki/config.yaml`；发现项：docs 多处写 `scopes.definitions.<scope>`，但源码为 `scopes.<scope>` 直接映射（历史遗留，未改，待确认）

### REQ-20260806-002 CLI命令迁移与规范化（已完成）

- CLI-01~04/06/07/08/10/11 落地（scope 统一 `resolveScope`、export `--yes`、restore `--list`、`--tags` 默认全部、数值参数文档化等）
- **CLI-05 决策**：维持现状不迁移 commander（手写解析已规范化：未知参数检测/统一错误契约/前置 -h；mcp 与 restore 迁移风险高收益低）；触发条件：新增第 6 个手写命令且复杂度上升，或 commander 能力成硬需求

### sync_relation 非向量化（已完成，未落盘 REQ 条目待补）

- 决策：非向量化时 memoryId 为空、不可被 `ki search` 召回（仅 query-group/get-module-info 可访问）、单条 + 批量均支持
- 实施：CLI `--no-vector` + MCP `vector: boolean`（默认 true）；批量模式本就不做向量写入（历史现状），`--no-vector` 仅显式声明
- 审查：无阻塞项；delete-relation 对非向量化关系提示易困惑（范围外，未改）

### REQ-20260807-001 向量库导入中断防护与自愈（已完成，方案 D）

- **数据模型（方案 D）**：local KB 存**文件级原文**（一个文件一条）+ relation-cache 文件级 relation 挂 **memoryIds 多值**；清洗只作用于向量化输入；原文召回命中任一 memoryId → 返回文件原文（去重）
- **数据清洗（REQ-06/07）**：`clean.ts` 7 条内置规则（BOM/frontmatter/mermaid/代码块先剥→路径/空行/空 chunk）+ `--no-clean`/`--clean-rules`；外部 hook 管道（stdin→stdout、10s 超时、P-7 失败回滚）
- **导入链路（REQ-05/08）**：格式白名单（config `import.extensions`）+ 大小限制（默认 1MB）；进度文件数分母 + 串行化 + batch-vectorize 分批 + TTY 降级；`--no-vector` 仅跳向量化
- **中断防护（REQ-01~04）**：SIGINT/SIGTERM 捕获写标记（SIGKILL 由 probe 兜底，双路径）+ 并发锁 + `bin/ki.mjs` 信号透传（spawn+转发）
- **原文召回（REQ-09，合并 REQ-002）**：`ki search` 默认不返回原文（仅向量匹配数据；CLI `--original` / MCP `include_original` 显式开启）+ 去重；originalHint 降级
- **关键踩坑**：① full 重导幂等（冲突检测按 sourcePath 区分同文件重导 vs 真冲突）；② `bin/ki.mjs` 必须 spawn+信号转发否则中断标记失效
- 需求文档 v9 + 实现计划 v7；测试：5 个单测 + 1 个 e2e + 真实 Wiki 体验；`scope list` 表格化 + Docs 列

### 其他已完成（2026-08-05/06）

- **ki-search 混合检索优化**：默认搜全部 tag + per-tag 限流 + `TAG_PRIORITY` 排序（ki-search > ki-relation > ki-path > 自定义）+ relation content 纯化 + `group` 结构化字段（`GROUP_FIELD` 标量）
- **空库 probe bug**：`ZVecEngine.probe` 空目录预检 → `NOT_FOUND`（原挂起 3s 误判 locked），create 前移除空目录
- **GitNexus 索引**：根目录 `.gitnexusignore` + 取反强制索引 `!test/`、`!test/fixtures/`、`!bin/`

## 当前需求（进行中）

（暂无——REQ-20260807-001 方案 D 已完成提交）

## 相关资产

- `.module-experts/`：PROJECT.md + INDEX.md + 6 个业务专家（存储配置/MCP 服务/向量引擎/检索客户端/知识导入/关系索引），expert-audit 验收未执行
- zvec 官方 AI 向导文档：<https://zvec.org/llms.txt>
- GitNexus：可用 `context`/`impact`/`query`/`cypher` 查询调用链

---
代码编写过程中，涉及到临时文件时，存放在当前工作区的.temp 目录下，只做新增操作操作。不做删除操作。

---
执行终端命令时，如果时具备一定时长的命令，比如10秒以上时，需要添加time out 命令前缀，避免进程挂住无法退出。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **kisearch** (2977 symbols, 6549 relationships, 250 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/kisearch/context` | Codebase overview, check index freshness |
| `gitnexus://repo/kisearch/clusters` | All functional areas |
| `gitnexus://repo/kisearch/processes` | All execution flows |
| `gitnexus://repo/kisearch/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
