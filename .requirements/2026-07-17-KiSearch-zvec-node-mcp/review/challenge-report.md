# 🎯 设计质疑报告：ZvecEngine 基座模块（zvec-base-module.md）

> 变更类型：**新增功能（设计阶段）**
> 审查对象：`zvec-base-module.md`（REQ-20260717-002，基座模块设计）
> 关联需求：REQ-20260717-001
> 审查依据：`requirement.md` / `decision.md` / `reference/docs/zvec-mcp-server-tools.md` / `dependencies/zvec.md` / `reference/scripts/compare.py` / `reference/benchmark-zvec-vs-mem.md`
> 审查日期：2026-07-17
> 审查者：challenger（代码质疑者，二次审查）

---

## 📋 设计断言 vs 实测事实核对（替代"复现流程确认"）

设计文档通篇以"已验证""实测""已确认"为前提展开，本审查首先核对设计断言与既有实测事实的一致性，发现 **6 处关键不一致**，是后续质疑的事实基础。

| # | 设计断言（zvec-base-module.md） | 既有实测事实（其他文档） | 一致性 |
|---|---|---|---|
| F1 | `dimension: number` "须与 embedding 模型一致"，**未给具体值** | requirement.md L99/L141 + decision.md L32 + compare.py L41 + benchmark L13：基准实测用 **4096 维**；zvec-mcp-server-tools.md L389/L445：**同环境同模型用 1024 维稳妥，8 维报 400** | ❌ 维度决策缺失 |
| F2 | §6 称"Node 原生 FTS+混合检索已验证" | zvec.md L99/L116：`multiQuerySync` 已验证；但 FTS 分词器（standard/whitespace/jieba）在设计中**完全未暴露** | ⚠️ 验证不含配置项 |
| F3 | §4.4 `Hit` 只含 `id/score/queryType/fields` | zvec-mcp-server-tools.md L271：`fetch_documents` 可取"完整文档（含向量与标量字段）"；requirement.md 场景4"返回结构化结果" | ❌ 缺原文返回 |
| F4 | §4.6 `EmbeddingProvider.embed(texts): number[][]`（**同步**签名） | SiliconFlow 是 HTTP API，Node 侧必须异步；compare.py 走 requests 同步是 Python 特性 | ❌ 签名不可实现 |
| F5 | §4.5 "score 方向随 queryType 变化，调用方须按类型解读" | zvec-mcp-server-tools.md L444 坑1明确："score 是距离不是相似度，COSINE 下越小越相似"——**已知陷阱** | ⚠️ 已识别但未消解 |
| F6 | §0 决策"单集合句柄，scope 用 metadata 过滤隔离" | requirement.md H-02："zvec db 文件在构建/服务间共享的并发语义"——**未验证假设**；decision.md L75："由常驻 MCP server 统一持有 db，CLI 写入走 MCP 或独占模式"——基座模块设计**未体现此策略** | ❌ 架构空白 |

**确认状态**：✅ 已核对（基于现有文档交叉验证，无需用户复现）

---

## 📊 变更概述

- **变更类型**：新增功能（设计文档）
- **变更描述**：在 `@zvec/zvec` Rust 绑定之上设计一层 `ZvecEngine` 引擎抽象层，封装集合生命周期、文档 CRUD、向量/FTS/混合检索、metadata 过滤、索引管理、embedding 提供方抽象，供 KiSearch 上层（MCP server / CLI）调用。
- **变更文件**：`zvec-base-module.md`（设计稿，尚未落代码）
- **变更目的**：实现 requirement.md REQ-01（引擎层封装）+ REQ-04（原生混合检索），为 REQ-02/05/06 等上层需求提供基座。

---

## 🔍 质疑详情

### 质疑 #1：embedding 维度决策缺失，4096 vs 1026 未闭环（🔴 高风险）

- 🏷️ **类型**：需求覆盖 / 隐性需求遗漏
- 📍 **涉及**：`zvec-base-module.md` §4.1 `ZvecEngineConfig.dimension: number` + §6 "实测依据"
- ❓ **质疑点**：设计把 `dimension` 当成"调用方传什么就用什么"的透传字段，但整个需求体系内存在两个互相矛盾的实测维度值：
  - **4096 维**（requirement.md L99/L141、decision.md L32、compare.py L41 `EMBED_DIMS=4096`、benchmark L13、memcmp-config.yaml L12）：基准实测 Recall@1=85% / Recall@5=95% / 查询 0.8ms 的全部数据均基于此维度。
  - **1024 维**（zvec-mcp-server-tools.md L389/L433/L438/L445）："本环境模型 `Qwen/Qwen3-Embedding-8B` 用 1024 稳妥"，8 维触发 `400 code=20015`。
  
  两份实测都在"同一环境（SiliconFlow + Qwen3-Embedding-8B）"下进行，却选了不同维度。基座模块设计**既未引用基准的 4096，也未采纳 MCP 实测的 1024，更没有给出选择规则**。
