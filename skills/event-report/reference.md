# event-report 参考手册

> SKILL.md 只讲怎么做决策；本文件放对照表、参数上限、错误码与历史教训。**以 `ki_event_type_list` 的实际返回为准**，下表如与线上不一致，以线上为准。

---

## 1. 内置事件类型与阶段链

| id | 名称 | 阶段链 | 可见性递进 | 收口动作 |
|---|---|---|---|---|
| `et_1` | bug 排查 | 排查中 → 已定位 → 修复中 → 已关闭 | hidden → fts-only → fts-only → full | `keep`（回长期保留并解绑） |
| `et_2` | 性能优化 | 分析中 → 优化中 → 已验证 → 已完成 | 按类型配置，用 `ki_event_type_list` 查 | **`trash`（关联文档进回收站）** |
| `et_3` | 需求实现 | 实施中 → 联调中 → 已上线 | 按类型配置，用 `ki_event_type_list` 查 | `keep` |

**三条读法**：

1. 末位 = 终态，末位不可停用；到终态即"收口"，`closedAt` 落值。
2. 可见性是**按阶段逐步放开**的：首阶段常常 `hidden`（语义与全文都搜不到，按名仍可 `ki_get_module_info` 读取）。
3. **类型可自定义，但只能人在页面建**（MCP 无建类型工具）。所以"没有合适的类型"不是建类型的理由，是选最接近类型的理由。

---

## 2. 工具速查

| 工具 | 必填 | 可选 / 限制 | 关键副作用 |
|---|---|---|---|
| `ki_event_type_list` | — | — | 只读，返回阶段链 + 收口动作 |
| `ki_event_list` | — | `status`(open/closed/all) / `type` / `q` / `limit`≤100 / `offset` / `docs_preview_limit`≤10 / `locations_preview_limit`≤10 | 只读 |
| `ki_event_get` | `event` | `members_limit` / `refs_limit` / `logs_limit` / `locations_limit` / `location_snippet_limit`（均 0 = 不返回该块） | 只读；**list 用来找，get 用来读**。返回描述全文、结论全文、未确认点、已确认位置、文档三元组（scope+group+name，可直接 `ki_get_module_info` 取正文）；过程与候选正文不返回 |
| `ki_event_create` | `title` / `type` | `description`≤4000 / `stage` / `docs`≤50 / `refs`≤50 | 写事件 + 阶段日志（`by: 'ai'`） |
| `ki_event_set_stage` | `event` / `stage` | `note` | 唯一的状态写工具；到终态按 `terminalAction` 处理成员文档 |
| `ki_event_docs` | `event` / `action` / `docs` | `docs`≤50 | **add 会把文档分类改为 `event`，可见性随阶段走**；只用于产物文档，且必须在推终态之前 |
| `ki_event_refs` | `event` / `action` / `docs` | `docs`≤50 | 只建引用；与关联文档冲突的项会被拒 |
| `ki_event_delete` | `event` / `doc_action` | `doc_action`: `wiki` \| `trash`；`force` + `confirm_title`（仅**无关联文档**的事件） | **事件须已收口**；清理测试空事件可 `force` + 标题逐字一致；有成员文档时拒绝（先解绑或先收口） |

- `event` 两种写法都行：事件 id（`evt_…`）或 `#shortId`（如 `#37`）。
- `stage` 两种写法都行：阶段 key（`st_3`）或阶段名（`已定位`）；**名称重名时不猜**，报错请改传 key。
- 阶段的"名"可能被人在页面改过，key 不会变。跨会话长期引用请用 `#shortId` + key。

---

## 3. 异常对照

