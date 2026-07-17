# 基准实证：zvec vs memory-lancedb-pro（KiSearch 引擎选型）

- 关联需求：REQ-20260717-001
- 日期：2026-07-17
- 目的：在**公平条件**（同一 embedding、同一语料、同一向量空间）下，对比候选引擎 `zvec` 与现役引擎 `memory-lancedb-pro`(`mem`) 的检索质量与延迟，为换引擎决策提供量化依据。

## 1. 实验设置

| 项 | 值 |
|---|---|
| 候选引擎 | `zvec`（Python PoC 验证；Node 绑定 `@zvec/zvec` 同 Rust core） |
| 基线引擎 | `memory-lancedb-pro` 的 `mem` CLI（lancedb + SiliconFlow embedder） |
| Embedding | `Qwen/Qwen3-Embedding-8B`，SiliconFlow，4096 维 |
| 语料 | 40 篇 bk-monitor wiki（`/root/bk-monitor/ai-docs/**/*.md`，每篇截断 6000 字，中文） |
| 评测方式 | self-retrieval：用每篇标题/首句作为查询，验证能否召回自身（DOCID 命中） |
| 融合方式 | zvec：稠密向量 + BM25(FTS) + RRF 融合（Python PoC 手动实现）；mem：vector 0.7 + BM25 0.3 加权融合 |
| 阈值 | 对比时为隔离排序质量，mem 侧 `hardMinScore`/`minScore` 均降到 0、关闭 `filterNoise` |

## 2. 结果

| 指标 | zvec | memory-lancedb-pro (`mem`) |
|---|---|---|
| 建库（创建+嵌+插+opt） | **8.3 s** | 24.5 s |
| 冷启动 reopen | **49.9 ms** | —（CLI 每次冷起） |
| 查询 首条 | **3.6 ms** | 4.25 s |
| 查询 平均 | **0.8 ms** | 4.08 s |
| Recall@1 | **85.0%** | 12.5% |
| Recall@3 | **92.5%** | 65.0% |
| Recall@5 | **95.0%** | 82.5% |

## 3. 解读

1. **召回质量 zvec 全面占优**，尤其 @1（85% vs 12.5%）。mem 侧能找回原文（@5 达 82.5%）但**排名靠后**——短标题查询对 6000 字长文档的向量相似度被稀释，加权融合把相似文档顶到前面；zvec 的 RRF 排名更稳。
2. **延迟差距悬殊（~5000×）**：zvec 进程内查询 <1ms；`mem search` 单次 **4s**，主因是每次冷启动 node + 打开 lancedb + 调 SiliconFlow 嵌入。这正是"一次性 `ki search` CLI"的致命体验，也是用户最初抱怨 lancedb 锁/spawn 卡顿的同一种痛。
3. **建库 zvec 快 ~3×**（8.3s vs 24.5s）。

## 4. 评测踩坑（务必规避，否则基线会显示虚假 0%）

> 以下坑**仅影响基线侧（mem）评测**，与 zvec 无关；记录于此以免重蹈覆辙。

| 坑 | 现象 | 根因 | 修复 |
|---|---|---|---|
| `mem bulk-store` 缺 `scopes.default` | 跑 128s 却存 0 条 | 无法解析目标 scope，静默放弃 | 配置补 `scopes.default: global` + `scopes.definitions.global` |
| SiliconFlow API 偶发抖动 | `bulk-store` 整批静默存 0 | 单条 embedding 失败导致整批放弃 | 入库加重试 + `mem stats` 计数校验，达标才结束 |
| `mem search` 配置参数 | 用 `-c` 返回空 | search 只认 `--config` 不认 `-c`（bulk-store 认 `-c`） | search 改用 `--config` |
| 检索阈值 `hardMinScore:0.35` | 长文档短查询被过滤成 0 | 长文档标题查询相似度低于硬阈值 | 对比时降到 0 隔离排序质量 |

修复后基线检索完全正常（手动验证 d000/d009/d076 等 ground truth 均命中），上述 0% 均为评测脚本问题而非引擎问题。

## 5. 局限

- 语料为**中文 wiki**，BM25 对中文分词不友好，两引擎 FTS 几乎无贡献（都靠向量）。**代码搜索场景（英文符号/函数名）BM25 才是主力**——那正是 zvec 的 FTS+RRF 强项（首轮 `syncRelation` 精确命中 demo 已验证），差距可能更大。
- N=40 规模偏小，结论偏方向性。
- `mem` 的 4s 主要是 CLI 冷启动；若作为常驻 MCP（其本来形态）单次会快，但那就回到"非一次性、依赖运行时"——与"摆脱 lancedb 包装层、常驻复用"的诉求一致，故本需求选择 zvec + 常驻 MCP。
- 基准用 zvec **Python** PoC；Node 绑定为同 Rust core，性能应一致，需 Node 侧重跑确认（见 REQ-20260717-001 REQ-07）。

## 6. 复现脚本

> 已随需求归档至 `reference/scripts/`（下方相对路径均相对本需求目录）。

- zvec 验证 Demo：`reference/scripts/zvec_demo.py`
- 对比脚本：`reference/scripts/compare.py`（生成 bulk JSON：`reference/scripts/gen_bulk.py`；mem 对比配置：`reference/scripts/memcmp-config.yaml`）
- 运行：`python3 reference/scripts/compare.py`（注意 SiliconFlow 偶发抖动，基线侧已加重试）
- 原位置（未删除，供对照）：`zvec-probe/` 同名文件