- 🔍 **验证方法**：
  1. 用 4096 维建集合 → 跑 self-retrieval 基准，看 Recall@1 是否仍为 85%（基准的可复现性）。
  2. 用 1024 维建集合 → 跑同一基准，看 Recall 是否退化（高维→低维通常召回下降）。
  3. 核对 SiliconFlow `Qwen3-Embedding-8B` 的官方维度支持区间，确认 4096 与 1024 均合法。
- ⚠️ **风险**：
  - 若沿用基准的 4096 维但实际 SiliconFlow 不再支持 → 建库直接 400，REQ-07 验收无法进行。
  - 若改用 1024 维，基准的 Recall@1 85% 不可复现 → REQ-07"输出对比报告，zvec 优于或等于基准"验收失败，且整个换引擎决策的量化依据动摇。
  - dimension 一旦建库即不可改（zvec 字段维度固定），后期发现错误需 destroy 重建，数据全丢。
- 📊 **置信度**：高（两份文档白纸黑字矛盾，非推测）
- 💡 **建议**：在基座模块设计 §0 决策表新增一行"**Embedding 维度**"，明确：
  - 选定值（建议 4096，与基准对齐以便 REQ-07 复现）；
  - 维度校验：建库前先调 `EmbeddingProvider.embed(['probe'])` 校验返回维度 == `config.dimension`，不一致即抛 `DimensionMismatchError`；
  - 在 `ZvecEngineConfig` 注释里写死"必须与 `EmbeddingProvider.dimension` 严格相等"。

---

### 质疑 #2：`EmbeddingProvider.embed` 同步签名与 HTTP 异步不兼容（🔴 高风险）

- 🏷️ **类型**：接口契约 / 根本性设计错误
- 📍 **涉及**：`zvec-base-module.md` §4.6
  ```
  interface EmbeddingProvider {
    dimension: number;
    embed(texts: string[]): number[][];   // ← 同步签名
  }
  ```
- ❓ **质疑点**：SiliconFlow 是 HTTP API，Node 侧必须 `await fetch`。同步签名 `embed(texts): number[][]` 在 Node 里**无法用标准 async 实现**，只能：
  - 用 `child_process` / `deasync` 阻塞主线程（坏味道，破坏常驻服务的并发性，违背 requirement.md"多请求共享 runtime"）；
  - 或实现时偷偷改成 `Promise<number[][]>`（破坏契约，所有调用方都得改）。
  
  compare.py 用 `requests`（Python 同步阻塞）跑通，是因为 Python 的同步模型天然兼容；Node 不能照搬。requirement.md §1.3 决策"语言=Node"与 §4.3"现有 `mem-client.ts` 已封装 spawn `mem`"都隐含 Node 异步生态。
- 🔍 **验证方法**：尝试用 Node 写一个 `embed` 实现满足 `number[][]` 同步返回 + 内部调 SiliconFlow——必然需要 `deasync` 之类 hack，或根本无法做到非阻塞。
- ⚠️ **风险**：
  - 实现阶段被迫改接口签名 → 所有依赖 `EmbeddingProvider` 的调用方都要适配，且单元测试无法用 mock 注入异步 provider。
  - 若用 `deasync` 阻塞，常驻 MCP server 在 embedding 期间无法响应其他请求，<5ms 查询目标在写入并发时崩盘。
- 📊 **置信度**：高（HTTP API 不可能同步，这是 Node 基本约束）
- 💡 **建议**：改为
  ```
  interface EmbeddingProvider {
    dimension: number;
    embed(texts: string[]): Promise<number[][]>;
  }
  ```
  并把所有写入/检索方法的签名同步改为 `async`（`Promise<WriteResult>` / `Promise<Hit[]>`）。这是接口契约层的根本修正，必须在 design-craft 之前定。

---

### 质疑 #3：FTS 分词器配置完全缺失，B-10/B-11 核心收益将打折（🔴 高风险）

