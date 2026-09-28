---
task: 阅读页跳转链接交互按已确认 demo 对齐正式代码
status: 已完成，待验收（checklist 18/20 通过，E1 / C2 两条 P0 存疑待裁定）
created: 2026-09-29
updated: 2026-09-29
related: local-link-picker-demo.html（用户已确认的交互 demo）/ a582d3b 文档在线编辑
---

# 执行计划：阅读页跳转链接交互按已确认 demo 对齐正式代码

## 目标

在真实应用里，阅读页选中一段文字 → 弹窗里选目标文档的某个段落 → 确认后正文立即出现可点链接，点击即滚动到目标段落并高亮；demo 里确认过的每条交互与失败提示都在正式代码中成立。

## 完成判据

- [x] 真实浏览器（vite dev 5188 代理 7423 后端）走完：选中 → 面板 → 弹窗选段落 → 保存 → 链接立即渲染 → 点击跳转到目标段落并高亮
- [x] `npm test` + `tsc --noEmit` + `vite build` 全绿，且新增「写入侧锚点 == 阅读侧锚点」一致性测试通过
- [x] 验证期间被改动的知识库文档按原文还原并复核 revision，KB 内无残留测试链接

## 注意事项（执行护栏）

| # | 注意事项 | 来源 | 违反后果 |
|---|----------|------|----------|
| 1 | 不得改动 `ki-link:` v1 协议字段与 16 位哈希长度；`ANCHOR_PATTERN` 的 kind 前缀（`p/h/li/td/th`）**只可增加、不得删除或改写**（方向性由使用者 2026-09-29 裁定明确） | 上游代码 a582d3b 已发布该协议 | P0：历史文档里已写入的跳转链接全部失效 |
| 2 | 弹窗侧与阅读侧锚点一律由 `paragraphAnchor` / `findAnchorBlocks` 生成，禁止另写序号或第二套哈希 | 用户确认的 demo 用序号锚点，正式代码若各写一套即失联 | P0：写进去的链接点了不跳，功能整体失效 |
| 3 | 不得为了让写入成功而放宽 `insertReaderLink` 的「所选文字在源码中恰好出现一次」判断 | 用户要求：跳错比跳不了更糟 | P0：改错正文，破坏用户文档 |
| 4 | 保存必须带 `expectedRevision` / `expectedSourceRevision`，冲突走 `editId` 重试，不得整篇盲覆盖 | 上游编辑接口契约 | P0：并发编辑下丢掉他人内容 |
| 5 | e2e 只改预先记录的 1 篇 kafka 文档，收尾必须按记录的原文还原并复核 revision | 本次验证方式（真实知识库） | P1：知识库残留测试数据 |
| 6 | 不新增/修改后端接口与参数；若确实需要，先记入「决策与偏差」再动 | 7423 后端跑自主检出，非本 worktree | P1：验证环境与代码不一致，结论失真 |

> 每条一对一生成清单 E 组；工作项证据引用格式：`守 #2 → 已确认（怎么确认的）`

## 工作项

