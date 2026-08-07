# 质疑报告：数据清洗方案推演结论（REQ-06/07）

> 质疑时间：2026-08-07
> 质疑对象：报告文档模式 —— `review/scenario-rehearsal.md`（v2 推演报告）
> 触发链路：auto-review → 复杂场景判定（数据完整性 🔴 + 跨需求影响）→ challenger 接力
> 聚焦点：① B1 根因是否找对 ② 影响面是否遗漏 ③ 风险评估是否过度/不足 ④ 修复方案副作用

## 反对意见

### O1 修复方案 A 的副作用被低估（🟡 中）

**质疑**：推演报告建议修复 B1 用方案 A（`phase4WriteRelations` 改用 `e.path.split('#')[0]` 读原文写 local KB），但未论证副作用。

**证据**：
- 一个 2MB 文件切分成 N 个 chunk（如 N=100），每个 chunk 的 relation（`foo-01`...`foo-100`）在 local KB 各占一项
- 方案 A 让每项都存**完整原文**（2MB）→ local KB 膨胀至 N×2MB = 200MB
- `get-module-info` 按 relation 取项时，取到完整原文而非该 chunk 段 → 与 chunk 语义不符（用户期望取该 chunk 对应的段落，而非全文）

**风险**：方案 A 解决了"原文召回"但引入"存储膨胀 + 语义错配"两个新问题，可能比 B1 本身更难处理。

### O2 清洗函数异常处理未定义（🟡 中）

**质疑**：推演报告遗漏 `cleanMarkdownText` 自身异常的归宿。

**证据**：
- `cleanMarkdownText` 内含多条正则 + `normalize('NFC')`。正则理论上不抛，但 `normalize` 在极端 Unicode 输入（如未配对代理对）可能抛 `RangeError`
- 若 `cleanMarkdownText` 抛异常 → `readFileToChunks` 失败 → `handleDirectImport` 整个文件循环中断 → 导入中断
- 设计（code-survey.md:91-108）未给 `cleanMarkdownText` 加 try-catch 兜底（清洗失败应降级返回原文，而非阻断导入）

**数据守恒质疑（异常归宿）**：清洗函数异常时，该文件的 chunk 数据归宿未定义 —— 静默丢弃（中断导入）即守恒破坏，最低 🟡。

## 替代方案

### A1 方案 C：分离清洗与切分（✅ 确定方案，用户澄清确认）

**用户澄清**：local KB 直接存原内容，清洗后数据只有一个方向——向量化。此原则直接否决调研文档 §5"清洗落点在 readFileToChunks 内"的建议（该落点使清洗后 chunk.text 流向 local KB），确认方案 C 为唯一正确方向。

**思路**：`splitIntoChunks` 返回的 chunk 保留**原文 text**（local KB 用），向量化时单独传入**清洗后 text**。

```ts
// readFileToChunks 返回原文 chunk（local KB 用）
export function readFileToChunks(absPath, chunkSize, chunkOverlap): Chunk[] {
  const text = fs.readFileSync(absPath, 'utf-8'); // 原文，不清洗
  return splitIntoChunks(text, { chunkSize, chunkOverlap });
}

// 向量化前单独清洗（vectorize 阶段调 cleanMarkdownText）
// import.ts:280 bulkVectorize(entries) → entries.map(e => ({...e, text: cleanMarkdownText(e.text)}))
```

**优势**：
- local KB 存原文 chunk（每个 chunk 一段，不膨胀，语义正确）
- 向量 content 用清洗后 text（REQ-06 目标达成）
- 修复 B1 且不引入 O1 副作用
- 落点变化：清洗从"readFileToChunks 内"移到"向量化前"，但仍集中

**代价**：`incremental.ts` 的向量化路径也需同步清洗（line 367 `bulkVectorize` 前清洗）；`path-vectorize` 的 relation content 是命名（`文件名-N`）不需清洗

### A2 方案 B 兜底：REQ-002 从源文件读原文

若方案 C 不采纳，REQ-002 改为从 `sourceDir + 文件路径`（去掉 `#N`）读原文。**风险**：导入后源目录被删/移动 → 不可达 → 降级提示。依赖 `scope.sourceDir` 配置可达性，脆弱。

## 认可点

### R1 B1 根因证据充分（✅）

推演报告 B1 的源码证据链完整：`deriveChunkSourcePath`（import.ts:157-159）→ `e.path` 含 `#N` → `phase4WriteRelations`（import.ts:479-486）`fs.existsSync` false → 降级 `e.text` = `chunk.text`。经 `writeLocalKb` 调用点搜索（仅 import.ts:487 + incremental.ts:382）证实无遗漏。根因判定成立。

### R2 B1 影响面限定准确（✅）

`writeLocalKb` 仅 scan-kb import 链路（full + incremental）使用 chunk.text；`sync-relation` 链路（mcp-tools/sync-relation.ts）走用户传入的 `module_info`，不经 `readFileToChunks`，不受清洗影响。B1 不是全面灾难，影响面限定正确。

### R3 🔴 定级合理（✅）

B1 当前不破坏已实现功能（清洗未实施），但破坏 REQ-002（已立需求草案）的设计前提。属"设计阶段数据契约冲突"，按推演规则"局部通过但破坏全局/其他需求前提"定 🔴 合理。推演报告未过度定级。

## 补充场景

### S8 清洗规则与 path-vectorize 的交互（🟢 低）

`path-vectorize.ts` 的 `ki-relation` 路径向量用 `buildRelationContent(chunkRelation, groupPath)` 构造，content 是命名（`文件名-N`）非正文。清洗不影响 path-vectorize（它不读 chunk.text 正文）。方案 C 不需改动 path-vectorize。✅

## 风险评估

| # | 质疑点 | 风险 | 处置 |
|---|--------|:----:|------|
| O1 | 方案 A 副作用（膨胀+语义错配） | 🟡 中 | 弃用方案 A，采纳方案 C（用户澄清确认） |
| O2 | 清洗函数异常未兜底 | 🟡 中 | `cleanMarkdownText` 加 try-catch，失败降级返回原文 |
| R1 | B1 根因 | ✅ | 认可 |
| R2 | 影响面限定 | ✅ | 认可 |
| R3 | 🔴 定级 | ✅ | 认可 |

**整体质疑结论**：推演报告核心结论（B1 🔴 阻断）成立。用户已澄清确认方案 C（local KB 存原文 chunk、清洗只作用于向量化）为确定方向——`readFileToChunks` 不内嵌清洗，清洗移到向量化前。调研文档 §5 落点建议需修订为"向量化前清洗"。方案 A 弃用。同时补 `cleanMarkdownText` 异常兜底。

> 证据性质：基于源码推理（未实际执行）。方案 C 的向量化清洗路径需 demo-verify 验证 `bulkVectorize` 入口可注入清洗。