- 🏷️ **类型**：需求覆盖 / 核心能力配置缺失
- 📍 **涉及**：`zvec-base-module.md` §3 B-10/B-11 + §4.1 `ftsField?: string`
- ❓ **质疑点**：B-10（FTS 关键词检索）/B-11（混合检索）被定为"换 Node 引擎的根本收益，必须作为一等公民暴露"（§3 备注），但 `ZvecEngineConfig.collection.ftsField` 只是一个**字段名字符串**，完全没有暴露 zvec FTS 的核心配置：
  - **分词器**（`tokenizer_name`）：zvec.md L144-148 明确 `standard`（CJK 拆单字，中文检索质量差）/ `whitespace` / **`jieba`（中文分词，KiSearch 中文语料场景推荐）**。
  - **过滤链**（`filters`）：`lowercase` / `ascii_folding` / `stemmer`。
  - **jieba 字典目录**（`extra_params.jieba_dict_dir` 或 `ZVEC_JIEBA_DICT_DIR`）。
  
  requirement.md H-03 明确把"中文 FTS 有效性"列为**中难度待验证假设**；decision.md L76 对策"KiSearch 主场景为代码符号（英文），中文走向量"——但这是**回避**而非**解决**：一旦用户用中文关键词查（如"同步关系"），standard 分词拆成单字"同/步/关/系"，BM25 召回质量极差，混合检索的 FTS 路反而拖低 RRF 融合分。
  
  基座模块作为"引擎层抽象"，把分词器选择权吞掉，等于把 H-03 的风险固化进底层，上层无法补救。
- 🔍 **验证方法**：
  1. 建 FTS 字段用 `standard` 分词，灌入中文 wiki，查"同步关系"看 Recall。
  2. 同样数据改用 `jieba` 分词，对比 Recall。
  3. 检查 `@zvec/zvec` Node SDK 的 `ZVecCollectionSchema` 是否暴露 `tokenizerName`（zvec.md L54 Python 示例有，Node 应等价）。
- ⚠️ **风险**：
  - 默认 `standard` 分词下，中文 FTS 召回质量低于向量检索 → 混合检索的 FTS 路是噪声 → RRF 融合后比纯向量还差 → B-11"召回主路径"反而退化。
  - 后期想换 jieba 必须重建集合（FTS 字段不支持 alter，zvec.md L153），数据全丢。
- 📊 **置信度**：高（zvec.md 与 zvec-mcp-server-tools.md 均明确分词器是 FTS 配置项，设计漏了就是漏了）
- 💡 **建议**：扩展 `ZvecEngineConfig.collection`：
  ```
  fts?: {
    field: string;                    // ftsField 改名归组
    tokenizer: 'standard' | 'whitespace' | 'jieba';
    filters?: ('lowercase' | 'ascii_folding' | 'stemmer')[];
    jiebaDictDir?: string;            // tokenizer=jieba 时必填
  }
  ```
  并在 §3 B-10 验收里加"中文关键词检索 Recall@5 对比 standard vs jieba"。

---

### 质疑 #4：`Hit` 不返回原文 text，破坏 <5ms 性能目标与"返回结构化结果"需求（🔴 高风险）

- 🏷️ **类型**：需求覆盖 / 接口契约
- 📍 **涉及**：`zvec-base-module.md` §4.4 `Hit` + §4.5 检索操作
  ```
  interface Hit {
    id: string;
    score: number;
    queryType: 'vector' | 'fts' | 'hybrid';
    fields: Record<string, ScalarValue>;
  }
  ```
- ❓ **质疑点**：`Hit` 只返回 `id + score + fields`，**不返回原文 `text`**。但：
  - requirement.md §1.4 场景4："`ki search` / path 检索……返回**结构化结果**"——结构化结果必然含文档原文（用户要看命中的是什么）。
  - requirement.md §1.7 期望体验："`ki search` 毫秒级返回**结构化结果**；store 后直接拿回 id"。
  - zvec-mcp-server-tools.md L271 `fetch_documents` 明确"按 id 取回完整文档（含向量与标量字段）"。
  
  如果 Hit 不含原文，上层必须 `search` 拿 id → `fetch` 拿原文，**两次往返**。常驻服务内虽然不是网络往返，但仍是两次 zvec 调用，且 fetch 要重新加载向量（zvec 的 query 本就可以 `outputFields` 指定返回字段，zvec.md L96）。这违背 REQ-02"查询 <5ms（含 reopen 验证）"——多一次 fetch 直接吃掉预算。
- 🔍 **验证方法**：写 `search('同步关系')` 不带原文 → 看上层是否被迫补 fetch；测两次调用总耗时是否仍 <5ms（基准单次 0.8ms，两次应仍 OK，但语义上多余且违反 DRY）。
- ⚠️ **风险**：
  - 上层每次检索都要写 `const hits = await engine.search(req); const docs = await engine.fetch(hits.map(h=>h.id));`，模板代码重复，易漏 fetch 导致只展示 id。
  - 若 ftsField 同时是返回字段，zvec `querySync` 本就支持 `outputFields` 包含它——基座模块强行不返回，是**人为阉割**底层能力。
