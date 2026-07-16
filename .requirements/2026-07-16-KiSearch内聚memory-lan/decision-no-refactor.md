# 决策记录：KiSearch 向量引擎「不重构底层」

- 关联需求：REQ-20260716-001（KiSearch 内聚 memory-lancedb-mcp 向量引擎）
- 决策日期：2026-07-16
- 决策状态：**已拍板（不重构）**
- 备选方案：
  - Option A（原需求方案）：KiSearch in-process 导入 `memory-lancedb-mcp`，用 `createMemoryRuntime()` 替换 `mem-client.ts` 的 spawn 调用。
  - Option B（本决策采用）：保留 `mem-client.ts` 的 spawn 架构，将 `mem` 升级到最新版 `memory-lancedb-mcp`，并以本地 `node_modules/.bin/mem` 方式调用，去除全局安装依赖。

---

## 1. 决策结论

**不重构底层，采用 Option B（升级 mem + 本地 bin 调用）。**

在当前「一次性 CLI」形态下，Option B 可拿到 Option A 约 80% 的收益，代价约为 Option A 的 10%；而 Option A 独有、Option B 无法替代的收益在当前形态下均用不上，反而引入额外的进程级风险与依赖面。

---

## 2. 关键事实（决策依据）

1. **`mem` CLI 与 `memory-lancedb-mcp` 是同一套代码**。
   `memory-lancedb-mcp/package.json` 声明 `"bin": { "mem": "./bin/mem.mjs" }`，全局 `mem`（`/root/memory-lancedb-pro/mcp-wrapper`，`memory-lancedb-mcp@0.1.1-beta`）正是该 wrapper。
   当前 `mem-client.ts` spawn 的 `mem`，与计划 in-process 导入的包，**底层引擎完全一致**（`memory-lancedb-pro` / lancedb / embedder）。
   ⇒ **重构 = 把这个 wrapper 从子进程搬进 KiSearch 进程内**，而非更换引擎。

2. **`mem` CLI 本就输出结构化 JSON**（如 `{details:{memories}}`），`mem-client.ts` 已解析；仅 `store` 的 `Memory ID:` 正则较脆弱，且已有 JSON 兜底。
   ⇒ 重构宣称的「去掉 stdout 解析」收益，Option B 已基本具备。

3. **demo 验证（2026-07-16）已证实 in-process 路径可行**，但同时暴露 in-process 独有的风险（见 §4）。

---

## 3. 收益对比（Option A vs Option B）

| 目标收益 | Option A（重构） | Option B（升级 mem） |
|---|---|---|
| 免去全局 `mem` 安装 | ✅ | ✅（用 `node_modules/.bin/mem`） |
| 结构化结果 / 不解析 stdout | ✅ | ✅（CLI 已输出 JSON，已有解析） |
| 性能（去 spawn 开销） | ⚠️ 一次性 CLI 几乎为 0 | ⚠️ 一次性 CLI 几乎为 0 |
| 可锁版本 / tree-shake / 单测 / 常驻复用 runtime | ✅ 独有 | ❌ 拿不到 |

⇒ Option A 相对 Option B 的**净新增收益**仅剩「vendoring / 单测 / 常驻复用」一项，需特定前提才成立（见 §5）。

---

## 4. Option A 独有且 Option B 规避的代价（demo 已证实）

1. **lancedb 锁死风险进 KiSearch 进程树**：demo 中因残留锁文件导致 300s 卡死。Option B 下锁在独立 `mem` 子进程，KiSearch 主进程永不卡死；Option A 下锁进 KiSearch 自身，一次崩溃即可让后续所有 `ki` 命令挂死。
2. **ACL 绕过契约外溢**：必须在 KiSearch 每一处 `callTool` 显式带 `{agentId:"system"}`，否则显式 scope 写入/读取被 `Access denied`。
3. **依赖面加深**：对 `createMemoryRuntime()` + `FakeOpenClawApi` + jiti 运行时编译形成深依赖，漂移面大于「CLI 参数 + stdout JSON」。

> 标签近似过滤、embedder 联网超时、lancedb 锁死——此三项**两种方案共有**，重构无法消除，仅换处理位置。

---

## 5. 唯一会推翻本决策的条件

满足以下任一，则改判为 Option A（重构）：
- KiSearch 明确演进为**常驻 server / daemon**（多请求共享同一 runtime，spawn 开销与 init 复用成为瓶颈）；
- 真实目标是**完全内包 / 控制引擎**（内部 fork、单测、锁死版本、tree-shake）。

---

## 6. Option B 落地动作（下一步）

1. 将 `memory-lancedb-mcp` 加入依赖，确认 `node_modules/.bin/mem` 可用；
2. 验证现有 `mem-client.ts` 对最新 `mem` 输出的解析兼容性，重点：
   - `store` 的 `Memory ID` 正则 / JSON id 提取是否仍匹配；
   - `search` 的 `details.memories` 格式是否漂移；
3. 将 `execFileSync('mem', ...)` 指向本地 bin，去除全局 `mem` 安装依赖；
4. 更新 REQ-20260716-001 状态：原 REQ-01~08 重构清单作废，替换为 Option B 的最小改动清单。

---

## 7. 关联产物

- 验证报告：`demo/verify-report.md`（in-process 路径 R-01/R-02 通过、R-03 有条件通过）
- 原型脚本：`demo/verify.ts`、`demo/verify-embedder.ts`
- 需求文档：`requirement.md`
