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