- 📊 **置信度**：高（zvec 原生支持 outputFields，设计主动丢弃）
- 💡 **建议**：扩展 Hit：
  ```
  interface Hit {
    id: string;
    score: number;
    queryType: 'vector' | 'fts' | 'hybrid';
    fields: Record<string, ScalarValue>;
    text?: string;                    // ftsField 原文（若配置了 outputFields 含之）
    vector?: number[];                // 可选，按需返回
  }
  ```
  并在所有检索 Req 加 `outputFields?: string[]`（透传 zvec），默认返回 ftsField + 所有标量字段。

---

### 质疑 #5：`Hit.score` 方向不统一，归一化责任甩给调用方（🔴 高风险）

- 🏷️ **类型**：接口契约 / 已知陷阱未消解
- 📍 **涉及**：`zvec-base-module.md` §4.4/§4.5 + §5 非功能约束
  ```
  vector：距离值，越小越相似（COSINE 下）
  fts：相似度值，越大越相关（BM25 式）
  hybrid：融合分，方向以具体融合策略为准
  ```
- ❓ **质疑点**：设计**承认**了 score 方向不一致，但把"按 queryType 解读"的责任完全推给上层。这是把 zvec-mcp-server-tools.md L444 已实测验证的陷阱（"score 是距离不是相似度"）原样泄漏到 KiSearch 上层。后果：
  - KiSearch 上层若做"FTS + vector 两路分别查再合并"（Python PoC 的手动 RRF 路径，requirement.md §4.2 说 v0.5.0 起可改原生，但 H-01 未验证 Node API），两路 score 方向相反，合并排序时极易写反。
  - 若走原生 `multiQuerySync` 的 hybrid，RRF 融合分是"越大越相关"（rank 越靠前分越高），与 vector 路的"越小越相似"又相反——同一次 hybrid 查询内部就矛盾。
  - 阈值过滤（`hardMinScore`，requirement.md §4.4 评测踩坑已记录）方向写反直接过滤掉所有结果或全部通过。
- 🔍 **验证方法**：让上层实现一个 `sortHits(hits)` 函数——会发现必须 `if (queryType==='vector') sort asc else sort desc`，这是设计味道（switch-on-type 反模式）。
- ⚠️ **风险**：
  - 任何上层排序/阈值/分页逻辑都要带 `queryType` 分支，漏一个分支就是静默错误（结果顺序颠倒但程序不报错）。
  - 违背基座模块"解耦"的初衷——把 zvec 的 score 语义细节强加给 KiSearch 领域层。
- 📊 **置信度**：高（实测坑已记录，方向相反是客观事实）
- 💡 **建议**：基座模块**统一归一化**为"越大越相关"（业界惯例，便于上层排序）：
  ```
  interface Hit {
    score: number;   // 归一化后：越大越相关，范围 [0,1] 或保留原始量级但方向统一
  }
  ```
  - vector 路内部做 `score = 1 / (1 + distance)` 或 `score = -distance`；
  - fts 路保持原值；
  - hybrid 路用 RRF 分（越大越相关）。
  queryType 仍保留供上层知道"这个分来自哪路"，但**方向不再分叉**。

---

### 质疑 #6：db 文件共享策略（H-02）在基座模块层未闭环（🟡 中风险）

- 🏷️ **类型**：架构 / 假设未闭环
- 📍 **涉及**：`zvec-base-module.md` §0"单集合句柄" + §5"进程内、无独立服务"（全文未提 db 文件归属）
- ❓ **质疑点**：requirement.md H-02 明确"zvec db 文件在构建（ki store）与服务（MCP server）间安全共享，或统一由 MCP server 持有"——**未验证假设**。decision.md L75 给了对策"由常驻 MCP server 统一持有 db，CLI 写入走 MCP 或独占模式"。但基座模块设计**完全没有体现这个策略**：
  - 没有定义"谁 open db"——是 MCP server 启动时 open，还是 `ki store` CLI 也 open？
  - zvec-mcp-server-tools.md L200 实测坑："同会话内已 create 过该库，`open_collection(read_only=true)` 报 `Can't lock read-only collection: .../LOCK`"——**zvec 有文件锁**，与 decision.md L49"zvec 无 lancedb 式文件锁"的断言**冲突**。
  - 若 MCP server 常驻持有 db，`ki store` CLI 又想写，二者同时 open 同一 db 是否触发 LOCK 冲突？基座模块没有 `isOpen()` / `tryOpen()` / 文件锁协调机制。
- 🔍 **验证方法**：
  1. 起 MCP server open db → 另起 `ki store` 进程 open 同一 db → 看是否报 LOCK。
  2. 核对 `@zvec/zvec` Node SDK 的锁语义（zvec.md 只说"进程退出后持久化"，未说并发 open）。
- ⚠️ **风险**：
  - 若 zvec 有文件锁，常驻服务 + CLI 并发写入直接死锁，整个换引擎决策的"消除 lancedb 锁死"卖点落空。
  - 即使无锁，两个进程同时写同一 db 文件也可能数据损坏。
