---
task: 阅读页跳转链接交互按已确认 demo 对齐正式代码
status: 已评审（18/20 通过，2 条 P0 存疑待裁定）
updated: 2026-09-29
---

# 自评审清单：阅读页跳转链接交互按已确认 demo 对齐正式代码

> 用法：任务主体完成后逐条核验并回填证据；无证据视为未通过。严重度建档时定死，评审期只回填不改题。
> 结论三档：✅ 通过 / ⚠️ 存疑 / ❌ 未通过。排查手段不足时只能标 ⚠️。

## A 完成度

| # | 检查项 | 严重度 | 结论 | 证据 |
|---|--------|--------|------|------|
| A1 | plan.md 6 个工作项全部为「已完成」或有明确「取消」理由 | P0 | ✅ | 6 项全部「已完成」，无取消项 |
| A2 | 无「已改未验」遗留 | P0 | ✅ | 复跑证据：`flow.result.log` 全绿、`neg.result.log` 13/13、`editor.result.log` 2/2、`npm test` 28 passed |
| A3 | 完成判据 3 条逐条达成（真实链路 / 三项静态与测试全绿 / KB 已还原） | P0 | ✅ | 真实链路 `[jumped] scrollTop:1506`；`npm test` 28 passed + `tsc --noEmit` 退出 0 + `vite build` ✓ 376ms；`[verify-restore] {"identical":true,"revisionBack":true}` |

## B 正确性

| # | 检查项 | 严重度 | 结论 | 证据 |
|---|--------|--------|------|------|
| B1 | 全链路在真实浏览器跑通并留下可复现记录（截图或 DOM 断言输出） | P0 | ✅ | `./run.sh flow.mjs` 11 步 DOM 断言输出（`[panel]`→`[dialog-open] docs:110`→`[footer] 已选中段落中的位置`→`[saved] anchor=p-aa23996a0e56668a`→`[link-rendered]`→`[jumped]`→`[restored]`），脚本与日志都在 `e2e/` |
| B2 | 弹窗侧与阅读侧 anchor 一致性由单测覆盖（含列表项 / 表格单元格） | P0 | ✅ | `reader-links.test.mjs`「round-trips every selectable block kind」逐个覆盖 p/h/li/td/th 的 `anchorKind` + 哈希格式 + encode/parse 往返；「keeps anchors stable…」锁同文归一化与跨 kind 区分。代码侧两侧同调 `findAnchorBlocks`（见 E2） |
| B3 | 边界分支有处理：跨块选区、空选区、已有链接或代码内选区、重复段落 | P1 | ✅ | `neg.result.log` 前 6 条：跨块「请只选中同一标题、段落、列表项或表格单元格中的文字」、清空选区不弹面板、链接/代码内「已有链接或代码中的文字，请使用“编辑文档”处理」、重复段落「出现 6 次」且确认按钮 disabled |
| B4 | 失败分支有处理：外链非法、非编辑态、保存冲突重试、KB 已写源文件失败的部分写入 | P1 | ✅ | 非法外链「网址中不能有空格」；非编辑态无入口（`SearchPage` 不传 `editable`，按决策 #4 保持现状）；冲突→「保存失败：文档已被他人修改；可重试当前保存」+ 按 `editId` 复下单；部分写入→「KB 正文已更新，但源文件状态为failed」且不重试、只下一单 |
| B5 | 新增导出函数（`externalTarget` / `insertReaderLink`）有注释说明契约 | P1 | ✅ | `readerLinks.ts` 两导出各 1 行契约注释；`kiLinks.ts` 新增 `ANCHOR_SELECTOR`/`HEAD_PARA_SELECTOR`/`anchorKind`/`anchorBlock` 均带单行说明 |

## C 影响面

| # | 检查项 | 严重度 | 结论 | 证据 |
|---|--------|--------|------|------|
| C1 | 既有入口未被破坏：编辑文档「插入链接」下拉、搜索结果跳转、全屏阅读大纲 | P0 | ✅ | 被本次改动触碰的编辑器下拉有浏览器证据（`editor.result.log`：20 个锚点、全部 `^(p\|h)-[0-9a-f]{16}$`、未保存且 revision 未变）；搜索跳转与全屏大纲所在文件未被 diff 触及（`git diff --stat` 仅 5 个跟踪文件，无 `SearchPage.tsx`），其既有单测（`markdown-preview` / `editor-links` / `browse-group-tree`）随 `npm test` 28 passed 全绿 |
| C2 | 旧格式链接（a582d3b 之前写入的 `ki-link:` 与文档级无 anchor 链接）仍可解析跳转 | P0 | ⚠️ | 单测侧已锁（`keeps parsing links written before list and table anchors existed`：`h-` 锚点、无 anchor 的文档级、外链均 round-trip），浏览器侧 flow 深链为 `p-` 锚点并成功落地；**但当前 KB 内没有 a582d3b 之前写入的真实历史链接样本，未做端到端点击验证** → 手段不足，按规则只标 ⚠️ |
| C3 | 与 demo 的偏差已记入 plan.md「决策与偏差」 | P1 | ✅ | #3 anchor 种类放宽、#4 搜索页不做入口、#5 冲突重试用 mock 200；「demo 用序号锚点、正式代码必须单一来源」记在注意事项 #2 的来源列 |

