# S-02：配置诊断 + MCP 启动预检（ki doctor）

> 覆盖 REQ-16（ki doctor + MCP 启动预检）。共享术语见父文档 §3.2。

## 1. 术语

| 术语 | 含义 | 引用 |
|------|------|------|
| health check | 配置诊断函数集（`scripts/lib/health-check.ts`，新增） | 见父文档 §3.2 |
| 诊断报告 | `ki doctor` 输出的结构化检查结果，含 ✅/❌/⚠️ 状态 | — |
| 启动预检 | `ki mcp` 启动时调用 health check，❌ 则拒绝启动 | — |

## 2. 现状（AS-IS）

### 2.1 现状描述

无配置诊断命令。配置错误（apiKey 缺失、URL 不通、维度不匹配、目录不存在）只在运行时暴露。`ensureMemAvailable`（`mem-client.ts:356`）仅检测 `mem --version` 是否可执行，不检查 embedding 连通性或目录权限。`ki mcp` 启动时不做配置预检，启动后才发现问题。

### 2.2 痛点

- 痛点 1：apiKey 缺失时，`ki store` 调 SiliconFlow API 失败后才报错，用户不知道是配置问题
- 痛点 2：`ki mcp` 启动后第一个请求才发现 embedding 不可用，server 已对外暴露但无法服务
- 痛点 3：维度不匹配（config 写 4096，实际 model 返回 1024）只在写入时 zvec 报错，错误信息不直观

## 3. 方案（TO-BE）

### 3.1 方案概述

新增 `scripts/lib/health-check.ts` 函数库，提供分项检查（配置文件/目录/embedding/zvec/scope）。`ki doctor` CLI 命令调用全量检查输出报告；`ki mcp` 启动时调用同一套函数，❌ 拒绝启动，⚠️ 警告但启动。

### 3.2 关键决策点

| 决策 | 选择 | 理由 | 备选方案 | 否决原因 |
|------|------|------|---------|---------|
| embedding 检查方式 | 发送 1 条最短文本 embedding 请求 | URL+密钥+维度三合一验证 | 仅 HEAD 请求检查 URL | HEAD 不验证密钥和维度 |
| 检查超时 | 5s | 避免网络不通时长时间卡住 | 10s | CLI 用户期望快速反馈 |
| MCP 启动预检 ⚠️ 处理 | 警告但启动 | zvec collection 未创建是正常的 ⚠️ | ⚠️ 也拒绝启动 | 过度严格，首次使用无法启动 |
| 检查函数复用 | doctor 和 MCP 共用 `health-check.ts` | 避免重复实现 | 各自实现 | 逻辑不一致风险 |

## 4a. 接口设计

### 4a.1 对外接口

```typescript
// scripts/lib/health-check.ts

interface CheckResult {
  item: string;          // 检查项名称
  status: 'pass' | 'fail' | 'warn';
  message: string;       // 人类可读描述
  detail?: string;       // 额外信息（如实际维度 vs 配置维度）
}

interface HealthReport {
  results: CheckResult[];
  summary: { pass: number; fail: number; warn: number };
}

/** 全量配置诊断（ki doctor 调用） */
async function runHealthCheck(config: KiConfig): Promise<HealthReport>;

/** MCP 启动预检（ki mcp 调用，仅检查阻断项） */
async function runStartupCheck(config: KiConfig): Promise<{ ok: boolean; failures: CheckResult[]; warnings: CheckResult[] }>;
```

| 接口 | 输入 | 输出 | 异常 |
|------|------|------|------|
| `runHealthCheck` | `KiConfig` | `HealthReport`（全量检查结果） | 不抛异常，错误进 `CheckResult.status='fail'` |
| `runStartupCheck` | `KiConfig` | `{ ok, failures, warnings }` | 不抛异常 |

### 4a.2 检查项清单

| 检查项 | 函数 | 通过 | 失败 | 警告 |
|--------|------|------|------|------|
| 配置文件 | `checkConfigFile` | YAML 可解析 | 不存在/语法错误 | — |
| dataDir | `checkDirectory` | 存在且可写 | 不存在/无权限 | — |
| backupDir | `checkDirectory` | 同上 | 同上 | — |
| vectorDir | `checkDirectory` | 同上 | 同上 | — |
| apiKey | `checkApiKey` | env 变量存在 | 未设置 | — |
| URL 连通性 | `checkEmbeddingUrl` | embeddings 端点可达 | 超时/404/DNS 失败 | — |
| 密钥有效性 | `checkEmbeddingAuth` | embedding 请求成功 | 401/403 | — |
| 维度匹配 | `checkEmbeddingDimension` | 返回维度 === config.dimension | 不一致 | — |
| zvec collection | `checkZvecCollection` | 存在且可 open | 损坏/锁冲突 | 首次使用未创建 |
| scopes.default | `checkDefaultScope` | default 已配置 | — | 未配置 default |

> `checkEmbeddingUrl` + `checkEmbeddingAuth` + `checkEmbeddingDimension` 合并为一次 embedding 请求（发 `"test"` 文本），拆解 3 个检查结果。

### 4a.3 契约变更声明

| 变更类型 | 接口 | 变更内容 | 影响的子需求 |
|---------|------|---------|------------|
| 新增 | `runHealthCheck` / `runStartupCheck` | health-check.ts 全套函数 | S-06（MCP 启动调用） |
| 新增 | `ki doctor` 命令 | CLI 新命令 | — |

## +10. 影响范围

| 影响对象 | 影响类型 | 影响描述 | 破坏性 |
|---------|---------|---------|:------:|
| `scripts/lib/health-check.ts`（新增） | 新增 | 检查函数库 | 否 |
| `scripts/doctor.ts`（新增） | 新增 | `ki doctor` CLI 命令 | 否 |
| `bin/ki.mjs` | 配置变更 | COMMANDS 添加 `doctor: 'scripts/doctor.ts'` | 否 |
| `scripts/mcp-server.ts` | 行为变更 | `startMcpServer()` 前调用 `runStartupCheck` | 否 |

## +6. 异常处理

| 场景 | 行为 | 对外暴露 |
|------|------|---------|
| embedding 请求超时（>5s） | 标记 fail，message 含「连接超时，请检查网络或 baseURL」 | 是（doctor 报告 / MCP 启动拒绝） |
| embedding 401 | 标记 fail，message 含「密钥无效，请检查 SILICONFLOW_API_KEY」 | 是 |
| zvec collection 锁冲突 | 标记 fail，message 含「collection 被锁定，可能有进程正在使用」 | 是 |
| zvec collection 不存在 | 标记 warn，message 含「首次使用，执行 ki store 后自动创建」 | 是（警告不阻断） |
| 目录无写权限 | 标记 fail，message 含「{dir} 无写权限」 | 是 |
| health-check.ts 内部异常 | 标记 fail，message 含异常信息 | 是 |