- 📊 **置信度**：中（zvec Node 侧锁语义未实测，但 MCP server Python 侧已实测有 LOCK 文件）
- 💡 **建议**：
  1. 基座模块新增 `ZvecEngine.isLocked(): boolean` 或 `tryOpen(): ZvecEngine | null`，让上层判断能否安全 open。
  2. 在 §5 非功能约束加一条"**db 文件归属**：由 MCP server 单一持有，CLI 写入走 MCP 协议或排队等待锁释放"。
  3. 把 H-02 从"中难度待验证"升级为 design-craft 前必须验证的阻塞项。

---

### 质疑 #7：`filter` 裸 string 透传，抽象泄漏 + 注入风险（🟡 中风险）

- 🏷️ **类型**：接口契约 / 抽象泄漏 + 安全
- 📍 **涉及**：`zvec-base-module.md` §4.3 所有检索 Req 的 `filter?: string`
- ❓ **质疑点**：`filter` 直接是 `string`，语法是 zvec 的类 SQL（`tag == "ki-relation" AND score > 0.8`）。这违背基座模块"引擎层抽象、不认识 ki-relation"的铁律——上层要把"ki-relation 标签"拼成 zvec 语法字符串，等于**上层必须懂 zvec 的 filter DSL**。问题：
  - **转义**：tag 值含引号/特殊字符（如 `path == "src/a'b.ts"`）需手动转义，易错。
  - **注入**：若 filter 部分来自用户输入（如用户搜 `tag:用户输入`），未转义直接拼接 → 类 SQL 注入。
  - **可移植性**：若未来 zvec 改 filter 语法，所有上层调用全崩。
- 🔍 **验证方法**：让上层构造 `filter = tag == "${userTag}"`，传 `userTag='x" OR 1=1'` 看是否注入。
- ⚠️ **风险**：上层每个调用点都要手写转义，漏一个就是安全洞；且违反"基座模块可单测"（filter 构造逻辑散落上层）。
- 📊 **置信度**：中（设计本身没错，但作为"引擎抽象层"不够）
- 💡 **建议**：提供结构化 filter：
  ```
  type Filter =
    | { field: string; op: '==' | '!=' | '>' | '<' | '>=' | '<='; value: ScalarValue }
    | { and: Filter[] }
    | { or: Filter[] }
    | { not: Filter };
  ```
  基座模块内部负责转成 zvec 字符串语法并转义。或者至少提供 `escapeFilterValue(v: string): string` 工具函数。

---

### 质疑 #8：embedding 失败重试/并发限流未内化，已知痛点将复发（🟡 中风险）

- 🏷️ **类型**：需求覆盖 / 隐性需求遗漏
- 📍 **涉及**：`zvec-base-module.md` §4.4 `WriteResult` + B-04 写入
- ❓ **质疑点**：requirement.md §4.4 评测踩坑明确记录："SiliconFlow API 偶发抖动会让 `mem bulk-store` 整批静默存 0 → 入库需加重试+计数校验"。但基座模块设计：
  - `EmbeddingProvider.embed` 无重试/超时/并发参数。
  - `WriteResult` 只有 `ok/failed/errors`，没有区分"embedding 失败"vs"zvec 写入失败"vs"维度不匹配"。
  - 批量 embedding 没有 batch size / QPS 限制——SiliconFlow 有速率限制，一次性 embed 1000 条会 429。
- 🔍 **验证方法**：模拟 SiliconFlow 返回 500/429，看基座模块是否重试或清晰报错。
- ⚠️ **风险**：常驻服务下批量 `ki store` 时，SiliconFlow 抖动 → 整批存 0 → 与 mem 时代同样的静默失败，换引擎没解决痛点。
- 📊 **置信度**：高（痛点已在 requirement.md 白纸黑字记录）
- 💡 **建议**：
  - `EmbeddingProvider` 加 `embed(texts, opts?: { retries?: number; batchSize?: number; timeoutMs?: number })`。
  - `WriteResult.errors[].reason` 用枚举区分 `EMBEDDING_FAILED` / `DIMENSION_MISMATCH` / `ZVEC_WRITE_ERROR` / `ID_CONFLICT`。
  - 批量写入内部自动分批 + 重试 + 指数退避。

---

### 质疑 #9：`HybridSearchReq.fts` 必填，与纯语义检索场景矛盾（🟡 中风险）

- 🏷️ **类型**：接口契约 / 场景覆盖
- 📍 **涉及**：`zvec-base-module.md` §4.3 `HybridSearchReq`
  ```
  interface HybridSearchReq {
    queryText?: string;
    vector?: number[];
    fts: string;          // ← 必填
    ...
  }
  ```
