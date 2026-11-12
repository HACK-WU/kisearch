# 需求：文档「移动」到其他 Group（含移动时改名）

- 需求 ID：REQ-20261112-002
- 提出日期：2026-11-12
- 状态：**已实施**（未提交；4 条拍板全部落定，验证见 §8）
- 模式：product-manager M1 一次成型档 → design-craft（单文档通道）
- 证据声明：最高 🟢（代码直读：`src/lib/document-editor.ts`、`src/delete-relation.ts`、`src/sync-relation.ts`、`src/lib/fts-client.ts`、`src/lib/vector-client.ts`、`src/lib/wiki-sync.ts`、`src/lib/import.ts`、`src/lib/datasource*.ts`、`web/src/components/ModuleDrawer.tsx`）。界面图经用户确认；**移动交互未做运行实测**，视觉与手感待实施后走查。

## 1. 用户诉求（原话）

> 新增一个移动按钮，用于移动文档到其他group路径中。

补充（2026-11-12）：

> Q2 提示修改名称，然后可以填入"新名称"
> Q3 同意（数据源文档禁止移动）
> Q4 同意（wiki 源文件跟着移动）

界面证据：浏览页阅读态一行头部工具条（全部标签 / 搜索全库文档 / 全库·本文 / 清空 / 居中·铺满 / 添加链接 / 编辑文档 / 复制 / ⤴全屏）。

## 2. 现状（🟢 代码直读）

```
文档的一次「挪动」在生产上等于跨 5 处一致迁移
├─ 本地 KB 正文    <kbDir>/<group>/index.json 的 {relation: 原文} map     scope.ts:115
├─ 元数据分片      <scope>/.relations/<group>/cache.json                  group-cache.ts:48
├─ Group 树        <scope>/group-index.json                              scope.ts:205
├─ 索引
│  ├─ FTS docId = sha256(scope+group+relation+tag+text)  ⇒ 移动必然换 id   fts-client.ts:82
│  ├─ 内容向量 docId = sha256(text+scope+tag)（不含 group），group 是标量字段  vector-client.ts:594
│  └─ ki-relation 文本含 group；ki-path 每组一条                          import.ts:1850
└─ wiki 回写文件   {wikiSync.sourceDir}/{group}/{relation}.md             wiki-sync.ts:12

现状缺什么（四处全缺，不是只缺前端）
├─ HTTP：route-permissions.ts:36-109 无 move 路由
├─ MCP ：mcp-server-factory.ts:50-66 十四个工具无 move
├─ CLI ：src/doc.ts:172-246 只有 list / delete
└─ 前端：ModuleDrawer 只有 添加链接 / 编辑文档 / 复制
```

数据源相关（决定 Q3）：数据源同步**不做内容查重**（`datasourceSyncParams` 不带 `skipDuplicates`，`skipDuplicates` 仅上传导入路径启用）⇒ 移动一篇数据源文档后，下次同步会在原组重新导入一份。清 `sourcePath` 无法阻止，故只能禁止移动。

## 3. 拍板（2026-11-12）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 目标 Group 能否新建 | **复用上传导入页的 `GroupPathSelect`**（非 selectOnly）⇒ 可输入新路径新建 |
| Q2 | 目标组同名文档 | **提示改名**：弹窗内给「文档名称」输入框，默认当前名，用户可改成新名称后提交（服务端支持 `targetRelation`） |
| Q3 | 数据源管辖的文档 | **禁止移动**（409 `DATASOURCE_BLOCKED`），指路去数据源页调整结构 |
| Q4 | wiki 源文件 | **跟着移动**（物理 rename，内容零改写），失败即整体失败 |
| Q5 | 术语 | 统一「Group 路径」 |
| Q6 Q7 | 历史链接 / AI 引用 | 只提示不重写；历史引用按当时快照语义接受 |

## 4. 界面（已确认）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 文档 / alert-search-v2-performance-20261112                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ [全部标签▾] [🔍 搜索全库文档……] [全库│本文] [清空] [居中│铺满]                │
│                        [添加链接] [编辑文档] [移动] [复制] [⤢ 全屏]           │
└──────────────────────────────────────────────────────────────────────────────┘
  窄容器（≤700px）：「添加链接 / 编辑文档 / 移动 / 复制」收进「⋯」菜单
```

移动弹窗：文档名 + 当前 Group 只读 → 「文档名称」可改（Q2）→「目标 Group 路径」（复用导入页选择器）→ 冲突/后果提示 → 取消 / 移动。

## 5. 设计

### 5.1 接口

`POST /api/doc/move`

```jsonc
// 请求
{ "scope": "k8s", "group": "wiki/预警分析", "relation": "alert-search-v2",
  "targetGroup": "stages/3-网络与服务暴露", "targetRelation": "alert-search-v2", // 可选，缺省同名
  "expectedRevision": "sha256:…" }                                              // 可选
