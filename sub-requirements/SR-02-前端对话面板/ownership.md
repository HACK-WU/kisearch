# 文件所有权 · SR-02 前端对话面板

> 代码基线 code_base：`freeze/REQ-20260924-001`　｜　契约基线 contract_base：`freeze/REQ-20260924-001`　｜　批次：第 1 批
> 类型：新增型 + 挂载型

## 机器可读块（供预检脚本直接读取，**勿手抄进脚本**）

```yaml
slice: SR-02
branch: feat/sr-02-frontend
code_base: freeze/REQ-20260924-001
contract_base: freeze/REQ-20260924-001
exclusive:
  - web/src/chat/
  - web/src/api/chatApi.ts
  - web/src/api/chatContract.ts
  - web/src/layouts/AppShell.tsx
  # ★ 仅【追加】ki-chat-* 段；不得修改既有的任何规则（该文件 1475 行，全站共用）
  - web/src/styles/ki.css
  - test/chat/acceptance-sr02.test.ts
  # ★ 新增：来源引用端到端（真实事件序 + 分块边界落在帧中间）
  - test/chat/e2e-sr02-sources.test.ts
interface:
  # ★ 同 SR-01：只有【形状副本】属于此列表（门② 语义 = 零 diff = 契约未漂移）。
  #   组件/store 等桩文件【不列入】—— 它们的实现体必然要改；
  #   其类型形状受保护由 contract-snapshot.md §1「冻结的代码面」+ parity 测试保证。
  - web/src/api/chatContract.ts
readonly:
  - src/lib/chat/chat-contract.ts
  - .delivery/mocks/
forbidden:
  - src/
  - test/chat/contract-sr01.test.ts
  - test/chat/acceptance-sr01.test.ts
  - test/chat/contract-parity.test.ts
  - test/chat/data-flow.test.ts
  - design/
```

## 1. 独占写（只有本窗口能改）

| 路径 | 说明 |
|------|------|
| `web/src/chat/**` | **骨架期已生成桩/部分实现**，本窗口填充实现（`chatStore` / `useChatStream` / `ChatPanel` / `SourcesList` / `format`） |
| `web/src/api/chatApi.ts` | 桩 → 实现（12 个接口封装 + SSE 逐帧解析） |
| `web/src/api/chatContract.ts` | ⚠️ **字段形状冻结**（改形状 = 契约修订）；允许补注释、加内部辅助函数 |
| `web/src/layouts/AppShell.tsx` | **只改挂载位**（store 创建 + 顶部开关 + `<ChatPanel/>`）——已预留，不得重构既有布局 |
| `test/chat/acceptance-sr02.test.ts` | SR-02 片级验收测试（**断言不得修改**） |

## 2. 只读（复用，改一字即拒收）

| 路径 | 复用什么 |
|------|---------|
| `src/lib/chat/chat-contract.ts` | **后端契约 SSOT** —— 形状参考（前端副本须与它一致） |
| `.delivery/mocks/` | mock 套件（脚手架） |
| `web/src/components/ModuleDrawer.tsx` | **来源引用点击回原文**（复用既有高亮定位能力，**不新建高亮机制**） |
| `web/src/components/MarkdownPreview.tsx` | 回答渲染（含代码块、Mermaid） |
| `web/src/lib/scopeContext.tsx` | 当前 scope（会话归属 + 检索边界） |
| `web/src/api/httpApi.ts` | `req<T>` fetch 封装（新接口可复用其模式） |

## 3. 禁碰（改了必冲突）

| 路径 | 归属 |
|------|------|
| `src/**` | **SR-01**（后端）—— 含 `src/lib/chat/**` 全部 |
| `test/chat/contract-sr01.test.ts`、`acceptance-sr01.test.ts` | SR-01 |
| `test/chat/contract-parity.test.ts`、`data-flow.test.ts` | 共享（骨架产出，双方只读） |
| `design/**`、`api/**` | 设计产物（改动须回 `design-craft`） |

## 4. 越界了怎么办

| 情况 | 处理 |
|------|------|
| 发现后端事件缺字段 / 语义不明 | **写阻塞**（改契约要走批次边界；不许自己在前端"补"一个字段） |
| 发现必须改 `src/**` | 写阻塞（那是 SR-01 独占区） |
| 想让来源引用"更漂亮"而改 `ModuleDrawer.tsx` | **写阻塞** —— 它是既有组件，改了影响 5 个页面（属跨需求影响） |
| 发现 `chatContract.ts` 形状与后端不一致 | **写阻塞** —— 契约漂移，不得自行"对齐" |