- ❓ **质疑点**：`fts` 必填，但 zvec.md L116 说 `multiQuerySync` 子查询"至少 2 条"——所以 hybrid 必须有 fts + vector 两路。然而 KiSearch 的语义检索场景（用户问"如何同步两个知识实体之间的关系"）可能**没有明确关键词**，强制传 fts 会导致：
  - 上层从 queryText 提取关键词（额外逻辑，可能提错）；
  - 或传 queryText 本身当 fts（FTS 对长自然语言分词后 OR 匹配，会召回大量噪声）；
  - 或传空串（FTS 行为未定义，可能报错或返回空）。
- 🔍 **验证方法**：传 `fts=""` 看 zvec 行为；传 `fts=queryText`（长自然语言）看召回质量是否被 FTS 噪声拖低。
- ⚠️ **风险**：hybrid 在纯语义场景反而不如纯 vector，B-11"召回主路径"名不副实。
- 📊 **置信度**：中
- 💡 **建议**：
  - `fts?: string` 改可选；
  - 若 `fts` 缺失但有 `queryText/vector`，内部退化为单路向量查询（并返回 `queryType: 'vector'`）；
  - 或提供独立的 `semanticSearch`（已有 `SemanticSearchReq`）与 `hybridSearch` 两条路径，让上层按场景选，不强求 hybrid 全覆盖。

---

### 质疑 #10：`vectors` 多字段 vs `config` 单 denseField 设计不一致（🟡 中风险）

- 🏷️ **类型**：接口契约 / 内部矛盾
- 📍 **涉及**：`zvec-base-module.md` §4.1 vs §4.2
  ```
  §4.1 ZvecEngineConfig.collection.denseField: string;   // 单个向量字段名
  §4.2 DocInput.vectors?: Record<string, number[]>;       // 多个向量字段
  ```
- ❓ **质疑点**：配置层只支持**一个** denseField，但输入层 `vectors` 是 `Record<string, number[]>`（允许多字段）。如果配置只声明了 `dense`，但 DocInput 传 `vectors: { dense: [...], sparse: {...} }`，sparse 字段去哪？zvec.md L20 明确支持稀疏向量 `SPARSE_VECTOR_FP32` 用于混合检索——基座模块配置层没暴露稀疏向量字段定义，输入层却预留了多向量口子，**自相矛盾**。
- 🔍 **验证方法**：配置只声明 dense，DocInput 传 `{ dense, sparse }`，看 zvec 是否报"未知字段"（zvec.md L78：未知字段会整批回滚）。
- ⚠️ **风险**：要么上层永远只传单向量（Record 多字段是死代码），要么配置层补稀疏向量字段定义（设计要改）。
- 📊 **置信度**：中
- 💡 **建议**：二选一——
  - 简化：`DocInput.vectors?: number[]`（单向量，与单 denseField 对齐）；
  - 或扩展配置：`denseFields: VectorFieldDef[]` + `sparseFields?: SparseFieldDef[]`，与 zvec 多向量能力对齐（zvec.md L56-61 示例就是单 dense，但 SDK 支持多）。

---

### 质疑 #11：引擎句柄类型与方法签名未定义（🟢 低风险）

- 🏷️ **类型**：接口契约不完整
- 📍 **涉及**：`zvec-base-module.md` §4.5"操作清单"只有"操作 → 入参 → 响应"，**没有方法名**
- ❓ **质疑点**：调用方知道传什么、收什么，但不知道**怎么调**。是 `ZvecEngine.create(config): ZvecEngine`（静态）还是 `new ZvecEngine(config)`？是实例方法 `engine.search(req)` 还是顶层函数？类名 `ZvecEngine` 在标题出现，但 §4.5 用"创建集合"这种自然语言描述，无方法签名。这会让 design-to-code 阶段无法直接生成骨架。
- 📊 **置信度**：高
- 💡 **建议**：§4.5 改为方法签名表：
  ```
  class ZvecEngine {
    static create(config: ZvecEngineConfig): Promise<ZvecEngine>;
    static open(config: ZvecEngineConfig, readOnly?: boolean): Promise<ZvecEngine>;
    info(): CollectionInfo;
    upsert(docs: DocInput[]): Promise<WriteResult>;
    search(req: SemanticSearchReq | VectorSearchReq | FtsSearchReq | HybridSearchReq): Promise<Hit[]>;
    ...
  }
  ```

---

### 质疑 #12：`destroy`/重建机制（REQ-09 健壮性）未设计（🟢 低风险）

