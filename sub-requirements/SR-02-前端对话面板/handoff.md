# SR-02 窗口启动提示词

> **用法**：把下方分隔线内的**全部内容**复制粘贴到一个新对话窗，作为首条消息。

---

你是 **SR-02「前端对话面板」** 砖头的实现窗口。请严格按以下信息工作。

## 0. 先确认工作环境（**不满足就停下上报**）

- 必须在**独立工作副本**中工作，**不得与他人共享同一工作目录**
- 分支：`feat/sr-02-frontend`
- **代码基线 `code_base` = `freeze/REQ-20260924-001`**；工作前 `git rev-parse HEAD` 确认起点

## 1. 你的砖头

- **目标**：Web 任意页面右侧的常驻可收起 AI 对话面板（多轮 / 流式 / 来源引用 / 会话管理），**关闭不丢内容、不中止生成**
- **包位置**：`sub-requirements/SR-02-前端对话面板/`
- **先按顺序读**：`slice.md` → `ownership.md` → `out-of-scope.md` → `contract/`

## 1.5 文档位置（**先读这段，否则找不到文件**）

本包内引用的 `design/...`、`api/...` 路径是**相对需求目录**的，而需求目录**不在工作副本里**（它在 `CodeWikiHub/` 下，被 `.gitignore` 忽略）。用下列任一方式定位：

```text
方式 A（绝对路径，总是可用）：
  /Users/wuyongping/projects/knowledge-indexer/CodeWikiHub/kisearch/requirements/2026-09-24-Web侧边栏AI对话模块/

方式 B（若工作副本里有 CodeWikiHub 符号链接）：
  <工作副本根>/CodeWikiHub/kisearch/requirements/2026-09-24-Web侧边栏AI对话模块/
```

> **该目录不在版本控制内**：它是**设计产物**，改动不通过 git 管理，也**不属于本窗口的写入范围** —— 只读参考。

## 2. 契约（**只读**）

| 内容 | 位置 |
|------|------|
| 前端契约副本（**字段形状冻结**） | `web/src/api/chatContract.ts` |
| 后端契约 SSOT（形状参考） | `src/lib/chat/chat-contract.ts` |
| 前端面板设计（含 D15/D13/R20） | `design/S03_前端对话面板与流式对话_DESIGN.md` §9 |
| 思考与工具步骤展示 | `design/S05_思考内容折叠展示_DESIGN.md` §9 |
| 检索与来源引用契约 | `design/S07_检索与工具调用_DESIGN.md`（§3.5 来源引用 / §3.9 事件） |
| **横切约定 + 权限模型** | `design/cross-cutting.md` |
| 事件字段级契约 | `api/retrieval.md` §1 |

**契约不够用**（缺事件字段 / 语义不明）→ **写阻塞**，不许自己在前端"补"字段（那会造成契约漂移）。

## 3. 骨架现状（桩已生成）

```text
web/src/chat/
├── chatStore.ts      # ★ 已有部分实现：UI 动作可用，stream* 动作抛 STUB:SR-02:*
├── useChatStream.ts  # 桩 → 你实现（SSE 事件 → store 状态）
├── ChatPanel.tsx     # 占位渲染 → 你实现（视图，不持有业务状态）
├── SourcesList.tsx   # 占位渲染 → 你实现（来源引用，点击回原文）
└── format.ts         # ✅ 已实现（纯格式化，勿改逻辑）
web/src/api/chatApi.ts   # 桩 → 你实现（12 接口 + SSE 逐帧解析）
web/src/layouts/AppShell.tsx  # ✅ 挂载位已就绪（store 创建 + 顶部开关 + <ChatPanel/>）
```

## 4. 两条硬约束（**最易写错**）

| # | 约束 | 原因 |
|---|------|------|
| 1 | **流式累积态（content / reasoning / 工具步骤）必须放在 `AppShell` 级 `chatStore`**，组件内不得持有 | D15：关闭面板 = 隐藏不卸载；状态在组件内 → 卸载即丢内容并可能连带 abort |
| 2 | **SSE 用 `fetch` + `ReadableStream`，不用 `EventSource`** | `EventSource` 只支持 GET、无法带请求体、无法中途 abort |

## 5. 开发期不等后端

用 `.delivery/mocks/mock-sse.mjs`（四条路径：`retrievalAnswerFlow` / `degradedFlow` / `retrievalUnavailableFlow` / `abortedFlow`）驱动。
**⚠️ mock 只证形状不证行为**（无真实延迟、无检索质量）→ 拼接期必须对真实实现重跑。

## 6. 完成定义

**跑 `verify/run.sh` 全绿**（tsc + 契约对齐 + 片级验收 + 数据走向 + 越界 + 桩残留）。
另：`slice.md` §3 第 5/6 项（D15 显隐不丢 / 来源引用点击回原文）——项目无 DOM 测试环境，
**若你自建了 DOM 基建则落成用例；否则产出「人工验收脚本」（步骤 + 期望）并在返回时标注方式**。不许跳过。

## 7. 预期红（看到不要修）

- `contract-sr01.test.ts` / `acceptance-sr01.test.ts` 属 SR-01，**不跑也不修**
- `contract-parity.test.ts` **必须绿**；变红 = 契约漂移 → **写阻塞**

## 8. 阻塞上报格式

```text
【阻塞】SR-02
现象：...
已尝试：...
需要谁决定：用户 / design-craft / SR-01
```

**不要**为让测试变绿而改断言、改契约、改 `src/**`、改 `ModuleDrawer.tsx`（既有组件，影响 5 个页面）。
