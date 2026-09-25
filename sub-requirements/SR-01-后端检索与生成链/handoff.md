# SR-01 窗口启动提示词

> **用法**：把下方分隔线内的**全部内容**复制粘贴到一个新对话窗，作为首条消息。

---

你是 **SR-01「后端检索与生成链」** 砖头的实现窗口。请严格按以下信息工作。

## 0. 先确认工作环境（**不满足就停下上报**）

- 你必须在**独立工作副本**中工作（git worktree / 独立克隆 / 独立目录），**不得与他人共享同一工作目录**（共享目录下并行会互相覆盖，一切边界约定失效）
- 分支：`feat/sr-01-backend`
- **代码基线 `code_base` = `freeze/REQ-20260924-001`**（单批 = 冻结点；分批时第 N 批 = 上一批合入后的 commit）
- 工作前先 `git rev-parse HEAD` 确认起点正确

## 0.5 环境前提（**实测所得，遇到报错先看这里**）

| 现象 | 原因 | 处理 |
|------|------|------|
| `MODULE_NOT_FOUND: dist/zvec-engine/index.js` | 独立工作副本**不含构建产物**，而 `src/lib/vector-client.ts` 运行时**必需**它 | 先跑 `npx tsc -p tsconfig.src.json` 生成（这本来就是验收第 ① 项） |
| 起 daemon 失败 / socket 被占 | `~/.ki/run/daemon-*.sock` 可能被**他人实例**占用（同机多副本场景常见） | **不要杀别人的进程**。改用**进程内探针**调 `handleApiRequest`（生产同一入口），反而能精确注入 `clientAddr` / `resolveTokenScopes` |
| 测试里换 env 不生效 | `loadConfig()` 的**缓存键只含 `explicitPath`（函数参数）**，**不含 `KI_CONFIG_PATH` / `KI_DATA_DIR`** | 换 env 前确保 `loadConfig()` 尚未被调用；或改写同路径借 mtime/size 失效 |
| 相对路径 `fetch` 报 `ERR_INVALID_URL` | Node 的 `fetch` 不支持相对 URL（浏览器支持） | 测试内加 fetch 垫片补 origin；**不要把被测代码改成绝对路径**——那会掩盖"同源相对路径"这个约定 |

> **单窗口期的预期红**：`test/chat/e2e-sr02-sources.test.ts` / 前端相关测试不由你跑；
> `data-flow.test.ts` 是**跨砖头**的，另一片未完成时部分用例会红 —— 那是预期，**不要去改 `src/**` 让它变绿**，逐条确认归属即可。

## 1. 你的砖头

- **目标**：让 daemon 具备「检索问答 + 流式生成 + 会话落盘」的完整后端能力
- **包位置**：`sub-requirements/SR-01-后端检索与生成链/`
- **先按顺序读**：`slice.md`（目标 / 场景 / 验收 / 划分理由）→ `ownership.md`（能改什么）→ `out-of-scope.md`（不做什么）→ `contract/`（契约快照）

## 1.5 文档位置（**先读这段，否则找不到文件**）

本包内引用的 `design/...`、`api/...` 路径是**相对需求目录**的，而需求目录**不在工作副本里**（它在 `CodeWikiHub/` 下，被 `.gitignore` 忽略）。用下列任一方式定位：

```text
方式 A（绝对路径，总是可用）：
  /Users/wuyongping/projects/knowledge-indexer/CodeWikiHub/kisearch/requirements/2026-09-24-Web侧边栏AI对话模块/

方式 B（若工作副本里有 CodeWikiHub 符号链接）：
  <工作副本根>/CodeWikiHub/kisearch/requirements/2026-09-24-Web侧边栏AI对话模块/
```

> **该目录不在版本控制内**：它是**设计产物**（需求/设计/API 文档），改动不通过 git 管理，也**不属于本窗口的写入范围** —— 只读参考。

## 2. 契约（**只读，一个字都不能改**）

| 内容 | 位置 |
|------|------|
| 接口形状 SSOT | `src/lib/chat/chat-contract.ts` |
| 检索与工具调用设计 | `design/S07_检索与工具调用_DESIGN.md` |
| 模型配置与代理 | `design/S01_模型配置与后端chat代理_DESIGN.md` §9（v2 修订） |
| 会话存储与一致性 | `design/S02_会话存储与写入一致性_DESIGN.md` §9（v2 修订） |
| **横切约定 + 权限模型** | `design/cross-cutting.md`（骨架期冻结） |
| 前置门实测结论 | `design/gate1-verification.md`（含 3 条实现级发现） |

**契约不够用时的唯一合法路径**：不要就地改 → 写阻塞 → 批次结束 → 回 `design-craft` 改骨架 → 下一批开工。
**若问题是"边界本身不对"**（如发现与 SR-02 必须共享可变逻辑）→ 那属**划分修订**，代价大一个量级，**必须停下报用户**。

## 3. 骨架现状（**桩已生成，你填实现**）

```text
src/lib/chat/
├── chat-contract.ts          # 契约（只读！）
├── chat-store.ts             # 桩 → 你实现（会话 CRUD + withConvLock + 原子截断）
├── llm-client.ts             # 桩 → 你实现（流式 + tools + tool_calls 按 index 累积）
├── chat-routes.ts            # 桩 → 你实现（12 个路由 + SSE 写出）
└── retrieval/
    ├── retrieval-skill.ts    # 桩 → 你实现（工具 schema + skill 正文，**同源维护**）
    ├── kb-search-tool.ts     # 桩 → 你实现（★ 入队点：OperationCoordinator）
    ├── projection.ts         # 桩 → 你实现（两种投影）
    └── tool-loop.ts          # 桩 → 你实现（★ 核心编排）
```

**桩都抛 `STUB:SR-01:*` —— 你的任务是让它们全部消失**（第 ⑦ 项验收会扫）。

## 4. 第一步（不是写代码）

**先清框架层风险**：在真实 daemon 上跑通一条最小的 `/api/chat/config`（或任一无副作用接口）请求 → 确认**鉴权 / 配置快照 / 路由挂载**三层都工作。前置门① 只验了长流与工具往返（独立进程），**daemon 框架层未验**。

## 5. 完成定义

**跑 `verify/run.sh` 全绿**（契约测试 + 片级验收 + 数据走向 + 越界 + 桩残留 + 编译）。
另：`slice.md` §3 的第 5 项（越权负向用例 P1–P7）须落成**可执行测试**并通过。

## 6. 预期红（看到不要修）

- `test/chat/acceptance-sr02.test.ts` 属 SR-02，本窗口**不跑也不修**
- `test/chat/contract-parity.test.ts` **必须保持绿**（它验契约形状）；**若变红 → 说明契约漂移 → 报阻塞，不自行改契约**

## 7. 阻塞上报格式

```text
【阻塞】SR-01
现象：...
已尝试：...
需要谁决定：用户 / design-craft / SR-02
```

**不要**为了让测试变绿而改断言、改契约、改别人的独占区 —— 那三个动作都会造成比原问题更大的损害。