- 🏷️ **类型**：需求覆盖 / P2 需求遗漏
- 📍 **涉及**：`zvec-base-module.md` §4.5"销毁集合 → 空"
- ❓ **质疑点**：requirement.md REQ-09："常驻保活、异常重启、db 损坏可重建"。基座模块有 `destroy`，但没有：
  - `isHealthy()` / `isOpen()` 状态查询；
  - db 损坏检测（zvec open 失败时如何判断是损坏 vs 不存在）；
  - 损坏后重建流程（destroy + create？数据如何恢复——需重新 store 全量）。
- 💡 **建议**：补 `ZvecEngine.isHealthy(): boolean`，并在 §5 加"db 损坏检测与重建流程"小节。

---

### 质疑 #13：`list`/`count` 能力缺失，与 REQ-02 `list` 工具脱节（🟢 低风险）

- 🏷️ **类型**：需求覆盖 / 上层工具无对应引擎能力
- 📍 **涉及**：`zvec-base-module.md` §3 操作清单
- ❓ **质疑点**：requirement.md REQ-02 说 MCP server 暴露 `store/search/list/stats` 工具。基座模块有 `stats`(对应 B-03 collection_info)，但**没有 `list`**——"列出所有 tag=ki-relation 的文档 id"无法实现。KiSearch 的 sync-relation 回写检查需要 list 能力。
- 💡 **建议**：补 B-15 `listIds(filter?: string, limit?: number): string[]` 或 `scroll(filter, batchSize)`。

---

### 质疑 #14：`topk` 默认值与上限未定义（🟢 低风险）

- 🏷️ **类型**：接口契约不完整
- 📍 **涉及**：所有检索 Req 的 `topk?: number`
- ❓ **质疑点**：未说默认值与上限。zvec-mcp-server-tools.md L290：默认 10，上限 1000。基座模块应明确，否则调用方不知道传多少，且不同 zvec 版本上限可能不同。
- 💡 **建议**：注释里写 `default: 10, max: 1000`，并在 §5 非功能约束加一条。

---

### 质疑 #15：向量字段数据类型（FP16/FP32）未暴露（🟢 低风险）

- 🏷️ **类型**：抽象泄漏 / 性能优化缺失
- 📍 **涉及**：`ZvecEngineConfig.collection` 只有 `dimension/metric`，无 `dataType`
- ❓ **质疑点**：zvec.md L19/64 支持 FP32/FP16/INT8，HNSW-RaBitQ 省 x86_64 AVX2+ 内存。基座模块配置层不暴露，默认 FP32，无法省内存。常驻服务长期持有大库时内存敏感。
- 💡 **建议**：`denseField` 加 `dataType?: 'FP32' | 'FP16'`，默认 FP32。

---

## 🎨 体验质量质疑

### 正向体验（设计阶段，从"调用方使用爽不爽"角度）

- **操作流畅度**：⚠️ — 检索后必须二次 `fetch` 拿原文（质疑 #4），流程冗余。
- **反馈及时性**：✅ — `WriteResult` 有 ok/failed/errors，结构清晰。
- **认知负担**：❌ — `score` 方向需按 `queryType` 记忆（质疑 #5），调用方每次写排序都要查表，认知负担高。
- **优化空间**：⚠️ — `filter` 裸 string（质疑 #7）要求调用方懂 zvec DSL，偏离"引擎抽象层"定位。

### 负向体验（调用方"犯错时"是否依然好用）

- **错误可理解性**：⚠️ — `WriteResult.errors[].reason` 是 `string`，无错误码枚举，embedding 失败 vs 维度不匹配 vs id 冲突混在一起（质疑 #8）。
- **错误引导性**：❌ — 维度不匹配只说"须与 embedding 模型一致"，不告诉调用方实际值是多少、应改哪个（质疑 #1）。
- **恢复路径**：⚠️ — FTS 分词器选错需 destroy 重建（质疑 #3），数据全丢，无降级路径。
- **防呆设计**：❌ — dimension 不校验（质疑 #1）、filter 不转义（质疑 #7）、embedding 不重试（质疑 #8），均为"提交后才报错"。
- **故意作恶**：⚠️ — 传 `vectors` 多字段但 config 单 denseField（质疑 #10），zvec 会整批回滚报"未知字段"，但错误信息可能不指向根因。

### 体验总结

- **总体评价**：⚠️ 体验一般
- **关键问题**：score 方向不统一（#5）+ 维度决策缺失（#1）+ FTS 分词器缺失（#3）三连击，调用方在"建库"和"检索"两个核心动作上都会踩坑。
- **改进建议**：把 zvec 的已知陷阱（score 方向、维度区间、分词器、文件锁）在基座模块层全部消解或显式暴露配置，而不是透传给上层。

---

## 📊 质疑总结