| 返回 | 含义 | 正确处置 |
|---|---|---|
| `EVENT_NOT_FOUND` | 事件不存在（`ki_event_get` / `ki_event_list` 定位失败） | 先用 `ki_event_list(q: 关键词)` 找；`event` 三种写法都支持：`evt_…` / `#3` / `3` |
| `TYPE_NOT_FOUND` + `available` | 类型名不存在或重名 | 改传 id（`et_1`），不猜 |
| `STAGE_NOT_FOUND` | 阶段名 / key 不对 | 先 `ki_event_type_list` 取真实阶段 |
| `STAGE_DISABLED` | 阶段已停用 | 换下一个可用阶段或问用户 |
| `STAGE_UNCHANGED` | 目标阶段 = 当前阶段 | 无需操作，别重试 |
| `EVENT_CLOSED` | 事件已收口 | 停手；重新打开只能在页面 |
| `EVENT_DESCRIPTION_TOO_LONG` | 描述 > 4000 字 | 压缩，保住"来源 / 现象 / 为何不做"三段 |
| `EVENT_MEMBER_LIMIT_EXCEEDED` | docs > 50 | 拆成多次或减少关联 |
| `REF_LIMIT_EXCEEDED` | refs > 50 | 同上 |
| `EVENT_FORCE_CONFIRM_REQUIRED` | 传了 `force` 但没带 `confirm_title` | 按报错回显的标题原样传 |
| `EVENT_FORCE_CONFIRM_MISMATCH` | `confirm_title` 与标题不一致（一条都没删） | 用报错里的真实标题重试 |
| `EVENT_FORCE_NOT_EMPTY` | 事件还有关联文档，`force` 不适用 | 先 `ki_event_docs remove` 解绑，或走正常收口 |
| 403 权限 | 无 `knowledge.write` | 明确告知，不绕过 |
| 工具不存在 | 只读会话（写工具不注册） | 列"应上报项"，不重试 |

---

## 4. 事故案例

### 案例 1：把已有知识挂成 `docs`，它在首阶段从检索里消失了（事件 #37）

**经过**：给事件挂关联文档后，文档分类变为 `event`，可见性随首阶段 `hidden` 走 → 语义与全文检索都不再召回；同时向量删除侧校验缺失，造成"文档已 hidden，但检索仍能召回"的复合故障。

**教训**：
- 挂 `docs` 是**归属操作**：会改分类与可见性，不是"顺手关联"——**只对产物文档做**（SKILL §5 三分法）。
- 看到 `fts-only` / `hidden` 时先想"这是阶段设计的预期行为"，不要当写入失败反复重试（工具返回值里有 `visibility` 与 `hint`）。
- 已收口事件挂不了文档（`EVENT_CLOSED`），所以「推到终态再挂 docs」不是可用路径；正确顺序是**先挂后推**。

### 案例 2：已修复，事件仍停在「修复中」（事件 #36 / #37）

**经过**：两起修复合计在项目台账里都记了 ✅ 已修复，事件页却仍显示「修复中」——上报做了，收口没做。

**教训**：上报与收口必须成对。只建不推 → 事件页失真 → 下一个人不知道它到底做完没有 → 有人重复排查。

---

## 5. 存量清账清单（一次性 / 定期）

```
① ki_event_list(status: "open", limit: 100)
② 逐条对照真实工作状态（项目台账 / git log / 报告目录）
③ 已完成 → ki_event_set_stage 推到终态（先看 terminalAction 是否是 trash）
④ 已废弃 → 在 description 补一句原因 + 推到终态说明"不做"；不静默删
⑤ 长期停在同一阶段 → 要么推进一步，要么写清"暂缓原因"
⑥ 清账后回一行：本次推进 N 条、发现状态失真 M 条
```

> 事件删除要求先收口（`ki_event_delete` 对未收口事件会拒），所以"删掉"永远不是清账的第一步。

---

## 6. 类型选择口诀

| 现象 | 类型 | 描述首行补充 |
|---|---|---|
| 功能不符合预期、报错、数据不对 | `bug 排查` | — |
| 慢 / 内存 / CPU / 容量 / 索引膨胀 | `性能优化` | — |
| 缺功能、要改造、要新增入口 | `需求实现` | — |
| 文档过期、索引漂移、知识治理 | `需求实现` | `分类：知识治理` |
| 技术债、重构、依赖升级 | `需求实现` | `分类：技术债` |
| 安全 / 权限缺口 | `bug 排查` | `分类：安全` |

判据不是"标题像不像"，而是**这条事要按什么节奏推进**：排查类要快速定位、优化类要对比数据、需求类要联调上线。节奏错，阶段链就错。

---

## 7. 记忆 / 事件 / 台账三方对照

| | 记忆 relation | 事件 | 台账（`.plans/` / `.debug/`） |
|---|---|---|---|
| 回答什么 | 结论是什么 | 这件事做完了吗 | 这件事怎么做 |
| 有无终态 | 无 | 有阶段与收口 | 有完成判据 |
| 谁消费 | 下次检索的 AI | 事件页、下一个接手的人 | 执行者自己 |
| 典型内容 | "该库不支持并发写" | "hidden 文档仍可被语义召回" | 7 批实施计划 |

选错载体的典型症状：把待办写进记忆（永远没人做）、把结论建事件（永远收不了口）、把计划写进事件描述（事件页变成草稿纸）。