| # | 工作项 | 状态 | 证据 | 备注 |
|---|--------|------|------|------|
| 1 | 锚点一致性：弹窗正文与阅读正文对同一段落生成同一 anchor，并补单测锁死 | 已完成 | 单测：`node --test test/reader-links.test.mjs` → 8 passed（块类型 encode/parse 往返、同文归一化稳定、畸形 anchor 丢弃）。真实链路：弹窗选中 `09-排障速查手册` 段落 → 写入 anchor `p-aa23996a0e56668a` → 阅读页按深链解析，落点为该段本身（`e2e/flow.result.log` 的 `[saved]` 与 `[jumped]` 两行） | 守 #1 #2 → 已确认（两侧都走 `findAnchorBlocks`，未新增第二套哈希；grep 确认无其它 anchor 生成点） |
| 2 | 真实浏览器全链路：选中 → 面板 → 弹窗 → 选段落 → 保存 → 链接立即渲染 | 已完成 | `e2e/flow.result.log`：面板 quote 正确 → 弹窗 110 篇文档 → 底部「已选中段落中的位置」+ 高亮块正确 → `[saved] changed:true` 且 API 读回正文含 `[...](ki-link:{...anchor:p-aa23996a0e56668a})` → `[link-rendered]` 阅读页即时渲染出 `a.ki-jump-link` | 守 #3 #4 #5 → 已确认（写入前 API 读回校验；还原后 revision 回到 04522d65369d） |
| 3 | 点击链接跳转：滚动到目标段落 + 高亮；段落被改 / 重复时的提示分支 | 已完成 | 正向：`e2e/flow.result.log` `[jumped] landed=P :: 一眼识别：某分区 LAG…，scrollTop:1506, warning:null`。失效锚点：`neg.result.log`「失效锚点提示而非乱跳」→ 页面显示「目标段落已变化或不存在。文档已打开，请重新选择位置。」且未滚动定位。重复落点：同日志「重复落点提示出现 6 次（td:🟡 尽快）」+「重复落点无法确认」（确认按钮 disabled、位置栏回到「尚未选择位置」） | 守 #2 → 已确认（阅读侧与弹窗侧同用 `findAnchorBlocks`，失效时只提示不猜落点） |
| 4 | 文案与细节对齐 demo：重复段落计数提示、引导语、焦点高亮、Esc / 关闭行为 | 已完成 | `ReaderLinkComposer.tsx:169` 的计数提示已在真实浏览器出现：`neg.result.log` 第 5 行原文「这段文字在文档中出现 6 次，无法确定要跳向哪一处；请改选其他位置」。副标题 `:269`、引导语 `:303`、页脚 `:316` 与 demo 一致（页脚默认语在 `neg.result.log` 各分支的 detail 里可见）；Esc 行为走 `keydown` 分支（`ReaderLinkComposer.tsx:140`），关闭 × 在 editor/neg 两个场景中均被使用且未产生残留 | |
| 5 | 失败分支：外链校验、非编辑态入口、保存冲突重试与部分写入提示 | 已完成 | `neg.result.log` 13/13：跨块选区被拒、清空选区不弹面板、链接/代码内文字引导去编辑器、非法外链被拒、保存冲突提示「保存失败：文档已被他人修改；可重试当前保存」并给出「重试保存」、重试沿用同一请求（`expectedRevision` 两次一致、第二次带 `editId=e-test-1`、content 相同）、部分写入提示「KB 正文已更新，但源文件状态为failed」且不提供重试、只下一单（POST 次数=3）、全程不写库（revision 回到 `04522d65369d…`、正文无 `ki-link:`）。非编辑态：`SearchPage.tsx:539` 未传 `editable` → 无入口，经用户确认**保持现状**（见「决策与偏差」#4） | 守 #4 → 已确认（冲突与部分写入均用 fetch 拦截，未产生真实写入） |
| 6 | 回归：`npm test` / `tsc --noEmit` / `vite build` | 已完成 | 文案与脚本改动后复跑：`npm test` → `# tests 28 / # pass 28 / # fail 0`（新增 1 条历史格式兼容用例）；`npx tsc --noEmit` → 退出码 0 无输出；`npx vite build` → `✓ built in 376ms`（仅既有的 chunk >500kB 提示）。`e2e/flow.mjs` 用新 helpers 复跑仍全绿并成功还原 | 收尾已跑 |

## 决策与偏差

| # | 事项 | 决策 / 偏差 | 原因 |
|---|------|------------|------|
| 1 | `neg.mjs` 用例 4「重复落点提示次数」FAIL + 用例 5 语法错 | **已确认为测试脚本自身问题并修好**（本轮复跑 13/13 通过）：用例 4 原先按「段落文本相同」判重，而产品按 `kind+文本` 的 anchor 判重——同一句文字一处渲染成 `th`、一处是 `td` 时产品视为两个落点，所以永远等不到「出现 N 次」；改用 `helpers.mjs` 里与 `anchorKind` 同口径的 `anchorKey` 后一次通过。用例 5 是把 node 侧拼好的字符串（`'确认按钮 disabled=' + await evaluate(…)`）传给了 `check()` 的第三个参数（该参数要求是**页面内表达式**），页面按 JS 解析即抛 `SyntaxError`，连带用例 6/7 从未执行 | 三层转义（node 模板 → CDP 表达式 → 页面 DOM）下测试脚本易失真，与产品代码无关 |
| 2 | 交接到其它 IDE 继续 | 本台账 + `e2e/` 脚本作为交接物；产品代码保持未提交状态（detached HEAD `b9e33a3`） | 用户要求 |
| 3 | `ANCHOR_PATTERN` 里新增 `li\|td\|th` 三个 kind（代码从 `^(?:p\|h)-…` 变为 `^(?:p\|h\|li\|td\|th)-…`） | **非偏差**：护栏 #1 与交接摘要本来就写着 `p/h/li/td/th`，只是 a582d3b 的代码当时只实现了 `p/h`。为让列表项 / 表格单元格能当落点（demo 已确认的交互）而补齐 kind；同时**加严方向性约束**——kind 前缀只可增加、不得删除或改写，协议字段与 16 位哈希长度不变。历史链接（`p-`/`h-`、无 anchor 的文档级、外链）解析另有单测 `keeps parsing links written before list and table anchors existed` 锁死。使用者 2026-09-29 裁定：接受并把方向性写进护栏 | 若不补，弹窗生成的 `li-`/`td-` anchor 会被阅读侧 `parseKiLink` 判为畸形并丢掉段落，功能直接失效 |
| 4 | 搜索结果页打开的文档没有「添加跳转」入口（`SearchPage.tsx:539` 未传 `editable`） | **保持现状**（用户 2026-09-29 决定）。`editable` 在本次改动前就同时门控「编辑文档」按钮（`ModuleDrawer.tsx:732`），且只有 `BrowsePage.tsx:811` 传了它；跳转入口沿用同一门槛，不新增独立开关 | 保持「能改正文的地方才能建链接」的单一语义，避免搜索页出现只读但可写链接的不对等状态 |
| 5 | 负向用例 5 的「重试成功」是拦截器返回的 mock 200 | 只用于验证客户端沿用同一 pending 请求并按 `editId` 复下单；该单未写库，用例 7 已复核 KB revision 与正文未变 | 真实 409→重试需并发写库，与护栏 #5「只改预记录的那 1 篇」冲突 |

