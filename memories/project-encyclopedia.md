# 项目百科全书（`${scope}-memory`）

> **`${scope}-memory` = AI 的项目百科全书。不懂就查，有新发现就写入，维护好它持续提效。**

---

## 1. 判断：该走哪条路

| 信息类型 | 走哪个 | 说明 |
|----------|--------|------|
| 代码要点（函数/流程/工具/模式） | `snippet-memory` → `ki_sync_relation` | 一句话说得清的关键代码信息 |
| 模块架构、API 设计 | `codekb-skill` | 需要段落描述的架构知识 |
| 项目背景、进度、偏好 | `memory-skill` | 项目上下文级信息 |
| 找具体文件/符号 | grep / SearchSymbol | 直接定位，不绕路 |

---

## 2. 写入：该记什么、怎么归类

### 强制要求

**禁止纯文字总结。** 必须包含：

| 必须 | 示例 |
|------|------|
| 文件路径 | `src/utils/hash-ring.ts` |
| 类名/方法名 | `HashRing.getNode(key)` |

> ❌ 废话：*"提供一致性哈希环，支持虚拟节点和二分查找"*
> ✅ 可用：*`src/utils/hash-ring.ts` — `HashRing` 类：`getNode(key: string)` 二分定位、`addNode(addr, weight)` 配权重*

### 归类原则

**禁止全部扔进"通用记忆片段"。** 思考最适合的 Group → 没有则新建 → 实在不行才兜底。

| 内容 | 优先归到 |
|------|----------|
| 工具函数/脚本 | `工具库` |
| 踩坑/注意事项 | `项目踩坑点` |
| 构建/调试命令 | `常用命令` |
| 部署/环境 | `部署运维` |
| 需求记录 | `最近需求` |
| 完成状态 | `进度` |
| 实在无法归类 | `通用记忆片段`（仅兜底） |

```bash
# 通用写入模板（scope 始终用 ${scope}-memory）
ki sync-relation --scope ${scope}-memory --group "目标Group" \
  --relation "标题（需求加日期前缀 [YYYY-MM-DD]）" \
  --module-info "内容（必须含文件路径+类/方法名）" \
  --keywords "关键词1,关键词2"
```

> 需求写入 `最近需求`，进度写入 `进度`。写完记得同步 AGENTS.md（追加 + 删超过 7 天的）。

---

## 3. 查询：疑问排查优先级

| 优先 | 动作 | 命令 |
|------|------|------|
| 1 | 查项目记忆 | `ki_query_group` scope=`${scope}-memory` |
| 2 | 查知识库记忆 | `ki_query_group` scope=`${scope}` |
| 3 | 代码搜索 | grep / SearchSymbol |
| 4 | 语义兜底 | `ki_search` |

---

## 4. 收尾：会话转折点主动执行

**触发信号**：用户说"好/OK/可以"、"记录一下"、"开始写代码"、"下一个"。

```
□ 有新需求？→ ki_sync_relation → 最近需求 + 同步 AGENTS.md
□ 有代码要点？→ ki_sync_relation → 对应 Group
□ 进度变了？→ ki_sync_relation → 进度
□ 索引变了？→ agents-md-init 更新
□ 7 天前的？→ 触发归档
```

---

## 5. 禁忌

| # | 红线 |
|---|------|
| 🔴 | 将代码/架构知识存入平台记忆 → **走 ki** |
| 🔴 | 将通用偏好存入 ki → **走平台记忆** |
| 🔴 | 跳过 ki-foundation 直接用 codekb/memory-skill |
| 🔴 | scope 未确认就执行 ki 命令 |
| 🔴 | 对 ki scope 用 memory MCP（禁止 `memory_store`/`memory_recall` 等） |
| 🔴 | 忽略 AGENTS.md：对话开始必须检查缓存，索引变更必须同步 |
| 🔴 | 等用户提醒才记录：AI 必须**主动识别**并写入 |
