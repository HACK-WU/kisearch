---
name: agents-md-init
description: 初始化或更新项目根目录的 AGENTS.md 文件。填充 ${scope}-memory 项目记忆索引、用户画像、近期工作等章节。仅当用户明确说明要初始化或刷新 AGENTS.md 时才调用，禁止 AI 自动触发。
---

# agents-md-init AGENTS.md 初始化

> **前置条件**：AI 已了解 ki MCP 工具。AGENTS.md 位于项目根目录。
> **格式模板**：完整 AGENTS.md 模板见 [AGENTS-template.md](AGENTS-template.md)，本文件不内嵌模板。

---

## 1. 概述

**目的**：自动维护 AGENTS.md 文件，确保其中的索引信息与实际 ki 数据保持一致。解决规则文件中嵌入模板导致的内容混乱问题。

**功能**：
- 用户手动触发时创建/更新 AGENTS.md（如用户说"初始化 AGENTS.md"、"刷新缓存"）
- 查询 ki 获取真实索引数据填充项目记忆索引（`${scope}-memory`）
- 代码知识库（`${scope}`）索引不写入 AGENTS.md，查询走 `codekb-skill` 直连 ki
- 用户画像与近期工作直接存储于 AGENTS.md，不依赖 ki
- 无真实数据时用示例格式兜底（标注 ⚠️）
- 同步近期工作记录（7 天内）
- 索引变更后自动刷新

**使用场景**（用户手动触发）：
- 首次对话，用户要求初始化 AGENTS.md
- 索引变更后用户要求刷新缓存
- 手动触发"初始化 AGENTS.md"、"刷新缓存"
- ki 中无任何 scope 时引导用户创建

---

## 1.5 首次使用引导

> **当 `ki_manage_index_list` 返回空列表时，AI 应主动引导。**

```
① ki_manage_index_list → 无任何 scope
    ↓
② 主动提示用户：
    "检测到项目尚未配置 ki 索引。是否需要我帮你初始化？"
    ↓ 用户确认
③ 确定 scope 名称（默认取项目目录名的小写简写）
④ ki_manage_index_create(scope, name: "项目概述")
⑤ ki_manage_index_create(scope: "${scope}-memory", name: "背景与目标")
⑥ 执行完整初始化（步骤 2.1）
```

> 用户拒绝则跳过，后续按需触发。
> 用户画像与近期工作（最近需求/进度）不再创建对应 scope/Group——直接写入 AGENTS.md 的"用户画像"/"近期工作"章节。

### 异常处理

若本 skill 文件不存在（如新克隆项目）：跳过 AGENTS.md 初始化，后续用户明确要求时再按需处理（kisearch 缺失由 `ai-codekb-memory` 规则提示安装）。

---

## 2. 初始化流程

> **仅当用户明确说明要初始化或刷新 AGENTS.md 时才执行，禁止 AI 自动触发。**

```
用户明确要求后
    │
    ├── AGENTS.md 不存在？
    │       └── 是 → 执行完整初始化（步骤 2.1）
    │
    ├── AGENTS.md 存在但无"项目记忆索引"章节？
    │       └── 是 → 执行完整初始化
    │
    └── AGENTS.md 存在且完整？
            └── 检查索引一致性 → 不一致则增量更新
```

### 2.1 完整初始化

```
① ki_manage_index_list → 获取所有 scope，识别 ${scope}-memory 项目记忆 scope
② 对每个 ${scope}-memory 执行 ki_query_group(mode: "full,depth=4") → Group 结构
③ 对每个 ${scope}-memory 执行 ki_query_group(mode: "hot,hot_count=3") → 热门 Relation
④ 用户画像与近期工作 → 直接写入 AGENTS.md 对应章节（空模板 + 预定义维度）
⑤ 写入 AGENTS.md（参考 AGENTS-template.md）
```

> 代码知识库 `${scope}` 的索引不初始化到 AGENTS.md，仅缓存 `${scope}-memory` 项目记忆索引。

### 2.2 增量更新

当 AGENTS.md 已存在但部分过期时：

```
① 读取 AGENTS.md，提取已有的 ${scope}-memory 列表
② ki_manage_index_list → 获取最新 scope 列表，识别 ${scope}-memory
③ 对比差异：
   - 新增 ${scope}-memory → 补充对应章节
   - 删除 ${scope}-memory → 移除对应章节
   - Group 结构变更 → 更新对应章节
④ 检查项目记忆预定义 Group 是否存在，缺失则初始化（见 §项目记忆索引）
⑤ 检查"近期工作"时间戳 → 超过 1 天则刷新（直接维护 AGENTS.md 章节）
⑥ 用户画像 → 保持 AGENTS.md 中已有内容，不重复初始化；仅当维度缺失时补充小节
```

---

## 3. AGENTS.md 格式模板

> **完整模板见 [AGENTS-template.md](AGENTS-template.md)**，本文件只描述结构与维护规则。

模板章节结构：