// 200
{ "ok": true, "data": { "from": {...}, "to": {...}, "source": { "moved": true, "from": "...", "to": "..." },
                        "reindexed": { "indexMode": "dense" }, "warnings": [] } }
```

错误码：`DOC_ID_INVALID`(400) · `SAME_TARGET`(400) · `DOC_NOT_FOUND`(404) · `TARGET_EXISTS`(409) · `SOURCE_EXISTS`(409) · `REVISION_CONFLICT`(409) · `DOC_EDIT_IN_PROGRESS`(409) · `DATASOURCE_BLOCKED`(409) · `SCOPE_READONLY`(403) · `MOVE_INDEX_FAILED`(500) · `MOVE_PARTIAL`(500)

### 5.2 迁移顺序（实现取舍）

复用两条已测链路而不是重写：写入走 `executeSyncRelation`（含组树补建 / KB / 分片 / 向量 / FTS），清除走 `executeDeleteRelation`（`wikiDelete:false`）。

```
预检（全只读，任何一条不过即失败，此时零改动）
├─ 源文档存在 / revision 匹配 / 目标组无同名 / 非数据源管辖 / 无在途草稿
└─ wiki 源文件：定位成功且目标路径未被占用
        ↓
① 源文件 rename（物理移动、内容零改写；失败=整体失败，无需回滚）
        ↓
② executeSyncRelation(skipWikiWriteback:true, sourcePath:新相对路径)  → 目标组落地 + 重建索引
        ↓ 失败 → rename 回滚 → MOVE_INDEX_FAILED
③ executeDeleteRelation(wikiDelete:false)                            → 旧组清除（不碰文件）
        ↓ 失败 → 删新组（wikiDelete:false）+ rename 回滚 → MOVE_PARTIAL
④ docListCache 失效 + 前端 invalidate
```

关键取舍：
- **不做跨链路事务**：两条链路各自已是原子提交，中间窗口只有「两边都能查到」的瞬时重复（可恢复），不会出现「哪边都没有」。
- **先搬文件再写库**：文件是唯一的仓库外副作用，放最前，失败时 ki 侧零改动、无需回滚。
- `skipWikiWriteback` 必须开：`writeBackToWiki` 会用 `generateMarkdown` **重新生成**内容（补 front-matter/标题），与「移动文件」语义不符。

### 5.3 改动文件

```
src/
├─ lib/doc-move.ts                 [新增] 预检 + 编排 + 回滚
├─ sync-relation.ts                [修改] 参数加 sourcePath / skipWikiWriteback
├─ lib/mcp-http-api.ts             [修改] POST /doc/move
├─ lib/auth/route-permissions.ts   [修改] 登记 knowledge.write
├─ lib/scope-policy.ts             [修改] BLOCKED_OPS 加 doc-move-write
└─ test/doc-move.test.ts           [新增]