## D 交付

| # | 检查项 | 严重度 | 结论 | 证据 |
|---|--------|--------|------|------|
| D1 | 提示文案与 demo 一致或更准确，无遗留占位词 | P1 | ✅ | `neg.result.log` 里逐字出现于真实页面：「这段文字在文档中出现 6 次，无法确定要跳向哪一处；请改选其他位置」「已有链接或代码中的文字，请使用“编辑文档”处理」「请只选中同一标题、段落、列表项或表格单元格中的文字」；页脚默认引导语与「已选中段落中的位置」见 flow/neg detail 行 |
| D2 | 未引入敏感信息（凭据 / 内网地址 / 个人数据） | P0 | ✅ | 产品代码 diff 无凭据与内网主机名；e2e 脚本只含 `127.0.0.1:7423/5188` 与本机路径，且位于 `.plans/`（不进前端构建产物） |
| D3 | 验证用文档已还原，`git status` 只剩预期改动文件 | P1 | ✅ | flow `[verify-restore] identical:true` + neg/editor 末条复核 revision `04522d65369d…`、正文无 `ki-link:`；`git status --short` = 5 个 M（含 `web/node_modules` 这条 worktree 符号链接差异，约定不提交）+ `.plans/` 与 3 个新增源文件 |

## E 护栏遵守（对应 plan.md「注意事项」）

| # | 检查项 | 严重度 | 结论 | 证据 |
|---|--------|--------|------|------|
| E1 | 是否守住：未改 `ki-link:` v1 协议字段与 `ANCHOR_PATTERN` | P0 | ✅ | 协议字段未动（`v/type/scope/group/relation/anchor`、16 位哈希长度、`ki-link:` 前缀编码原样）。`ANCHOR_PATTERN` 补齐 `li/td/th` 三个 kind **不算违反**：护栏 #1 与交接摘要本就写着 `p/h/li/td/th`，是 a582d3b 代码当时只实现到 `p/h`。使用者 2026-09-29 裁定接受，并把方向性写进护栏（kind 只可增加、不得删除或改写）。历史链接解析另有单测锁（见 C2） |
| E2 | 是否守住：两侧锚点均由 `paragraphAnchor` / `findAnchorBlocks` 生成，无第二套哈希或序号 | P0 | ✅ | `grep -rn "2166136261\|0x9e3779b9" web/src` → 哈希常量全仓仅 `lib/kiLinks.ts:69-70` 一处；`paragraphAnchor` 仅被同文件 `findAnchorBlocks` 调用；`findAnchorBlocks` 调用点 3 处（Composer 弹窗 / Drawer 阅读侧 / Editor 下拉）全部同函数。e2e 的 `anchorKey` 只做测试统计，不产出链接 |
| E3 | 是否守住：未放宽 `insertReaderLink` 源码唯一性判断 | P0 | ✅ | 判据为 `start < 0 \|\| content.indexOf(label, start+len) >= 0` → 抛错不写（`readerLinks.ts:8`）；单测「rejects ambiguous or non-contiguous rendered text before saving」锁重复出现与跨 Markdown 语法两种情形；生产调用点仅 `ReaderLinkComposer.tsx:203` 一处，无绕过路径 |
| E4 | 是否守住：保存带 revision 且冲突走 `editId` 重试，无整篇盲覆盖 | P0 | ✅ | `neg.result.log`「重试沿用同一请求并按 editId 下单」detail：两次 POST `rev=04522d6536` 相同、`content` 相同、第二次 `editId=e-test-1`；部分写入用例复核只下一单。README「还原点」另记：还原须按当前 revision 下单，用旧值被乐观锁拒绝（实测） |
| E5 | 是否守住：e2e 只改 1 篇预先记录的文档且已还原复核 | P1 | ✅ | 唯一写入对象 `kafka/00-评审清单`（flow 写→还原→`identical:true`）；`09-排障速查手册` 全程只读；neg/editor 均以「revision 回到 `04522d65369d…` 且正文无 `ki-link:`」收尾 |
| E6 | 是否守住：未新增/修改后端接口与参数（或已留痕） | P1 | ✅ | `git diff --stat` 仅 `web/src/**` 4 个跟踪文件 + 3 个新增前端文件，无服务端文件；脚本只用既有 `GET/POST /api/doc/edit`、`GET /api/doc/list`，保存参数沿用 `expectedRevision/expectedSourceRevision/editId/vectorize` |

## 评审结论

- 通过：19 / 20（A 3、B 5、C 2、D 3、E 6）
- P0 未通过（阻断）：无。存疑 1 条：**C2**（缺 a582d3b 之前写入的真实历史链接样本，端到端点击未验；单测与 `p-` 深链已侧面锁住解析兼容）
- 处置：E1 已由使用者 2026-09-29 裁定接受，护栏 #1 表述加方向性（kind 前缀只可增加、不得删除或改写）。C2 待 KB 出现历史链接样本后按 `e2e/README.md` 的跑法复验，不阻断交付。其余 18 项均有浏览器断言、单测或 diff 证据，无「只凭代码阅读」得出的结论。

