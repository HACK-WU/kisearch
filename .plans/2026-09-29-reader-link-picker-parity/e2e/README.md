# e2e 交接脚本

驱动真实应用（本 worktree 前端 + 7423 后端）验证「阅读页选中文字 → 知识库内跳转」交互。
无需任何依赖：Node 22 自带 WebSocket，浏览器用本机 Google Chrome 的 headless + CDP。

## 跑法

    ./run.sh flow.mjs     # 正向全链路（会真写 kafka/00-评审清单，结束自动还原）
    ./run.sh neg.mjs      # 负向分支（全程不写库；保存失败/部分写入用 fetch 拦截模拟）
    ./run.sh editor.mjs   # 既有入口回归：编辑文档的「读取标题/段落」下拉（不保存）
    node scan-dup.mjs     # 辅助：扫 kafka 组内「同 kind + 同文本」的重复落点分布在哪些文档

`run.sh` 自己起停 vite(5188) 与 headless Chrome(9334)，日志实时落盘再 `cat` 结果日志更稳。
端口写死：5173 被 `/Users/wuyongping/.qoder-cn/worktrees/app/024c21/...` 的 vite 占用，别用它验证本 worktree。

## 文件

| 文件 | 作用 |
|------|------|
| `cdp.mjs` | 极简 CDP 客户端：`connect / goto / evaluate / waitFor` |
| `helpers.mjs` | 注入页面的选区工具 `window.__ki`（按文本节点定位、找源码唯一片段、跨块选区、按 anchor 口径统计重复块） |
| `flow.mjs` | 正向链路 + try/finally 还原知识库 |
| `neg.mjs` | 负向用例 1–7（13 项断言） |
| `editor.mjs` | 既有入口回归：编辑器「读取标题/段落」下拉 |
| `scan-dup.mjs` | 辅助扫描：kafka 组内哪些文档存在同 kind 重复落点 |
| `*.result.log` | 最近一次运行输出（flow 全绿并还原、neg 13/13、editor 2/2） |

## 断言口径备忘

1. **重复落点按 `kind + 归一化文本` 判定**（与 `paragraphAnchor` 一致）。同一句文字一处渲染成 `th`、一处是 `td` 时，产品视为两个不同落点，不算重复——脚本只比文本就会误判（上一轮用例 4 FAIL 的根因，非产品缺陷）。
2. `check(name, cond, detailExpr)` 的第三个参数是**页面内表达式**，不能传已在 node 侧拼好的字符串，否则会被当成 JS 解析并抛 `SyntaxError`（上一轮用例 5 的语法错即此）。
3. 用例 5 的「重试成功」是拦截器返回的 mock 200，不写库；它只证明客户端沿用同一 pending 请求并按 `editId` 复下单。
4. 目标文档 `09-排障速查手册` 全程只读，其中 `td|🟡 尽快` 重复 6 次，是「出现 N 次」文案的用例来源。
5. 编辑器场景必须等 `.ki-editor__textarea` 有正文后再点「读取标题/段落」，否则 `draft` 为空只会得到「请先选择目标文档」。

## 还原点

源文档 `kafka/00-评审清单` 原始 revision `04522d65369dfe8a1171a83349627fbb9f34d1aea226df95b151975ca799880a`（= 正文 sha256）。
还原必须按**当前** revision / sourceRevision 下单，用写入前的旧值会被乐观锁拒绝（实测报「源文件在加载后发生变化」）。