## 进度日志

- 2026-09-29 00:58 E1 裁定落地：核对后发现护栏 #1 与交接摘要本来就写着 `p/h/li/td/th`，只是 a582d3b 代码当时只实现到 `p/h` → 本次补齐 kind **不算违反护栏**（决策 #3 已改写为「非偏差」）。按使用者裁定，把方向性约束写进护栏 #1：kind 前缀只可增加、不得删除或改写；协议字段与 16 位哈希长度不得改动。checklist E1 相应改为 ✅，评审结论 19/20，唯一存疑项剩 C2（缺真实历史链接样本）。
- 2026-09-29 00:54 **收尾完成，进入验收**。① 负向脚本 3 个 bug 修好（判重口径改 `kind+文本`、`check()` 第三参数误传拼接串、用例 6/7 连带未执行），并补 3 条断言（空选区、部分写入、重试下单）→ `e2e/neg.result.log` 13/13。② 新增 `e2e/editor.mjs` 做既有入口回归：编辑器「读取标题/段落」下拉出 20 个 `h-`/`p-` 锚点、未保存 → 2/2。③ `flow.mjs` 用新 helpers 复跑仍全绿，知识库还原复核 `identical:true / revisionBack:true`。④ 静态与单测：`npm test` 28 passed（补 1 条历史格式兼容用例）、`tsc --noEmit` 退出 0、`vite build` ✓ 376ms。⑤ 两项决策待定/已定：`SearchPage` 入口按用户确认**保持只读**（决策 #4）；`ANCHOR_PATTERN` 放宽属有意变更，已记决策 #3 并在 checklist E1 标 ⚠️ 交判定。
- 2026-09-29 00:40 W1 单测落地（8 passed），全量 web 测试 27 passed。e2e 环境探明：5173 已被**另一个 worktree** 的 vite 占用（`/Users/wuyongping/.qoder-cn/worktrees/app/024c21/knowledge-indexer/web`），不能拿它验证本 worktree 代码 → 改用 5188 起本 worktree 的 vite dev（代理 7423 后端）。
- 2026-09-29 00:45 e2e 还原点已记录：源文档 `kafka/00-评审清单`，revision `04522d65369dfe8a…99880a`（与 sourceRevision 相同，indexMode=dense），收尾按原文写回并复核 revision 一致。
- 2026-09-29 00:35 **交接点**。已完成 W1 / W2，W3 正向分支已验；W4 文案已改未验；W5 三条负向已过、两条未判定；W6 需重跑（文案改动后未验证）。
  - 知识库状态：`kafka/00-评审清单` 已还原为 revision `04522d65369d…`（与建档还原点一致，正文无 `ki-link:`），`09-排障速查手册` 全程只读未改。
  - 复现方式：`.plans/.../e2e/run.sh flow.mjs`（脚本内写死 worktree 路径与端口 5188；5173 被另一 worktree 占用，勿混用）。
  - 未提交改动：`ModuleDrawer.tsx` / `ReaderLinkComposer.tsx`(新) / `readerLinks.ts`(新) / `kiLinks.ts` / `DocumentEditor.tsx` / `styles/ki.css` / `test/reader-links.test.mjs`(新)；`web/node_modules` 那条 M 是 worktree 符号链接差异，**不要提交**。
- 2026-09-29 00:10 建档。demo 已获用户确认（13 项无头交互自检全过）；正式代码已有 ReaderLinkComposer，外链严格校验与残留高亮两处已同步，`npm test` 24 项 + `tsc --noEmit` 通过。待做：锚点一致性单测与真实链路验证。
- 环境事实：7423 后端来自 `/Users/wuyongping/projects/knowledge-indexer`（HEAD f9aba37，比本 worktree 多一个 import 提交）；本 worktree 无根 node_modules，前端验证走 worktree 内 `web` 的 vite dev（5173，代理 7423）。
