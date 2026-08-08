# 代码调研：数据清洗 + local KB 与向量一对多方案（REQ-06）

> 调研来源：项目记忆索引 ✗（ki MCP 未接入会话）| 知识库记忆索引 ✗ | 代码搜索 ✓ | 语义检索 ✗
> 调研范围：仅列出与数据清洗需求相关的维度
> 调研目的：为 REQ-06（数据清洗 + local KB 与向量一对多，方案 D）裁剪出 ki 场景（Markdown 知识库、零新增依赖）的落地清洗流水线

## 1. 技术栈约束

- **依赖极简**（package.json dependencies）：`@modelcontextprotocol/sdk`、`@zvec/zvec`、`commander`、`jiti`、`yaml`、`zod`
- **无任何清洗/解析类第三方库**（无 ftfy / cheerio / marked / unidecode / langchain）
- **约束结论**：清洗必须**纯 Node 实现、零新增依赖**——正则 + `String.prototype.normalize('NFC')`（内置）即可覆盖

## 2. 相关代码路径

| 文件 | 定位 | 与清洗的关系 |
|------|------|-------------|
| `src/lib/import.ts:162-165` | `readFileToChunks` | **保持原文**：返回原文 chunk（向量化输入），清洗不在此层；REQ-06 缺口在导入流程重构（local KB 文件原文先写 + 清洗 → 切分 → 向量化） |
| `src/lib/import.ts:463-489` | `phase4WriteRelations` | **需重构（方案 D）**：当前因 `e.path` 含 `#N`（`deriveChunkSourcePath` import.ts:157-159）降级用 `e.text` 写 local KB（chunk 片段）→ 改为**不再写 local KB**（文件原文已在切分前"第一步"写入，见 REQ-06 流程 ①），本阶段只写 relation-cache（文件级 relation + `memoryIds` 回填） |
| `src/lib/batch-vectorize.ts` | `bulkVectorize` | **向量化入口**：`handleDirectImport`（import.ts:280）/`handleIncrementalDirect`（incremental.ts:367）提交前对清洗后 chunk 向量化，返回每 chunk memoryId |
| `src/lib/relation-map.ts` | memoryId 反查 | **需增强（方案 D）**：从单值 `memoryId → {group, relation}` 改为支持多值聚合（多个 chunk memoryId → 同一文件级 relation） |
| `src/search.ts:95-101` | search 反查附加 | **需增强（方案 D）**：命中任一 chunk memoryId → 返回文件原文；多 chunk 命中去重 |
| `src/lib/import.ts:114-126` | `stripMarkdownExtension` + `cleaned=base.replace(/[*~`]/g,'')` | 已有关系名清洗（去 markdown 特殊字符），可复用正则风格 |
| `src/lib/chunker.ts:57-92` | `splitIntoChunks` | 切分实现（段落边界 `\n\n>\n>。>；` + overlap 150 + `MAX_CHUNKS_PER_FILE=500`），输入为清洗后文本 |
| `src/lib/import.ts`（collectMarkdownFiles，line 132-148） | 文件级过滤 | 已有：隐藏目录 / node_modules / `.md` 扩展名（`/\.md$/i`，非 md 静默忽略）→ **REQ-08：改为格式白名单 + 非 md 汇总提示**；大小上限 2MB → **1MB**（config `scopes.<scope>.import.maxFileSize`，非 CLI 参数）；500 chunk 上限保留 |
| `src/lib/markdown-gen.ts:23-40` | frontmatter **生成**（写 KB 方向） | 反向参考：确认 KB frontmatter 格式（`title/group/relation/tags`），清洗剥离的是**源文件** frontmatter |
| `src/lib/incremental.ts:80-85` | 增量链路关系名清洗 | 与 full 模式相同的命名清洗逻辑 |

**关键结论（已按用户澄清修订为方案 D）**：**local KB 与向量改为一对多关系**——① 文档进来**第一步直接写入 local KB（文件级原文，一个文件一条记录）**；② 随后数据清洗（`cleanMarkdownText`）；③ 然后切分 → 每段 chunk 向量化 → 获取每段 chunk 的 **memoryId**；④ 写入 relation-cache 该文件的 `memoryIds` 字段（多值）；⑤ 原文召回时**命中任意一个 memoryId → 返回该文件原文，重复命中只返回一次**。清洗只作用于**向量化输入**；local KB 写入链路（`phase4WriteRelations`/`writeLocalKb`）改为先写文件原文。**relation 命名冲突（用户决策）**：文件级 relation 取 basename 去扩展名（`deriveRelationText`），冲突仅可能发生在同 group 下同名文件（group 含目录层级天然隔离不同目录）；发生冲突 → **直接跳过该文件 + 反馈用户**（冲突 relation 名 + 文件路径计入 skipped）。

## 3. 现有清洗痕迹（可参考）

- 关系名清洗：`base.replace(/[*~`]/g, '')`（import.ts:125）——命名清洗已有，**内容清洗为零**
- 旧标签前缀清理：`content.replace(/^【标签:[^】]*】\s*/, '')`（delete-relation.ts:242）——正则风格参考
- **不存在**：BOM 处理、frontmatter 剥离、乱码修复、去重、质量过滤——全部空缺

## 4. 测试模式

- 单测：`test/*.test.ts` + `npx jiti`（`test:all` 循环跑）；`chunker.test.ts` 已有 10/10 用例（含 MAX_CHUNKS_PER_FILE 契约）
- fixtures：`test/fixtures/`（GitNexus 已索引 74 节点）
- **新增测试建议**：`test/chunker-clean.test.ts`（清洗函数单测，构造 BOM/frontmatter/空 chunk fixture）或扩展 `chunker.test.ts`

## 5. 数据清洗方案（ki 场景裁剪）

基于通用 RAG 清洗流水线，针对 **Markdown 输入 + 零依赖** 约束裁剪：

| 通用环节 | ki 适配（纯 Node） | 优先级 | 落点 |
|----------|-------------------|--------|------|
| ① 格式解析 | 已内置（`.md` 收集） | — | 无需 |
| ② 编码规范化 | BOM 剥离 `^\uFEFF`；控制字符/替换符/零宽字符剥离；`normalize('NFC')` | P0 | `cleanMarkdownText` |
| ③ 去噪 | **frontmatter 剥离**；HTML 注释；折叠空行；**mermaid 块剥离**（图语法语义密度低，正文已覆盖）；**文件路径剥离（模式识别，不依赖 `<cite>` 等标记）**；**代码块剥离（可配置，默认剥离、可保留短示例）** | P0 | `cleanMarkdownText` |
| ④ 去重 | 文件级 MD5（跳过重复文件）+ chunk 级 hash（同文件内重复段落） | P1 | 文件级在 collectMarkdownFiles，chunk 级在切分后 |
| ⑤ 质量过滤 | 空 chunk（`!text.trim()`）跳过；<50 字近空合并/剔除；符号占比过高判定 | P0 | 切分后过滤 |
| ⑥ 敏感脱敏 | 项目知识库默认**不做**，防误伤代码符号 | 范围外 | — |
| ⑦ Chunking | 已有 `splitIntoChunks`（语义边界优先 + overlap） | — | 无需 |
| ⑧ 元数据 | 已有（group / relation / sourcePath / tag） | — | 无需 |

### 文件路径剥离（模式识别，核心规则）

**不依赖 `<cite>`/`**来源**` 等结构化标记**，用正则通用识别并剥离：

```ts
// ① Markdown 链接整体处理：剥离链接目标，保留链接文字（[用户登录](file://x) → 用户登录）
t = t.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1');
// ② file:// URL（链接剥离后残留的裸 URL）
t = t.replace(/file:\/\/[^\s\)\]>]+/g, '');
// ③ 行号引用（#L188-L605 / :188-605）
t = t.replace(/(?:#L\d+(-\d+)?|:\d+(-\d+)?)/g, '');
// ④ 裸代码文件路径（要求含目录层级 / ，避免误伤正文中的单文件名引用）
t = t.replace(/\b[\w./-]*\/[\w./-]+\.(?:py|ts|js|tsx|go|java|rs|sh|md|json|yaml|yml)\b/g, '');
// ⑤ 剥离后整行仅剩空白/符号 → 删行
t = t.split('\n').filter((l) => l.trim().length > 0 && !/^[\s\-*•·>]+$/.test(l)).join('\n');
```

> **剥离顺序要点**：① 先整体处理 markdown 链接（保留链接文字），再处理裸 file:// URL、行号、裸路径——避免 `[text](file://x)` 剥离后残留 `[text]()` 语法。
> **误伤防护**：④ 要求路径含目录层级 `/`（如 `bkmonitor/urls.py`），正文中"参见 README.md"、`package.json` 等**单文件名引用默认保留**；若需剥离单文件名，可扩展规则（含 `/` 或扩展名白名单），并配合白名单词校准（如 `X-Content-Type-Options`、`Django` 不含代码扩展名，天然不匹配）。

### mermaid / 代码块剥离

```ts
// ⑥ mermaid 块剥离（语义密度低，正文已覆盖图信息）
t = t.replace(/```mermaid[\s\S]*?```/g, '');
// ⑦ 代码块剥离（可配置：默认剥离；keepShortSamples=true 时保留 ≤15 行的短命令/配置示例）
const CODE_FENCE = /```[a-zA-Z0-9_-]*\n[\s\S]*?```/g;
if (stripCodeBlock) {
  t = keepShortSamples
    ? t.replace(CODE_FENCE, (m) => (m.split('\n').length <= 17 ? m : ''))
    : t.replace(CODE_FENCE, '');
}
```

### 核心实现建议（方案 D：local KB 文件原文 → 清洗 → 切分 → 向量化 → memoryIds 回填）

```ts
// cleanMarkdownText 本身不变（clean.ts 新建，rules 由 config/--clean-rules 控制）
function cleanMarkdownText(text: string, rules: CleanRules): string {
  let t = text.replace(/^\uFEFF/, '');                    // ① BOM
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u200B-\u200F]/g, ''); // ② 控制/替换/零宽
  t = t.normalize('NFC');                                 // ② Unicode 规范化
  if (rules.frontmatter && t.startsWith('---')) {         // ③ frontmatter 整块删除
    const end = t.indexOf('\n---', 3);
    // 边界判定：仅当闭合存在且块内匹配键值对特征（key: value）才视为 frontmatter，防误伤正文 `---` 分隔线
    if (end !== -1 && /^[A-Za-z_-]+:\s*\S/m.test(t.slice(3, end))) {
      const after = t.slice(end + 4);                     // `\n---` 之后的内容
      // 闭合边界：`---` 后须紧跟 \n 或 EOF，防 `---important` 类（`---` 后跟非换行内容）误判为闭合
      if (after === '' || /^[\r\n]/.test(after)) {
        t = after;                                        // 整块删除（含 title/date/tags 等全部字段）
      }
    }
  }
  if (rules.htmlComment) t = t.replace(/<!--[\s\S]*?-->/g, ''); // ③ HTML 注释
  if (rules.mermaid) t = t.replace(/```mermaid[\s\S]*?```/g, ''); // ③ mermaid
  if (rules.codePath) { /* ⑤ 文件路径模式识别（见上，前置排除 URL） */ }
  if (rules.codeBlock) { /* ⑦ 代码块剥离 */ }
  t = t.replace(/\n{3,}/g, '\n\n');                       // ③ 折叠空行
  return t.trim();
}

// 导入流程（方案 D：full 与 incremental 对齐）
// ① 写 local KB 文件原文（文档进来第一步，不清洗）：
//    const fileText = fs.readFileSync(absPath, 'utf-8');
//    writeLocalKb(scope, groupPath, deriveRelationText(rel), fileText);  // 文件级 relation key，一个文件一条
// ② 清洗：
//    const cleaned = cleanMarkdownText(fileText, rules);
// ③ 切分 → 向量化（拿每段 chunk memoryId）：
//    const chunks = splitIntoChunks(cleaned, { chunkSize, chunkOverlap });
//    const vec = await bulkVectorize(chunks.map((c) => makeEntry(rel, c)), scope, ...);
// ④ 回填 memoryIds（relation-cache 文件级 relation 挂多值）：
//    rel.memoryIds = chunks.map((c) => vec.ok.get(makeEntry(rel, c).path)).filter(Boolean);
// 原文召回：search 命中任一 chunk memoryId → relation-map 反查文件级 relation → 返回 local KB 原文（去重）
```

### 衔接点（已按用户澄清修订为方案 D）

- **local KB 与向量一对多**：local KB 存**文件级原文**（一个文件一条记录，key = 文件级 relation）；向量存**清洗后 chunk**（每条一个 memoryId）；relation-cache 文件级 relation 挂 `memoryIds` 多值
- **原文召回去重**：`ki search` 命中任一 chunk memoryId → relation-map 聚合反查文件级 relation → 返回该文件原文；同一文件多 chunk 命中只返回一次
- **REQ-05 进度**：清洗在向量化前完成，空 chunk 过滤使向量化条目数减少 → O-01 进度分母以**清洗后**条目数为准
- **`--no-clean` 逃生阀**：`scan-kb import` 加 `--no-clean`，向量化前跳过 `cleanMarkdownText`（local KB 本就有文件原文不受影响）
- **incremental 复用**：full 与 incremental 均按方案 D 流程（incremental.ts:367 对齐 import.ts:280）；source 块记录 `cleanVersion`（**强制**，规则变更提示重建，防增量/全量清洗不一致）
- **异常兜底**：`cleanMarkdownText` 内 `normalize('NFC')` 极端输入可能抛错 → try-catch 降级返回原文，防中断导入

## 6. 关键风险

- **local KB 与向量一对多（方案 D）**：local KB 存**文件级原文**（先写，不清洗），清洗 → 切分 → 向量化只作用于向量输入；**不得**把清洗落点放回 `readFileToChunks` 内（否则清洗后 chunk.text 污染 local KB，破坏原文召回）；relation-cache 需挂 `memoryIds` 多值支持"命中任一 chunk 返回文件原文"
- **frontmatter 剥离误伤**：正文以 `---` 开头的非 frontmatter 内容会被误剥（先校验第二行 `---` 闭合且结构像 frontmatter，如 `title:` 等键值）；**闭合 `---` 后须紧跟行尾/EOF**，防 `---important` 类边界误判
- **URL 路径误伤**：路径剥离正则 ④ 会误伤 `https://github.com/foo/bar.ts` 中 URL 路径（残留 `https://`）→ 正则 ④ 前先剥离/排除 `https?://`、`ftp://` 等 URL
- **清洗函数异常兜底**：`cleanMarkdownText` 内 `normalize('NFC')` 在极端输入可能抛错 → try-catch 降级返回原文，防中断整个导入
- **清洗影响增量一致性**：全量清洗 vs 已导入的旧数据不一致 → 增量 diff 命中面变化（source 块**强制**记录 `cleanVersion`，规则变更提示重建）
- **行为变更**：默认开启改变导入内容，`--no-clean` 逃生阀必须提供
- **存量兼容（REQ-08/O2 决策）**：`buildMemoryIdMap` 改为字段直读后，旧库（chunk 级 relation/无 `memoryIds`）**不做兼容**——用户确认计划重建 KB 与向量数据，无需回退聚合逻辑
- **格式白名单（REQ-08）**：非 `.md` 文件默认跳过，需汇总提示（含文件名）保证可观测；白名单可配（`scopes.<scope>.import.extensions`，默认 `[.md]`）
- **大小限制（REQ-08）**：`maxFileSizeBytes` 默认 2MB → **1MB**，作为 config `scopes.<scope>.import.maxFileSize` 写入（**非 CLI 参数**）；与 500 chunk 上限关系——1MB 中文 ≈ 660 chunk 先撞 500 上限（中文大文件由 chunk 上限先行拦截），大小上限兜底异常字节情况；方案 D 原文返回体量上限 ≈ 20-30 万 token（用户已接受）；chunk 超限兜底保留