web/src/
├─ api/httpApi.ts                  [修改] moveDocument()
├─ components/DocMoveDialog.tsx    [新增]（复用 GroupPathSelect）
├─ components/ModuleDrawer.tsx     [修改] 按钮 + ⋯ 菜单 + 弹窗
├─ pages/BrowsePage.tsx            [修改] 移动后 URL / 目录 / 列表跟随
├─ styles/ki.css                   [修改] 弹窗样式 + 收起阈值 620→700
└─ test/doc-move-ui.test.mjs       [新增] 源码守卫
```

## 6. 负向需求

N1 目标 = 当前 → 400 `SAME_TARGET`，按钮前置禁用 · N2 同名 → 提示改名，服务端 409 兜底 · N3 中途失败 → `MOVE_INDEX_FAILED` / `MOVE_PARTIAL` 带阶段与重试提示，不静默 · N4 只读库 → 按钮置灰 + 403 双闸门 · N5 在途草稿 → 409 指路先收口 · N6 非法路径（`__root__` / `..` / `\`）→ 400 · N7 并发 → `expectedRevision` 失配 409 · N8 移动后旧 URL → 前端跟随写回新 URL，不留在空态。

## 7. 缺口回扫（六维）

场景完整性 ✅（纠错型移动 / 目录重组 / 组合并）· 验收可达性 ✅（旧组查不到 + 新组可检索 + 只提示的引用不改）· 需求一致性 ✅（Q3 禁止 vs Q4 mv 已分轨）· 角色对齐 ✅ · 边界覆盖 ✅（N1–N8）· 术语 ✅（Group 路径）。

## 8. 验证（2026-11-12 实施后）

| 项 | 结果 |
|---|---|
| 后端构建 | `npm run build`（tsc -p tsconfig.src.json）**exit 0** |
| 后端单测 | `test/doc-move.test.ts` **7/7**（四层一起动 / 改名 / SAME_TARGET / TARGET_EXISTS / 移动到根目录 / DATASOURCE_BLOCKED / SOURCE_EXISTS） |
| 既有后端回归 | `test/scope-readonly.test.ts` 7/7、`test/mcp-http-api.test.ts` 66/66 |
| 前端构建 | `npm run build`（tsc --noEmit + vite build）**✓** |
| 前端单测 | web `npm test` **1129/1129**（含新增 `doc-move-ui.test.mjs` 6/6 源码守卫） |
| 真机走查 | **未做**（需要重启 7423 daemon 才载入新路由；待用户确认后执行移动 → 刷新 → 数据源同步 → 编辑保存全链） |

### 复审（auto-review + challenger）修掉的 5 个问题

| # | 级别 | 问题 | 修法 |
|---|---|---|---|
| 1 | 🔴 高 | **移动会把刚写好的内容向量删掉**：内容向量 docId = `sha256(text+scope+tag)` **不含 group/relation**（`vector-client.ts:594`），内容没变 ⇒ 新位置写的是同一批 id，而旧记录删除时按 `memoryIds` 再删一次 ⇒ 语义检索静默搜不到（cache 仍宣称已向量化）。**原测试全用 FTS-only 记录，完全没覆盖 dense 路径** | `DeleteRelationParams.skipDenseDelete`（含跳过 `deleteBySearch` 兜底），移动的三处删除（前向 / 失败清理 / 回滚）全部开启；新增用例 8 |
| 2 | 🟡 中 | 写目标失败时 sync 可能已落了 KB+分片（分步写），回执却只说"源文件已回滚" | 失败路径先清理目标副本，再按**实际残留**（重新读分片）给文案 |
| 3 | 🟡 中 | 移动成功提示会随重挂载丢失：`ModuleDrawer` 的 `key` 含 group/relation ⇒ 整块重挂载，组件内 `savedNotice` 属于旧实例 | 回执改由页面持有 + 新实例 `initialNotice` 消费一次 |
| 4 | 🟡 中 | 弹窗没有 Esc：阅读器的 Esc 链因 `moveOpen` 早退 ⇒ 按 Esc 毫无反应 | 弹窗在**捕获阶段**接 Esc 并阻断传播 |
| 5 | 🟡 中 | 违反既有守卫：BrowsePage 用 `groupDisplayName`、移动弹窗路径段显示「根 / 名称」 | 回执用 `ROOT_GROUP_FIELD_LABEL`、弹窗用 `groupPathSegment`；`root-group-display` 守卫加入 DocMoveDialog |

**记录不改（低风险）**：`id` / `useCount` / `lastUsedTime` / `isImported` 不随移动保留（sync 新建记录 ⇒ 热度归零、导入标记丢失，仅影响展示）；`ki-relation` 未改名时因跨组共享保护保留旧组足迹；`ki-path` 本就不由 sync 维护（既有行为）。

### 实施中修正的偏差

1. **Q3 的方案在实施前被推翻一次**：原设想「允许移动数据源文档 + 清 `sourcePath` 解除关联」。读码发现数据源同步**不做内容查重**（`datasourceSyncParams` 不带 `skipDuplicates`，该开关只在上传导入路径），清 `sourcePath` 无法阻止下次同步重新导入 ⇒ 只有「禁止移动」是诚实的，已按用户 Q3 落成 409。
2. **`writeBackToWiki` 会重新生成内容**（`generateMarkdown` 补 front-matter/标题）⇒ 移动若走它就不是"文件搬家"。为此给 `SyncRelationParams` 加了 `skipWikiWriteback`，移动自己 `rename` 文件后再跳过写回。
3. **移动无法复用 `POST /api/doc/edit`**：它在目标组不存在时 `loadDocument` 直接 404（`document-editor.ts:63`）⇒ 必须新增路由。
4. ~~**根目录（`__root__`）不可作为目标**~~ → **同日追加：用户要求「增加一个通用的根目录，这样就可以移动到 `__root__` 下」**，已放开：
   - 组件级通用开关 `GroupPathSelect rootOption={{ value, label }}`（传了才显示，**只有移动弹窗开启**；导入页/写入页「留空」本身就是根，多一个选项会让人分不清，已加测试挡回退）
   - 保留键不铺给用户：选中根时输入框留空 + 占位显示「根目录（不分组）」，底部显示「✓ 已选：根目录」
   - 后端 `SyncRelationParams.allowRootGroup` 放行保留键（**只有移动开**），且**不打 `groupSource: 'scope-fallback'`** —— 显式选择 ≠ 缺省兜底
   - 源侧仍拒绝「根目录下的文档」（删除链路按 Group 树定位，根没有稳定树节点），文案明确指路
5. **窄屏收起阈值 620 → 700**：第 4 枚文字动作 +76px，宁可早收起（多点一次 ⋯）也不折行。