### 统计
- **总质疑数**：15
- **高风险（🔴）**：5（#1 维度、#2 embed 同步、#3 FTS 分词器、#4 Hit 缺原文、#5 score 方向）
- **中风险（🟡）**：5（#6 db 共享、#7 filter 注入、#8 embedding 重试、#9 fts 必填、#10 vectors 多字段）
- **低风险（🟢）**：5（#11 句柄签名、#12 destroy 重建、#13 list、#14 topk、#15 FP16）

### 风险分布
- 🔴 **高风险**：集中在"接口契约根本性错误"（#2 同步签名不可实现）+"核心收益配置缺失"（#1/#3 直接威胁 REQ-04/REQ-07 验收）+"已知陷阱未消解"（#4/#5 把 zvec 实测坑透传上层）。这 5 项若不在 design-craft 前修正，编码阶段必然返工。
- 🟡 **中风险**：集中在"架构假设未闭环"（#6 H-02）+"安全/健壮性"（#7/#8）+"场景覆盖"（#9/#10）。这些在 P0 主链路打通后会暴露，建议在 design-craft 同步处理。
- 🟢 **低风险**：接口完整性问题，design-to-code 阶段自然会发现并补全，但提前定义可减少骨架生成歧义。

### 与 requirement.md 假设的关联
- **H-01**（zvec API 满足 KiSearch 语义）：质疑 #4（Hit 缺原文）、#9（fts 必填）、#10（vectors 多字段）直接挑战此假设——API 满足，但基座模块的接口契约没有完整暴露 API 能力。
- **H-02**（db 文件共享）：质疑 #6 直接挑战——基座模块层未体现共享策略，假设未闭环。
- **H-03**（中文 FTS 有效性）：质疑 #3 直接挑战——分词器配置缺失，H-03 无法验证。
- **H-04**（Node 性能与 Python 一致）：质疑 #1 挑战——维度不一致则基准不可复现。
- **H-05**（mem-client 语义可映射）：质疑 #5 挑战——score 方向不统一会增加映射成本。

---

## 🎯 行动建议

### 必须处理（design-craft 前阻塞）

1. **修正 `EmbeddingProvider.embed` 为 `Promise<number[][]>`**（质疑 #2）——根本性签名错误，不改则无法实现。所有写入/检索方法签名同步改 async。
2. **明确 embedding 维度决策**（质疑 #1）——在 §0 决策表加一行，选定 4096（与基准对齐）或 1024（与 MCP 实测对齐），并加建库前维度校验。建议先跑 Node 侧 4096 维基准验证可复现性。
3. **暴露 FTS 分词器配置**（质疑 #3）——扩展 `fts` 配置组含 `tokenizer/filters/jiebaDictDir`，否则 B-10/B-11 核心收益打折，H-03 无法验证。
4. **`Hit` 增加 `text?` 与 `outputFields`**（质疑 #4）——否则违背"返回结构化结果"需求且破坏 <5ms 目标。
5. **统一 `score` 方向为"越大越相关"**（质疑 #5）——基座模块内部归一化，不把方向解读责任甩给上层。

### 建议处理（design-craft 同步）

6. **闭环 db 文件共享策略**（质疑 #6）——基座模块加 `isLocked()/tryOpen()`，§5 加"db 归属"约束，H-02 升级为阻塞验证项。
7. **提供结构化 filter 或转义工具**（质疑 #7）——避免抽象泄漏与注入。
8. **embedding 重试/分批/错误码枚举**（质疑 #8）——内化 SiliconFlow 抖动痛点。
9. **`HybridSearchReq.fts` 改可选**（质疑 #9）——支持纯语义场景退化。
10. **统一 vectors 与 config 的向量字段模型**（质疑 #10）——二选一，消除自相矛盾。

### 可选处理（design-to-code 阶段补全）

11. 补全引擎句柄方法签名表（质疑 #11）。
12. 补 `isHealthy()` 与 db 损坏重建流程（质疑 #12）。
13. 补 `listIds/scroll` 能力对齐 REQ-02 `list` 工具（质疑 #13）。
14. 注明 `topk` 默认值与上限（质疑 #14）。
15. 暴露向量字段 `dataType`（FP32/FP16）（质疑 #15）。

---

## 📌 结论

基座模块设计的**分层定位正确**（纯引擎抽象层、不含 MCP、embedding 可注入、单集合句柄），§2 职责边界与"铁律"清晰，总体方向合理。**但接口契约层存在 5 个高风险问题**，其中 #2（同步签名）是根本性不可实现错误，#1/#3 直接威胁 REQ-04/REQ-07 验收，#4/#5 把 zvec 已知陷阱透传给上层。

**审查结论：设计骨架合理，但接口契约需返工修正 5 项高风险问题后方可进入 design-craft / design-to-code。** 建议先执行"必须处理"5 项，再进入下一步。