```
# AGENTS.md - AI AGENT 项目记忆文件
├── 项目记忆索引      # ki ${scope}-memory scope（Group 结构 + 热门 Relation）
├── 用户画像          # 直接存储，不走 ki（沟通偏好/代码风格/工具链/技术背景/工作习惯/对话习惯）
├── 近期工作 (7天内)  # 直接存储，不走 ki（最近需求 + 进度，超期移入 archive.md）
└── 更新日志          # 最近 10 条变更记录
```

> 代码知识库（`${scope}`）索引不写入 AGENTS.md。

---

## 3.5 直接存储章节维护（用户画像 + 近期工作）

> **用户画像与近期工作均不再使用 ki scope/Group，直接存储在 AGENTS.md 对应章节。**

### 用户画像

#### 预定义维度

```
沟通偏好/  代码风格/  工具链/  技术背景/  工作习惯/  对话习惯/
```

#### 写入规则

- 对话中发现用户偏好 → 直接更新 AGENTS.md 对应小节（覆盖写入）
- 维度缺失 → 新增小节（命名保持 4-8 字名词短语）
- **不执行任何 ki MCP 调用**

#### 读取规则

- 对话开始 → 读取 AGENTS.md"用户画像"章节，加载用户偏好
- 无需任何 ki 查询

### 近期工作（最近需求 + 进度）

#### 写入规则

- 新需求 → 在 AGENTS.md"近期工作 → 最近需求"小节追加 `[YYYY-MM-DD] {描述}`（1-2 句话）
- 进度变化 → 更新"进度"小节（进行中 🔄 / 已完成 ✅）
- **不执行任何 ki MCP 调用**（无"最近需求"/"进度" Group）

#### 过期清理

- 最近需求/已完成进度超过 7 天 → 移入项目根目录 `archive.md`（按日期分组追加）
- 进行中进度永久保留

---

## 4. 真实数据 vs 示例数据

> **优先使用 ki 中的真实数据。仅当 ki 中无对应 scope 时，才使用示例格式兜底。**

### 有真实数据时

- `${scope}-memory` 列表 → 来自 `ki_manage_index_list`
- Group 结构 → 来自 `ki_query_group(mode: "full")`（仅 ${scope}-memory）
- 热门 Relation → 来自 `ki_query_group(mode: "hot")`（仅 ${scope}-memory）
- 近期工作 → AGENTS.md 内已有内容（无 ki 数据源）
- 用户画像 → AGENTS.md 内已有内容（无 ki 数据源）

### 无真实数据时（示例兜底）

在对应章节使用 ⚠️ 标注：

```markdown
## 项目记忆索引

> ⚠️ 项目记忆索引为空，尚未创建任何项目记忆。
> 执行 `ki_manage_index_create` 创建 ${scope}-memory scope 后自动更新。

## 用户画像

> 用户画像直接存储于本文件。尚无已记录偏好，随对话逐步补充。
```

---

## 5. 近期工作维护

> **近期工作（最近需求/进度）直接存储于 AGENTS.md 的"近期工作"章节，不从 ki 提取。**

### 写入

- 新需求 → "最近需求"小节追加 `[YYYY-MM-DD] {需求描述（1-2句话）}`
- 进度 → "进度"小节：`进行中: [YYYY-MM-DD] 🔄 {描述}` / `已完成: [YYYY-MM-DD] ✅ {描述}`

### 过期处理

- 访问"近期工作"章节时检查：最近需求/已完成进度超过 7 天 → 移入项目根目录 `archive.md`
- 进行中进度永久保留

> archive.md 由 AI 直接读写（追加式，不删除历史），首次归档时自动创建。

---

## 6. 更新日志维护

每次修改 AGENTS.md 后，在更新日志中追加一条记录：

```markdown
| YYYY-MM-DD | {变更说明，如"初始化索引缓存"、"新增 scope: xxx"} |
```

保留最近 10 条日志，超出删除最早的。

---

## 7. 协同

- **与 `ai-codekb-memory` 规则**：本 skill 负责 AGENTS.md 的创建和格式维护（用户手动触发）；规则文件负责运行期行为决策（何时缓存、何时更新、如何沉淀/归档）。代码要点记忆存 `${scope}-memory`，与项目记忆索引共用同一 scope，片段格式见 `rules/ai-codekb-memory.md`"代码片段记忆"章节

---

## 8. 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | 用固定示例数据覆盖真实 ki 索引 |
| 🔴 2 | AGENTS.md 存在且完整时仍执行完整初始化（应增量更新） |
| 🔴 3 | 不检查 ki 数据直接写入示例格式 |
| 🔴 4 | 写入后不记录更新日志 |
| 🔴 5 | 近期工作记录超过 7 天不清理 |
| 🔴 6 | 将用户画像写入 ki 记忆的任何 scope（应存 AGENTS.md"用户画像"章节） |
| 🔴 7 | 在 ki 中创建/写入"最近需求"/"进度" Group（已迁移至 AGENTS.md"近期工作"章节） |
