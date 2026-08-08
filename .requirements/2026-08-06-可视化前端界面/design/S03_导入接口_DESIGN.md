---
id: REQ-20260806-003
feature: 可视化前端界面
status: 设计中
created: 2026-08-08
updated: 2026-08-08
version: 1
tags: [feat, ux, design]
depends_on: [REQ-20260806-001]
author: AI
document_type: design
parent: design/DESIGN.md
---

# S-03：`/api/import/*` 三端点（上传/触发/进度）

## 术语

| 术语 | 定义 |
|------|------|
| 受控上传目录 | `~/.ki/import-uploads/<uploadId>/`（服务端落盘，不接受用户路径） |
| uploadId | 一次上传会话的 UUID，关联已落盘文件 |
| job | 一次导入任务的异步执行单元（内存 Map） |
| ImportResult | `handleDirectImport`/`handleIncrementalDirect` 返回的结构（import.ts:87） |

## 现状（AS-IS）

- `src/lib/import.ts:203`：`handleDirectImport(args: HandleDirectImportArgs): Promise<ImportResult>`——接收 `scope/sourceDir/rootName/chunkSize/chunkOverlap/vector/cleanEnabled`，`sourceDir` 为**服务器本地绝对路径**，内部自带并发锁（`acquireImportLock`）+ 中断标记 + 进度写 stderr
- `src/lib/incremental.ts:243`：`handleIncrementalDirect` 同形态
- 无 upload/run/status 接口；`readJsonBody`（mcp-http.ts:88）仅支持 JSON（16MB 上限）

## 方案（TO-BE）

### 1. `POST /api/import/upload`（上传落盘）

接口契约：
```
POST /api/import/upload
Content-Type: application/json
{ "scope": "wiki-test", "files": [ { "name": "a.md", "content": "<base64>", "size": 123 }, ... ] }
→ 200 { ok: true, uploadId: "uuid", files: [ { name, path, size } ], total }
→ 400 { ok: false, error }   # 类型/大小/格式非法
```

- 落盘：`~/.ki/import-uploads/<uploadId>/`，按 `name` 的相对路径重建目录结构（`name` 支持 `sub/a.md` 子路径）
- 校验：扩展名白名单（`.md/.markdown/.mdx`，对齐 config `import.extensions`）、单文件 ≤ 1MB（对齐 `maxFileSizeBytes`）、文件名防路径穿越（`path.normalize` + 前缀校验）
- 上传方式：**JSON + base64**（复用 `readJsonBody`，改动最小）——文件内容 base64 编码放入 `content`
- 大小上限：整体 ≤ 16MB（readJsonBody 上限）× 分批；超过时前端分批上传（**同一 uploadId 分批追加**，见待定问题已决）
- 响应含 `uploadId`，供 `/api/import/run` 引用

### 2. `POST /api/import/run`（触发导入，异步）

接口契约：
```
POST /api/import/run
{ "scope": "wiki-test", "uploadId": "uuid", "mode": "full|incremental",
  "rootName": "wiki", "chunkSize": 1000, "chunkOverlap": 150, "vector": true }
→ 202 { ok: true, jobId: "job-uuid" }        # 异步接受
→ 400 { ok: false, error }                   # 参数非法 / 锁冲突
```

- 校验：scope 合法 + uploadId 存在 + mode ∈ {full, incremental}
- 创建 job 后**立即返回 jobId**（202），后台执行：
  - `sourceDir = ~/.ki/import-uploads/<uploadId>`
  - `mode=full` → `handleDirectImport({ scope, sourceDir, rootName, chunkSize, chunkOverlap, vector })`
  - `mode=incremental` → `handleIncrementalDirect(...)`
- **关键**：`handleDirectImport` 内部自带并发锁，锁冲突时 job 记录 `error: '导入进行中'`，状态置 failed
- **信号处理语义（评审确认）**：`handleDirectImport` 内部 `onInterrupt`（import.ts:233）捕获 SIGINT/SIGTERM 后 `process.exit(130)`——HTTP 服务进程内收到这些信号会**整体退出**。此为预期行为（`ki mcp --http --web` 是前台 daemon，Ctrl+C 关服务），**不做特殊处理**；导入中断标记/清锁逻辑（import.ts:237-241）在进程退出前同步执行，服务重启后用户可重新导入恢复
- job 状态存内存 Map（`Map<jobId, JobState>`），服务重启即清空（可接受：导入为低频操作）
- **status 404 前端处理（评审修复）**：job 丢失（服务重启）时 status 返回 404，前端收到后停止轮询并提示"任务已失效，请重新导入"，不静默卡死

### 3. `GET /api/import/status`（轮询进度）

接口契约：
```
GET /api/import/status?jobId=xxx
→ 200 { ok: true, job: {
    id, state: "running|done|failed",
    phase?: "scan|vectorize|persist",
    progress?: { done, total },
    result?: ImportResult,
    error?: string
  } }
→ 404 { ok: false, error: "job not found" }   # 服务重启后 job 丢失
```

- 轮询频率：前端 2s；`state=done` 停止轮询
- 进度来源：`handleDirectImport` 的进度走 stderr（`logProgress`，src/lib/progress.ts），HTTP 服务内会混入服务日志——**v1 不接进度回调**，`progress` 字段仅保留结构，最终结果以 `result` 为准（简化实现）

## 关键决策点

| 决策 | 选择 | 被否决方案 | 否决理由 |
|------|------|-----------|----------|
| 上传格式 | JSON + base64 | multipart | 复用 `readJsonBody` 零改动；multipart 需引入解析依赖 |
| 导入执行 | 直接调 `handleDirectImport` 纯函数 | spawn CLI 子进程 | 纯函数同进程复用锁 + 中断标记，无进程开销 |
| 任务模型 | 内存 Map 异步 job | 同步阻塞 HTTP | 导入耗时（向量化 batch），HTTP 挂起不可接受 |
| 进度回调 | v1 不做，结果为准 | 注入 logProgress 回调 | `logProgress` 走 stderr 无结构化回调；v1 简化 |
| 上传目录 | `~/.ki/import-uploads/<uploadId>/` | scope sourceDir 直写 | 受控目录防路径注入，导入前可预览 |

## 接口 Demo

```json
// POST /api/import/upload
{
  "ok": true,
  "uploadId": "a1b2c3d4-...",
  "files": [ { "name": "docs/alarm/告警收敛.md", "path": "~/.ki/import-uploads/a1b2c3d4/docs/alarm/告警收敛.md", "size": 2048 } ],
  "total": 1
}
```

```json
// POST /api/import/run
{ "ok": true, "jobId": "job-001" }
```

```json
// GET /api/import/status?jobId=job-001
{
  "ok": true,
  "job": {
    "id": "job-001",
    "state": "done",
    "result": {
      "ok": true, "action": "import", "mode": "full", "scope": "wiki-test",
      "stats": { "total": 1, "imported": 1, "vectorized": 1, "errors": 0, "skipped": 0, "vector": true },
      "errors": [], "groups": ["wiki"], "source": "local"
    }
  }
}
```

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|:---:|
| 上传文件格式非法 | 400 拒绝，列非法文件 | ✅ |
| 上传超 16MB | 400 "too large"，提示分批 | ✅ |
| 同 scope 导入锁冲突 | job 置 failed + error 文案 | ✅ |
| uploadId 不存在 | 400 "upload not found" | ✅ |
| jobId 不存在（服务重启） | 404 "job not found" | ✅ |
| 导入中途失败 | job state=failed + error；部分成功见 result | ✅ |

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/lib/mcp-http.ts` | `handleApiRequest` 加 `/api/import/*` 分发 + 三端点实现 |
| `src/lib/import-job.ts`（新增） | job 内存管理（创建/查询/清理） |
| 复用 | `handleDirectImport`/`handleIncrementalDirect`（不改） |

## 待定问题

| 问题 | 说明 | 状态 |
|------|------|------|
| ~~上传整体大小策略~~ | 16MB 上限 + 前端分批 vs 服务端多段接收 | ✅ 已定（评审修复）：**前端分批**——每批文件总大小 ≤ 16MB（readJsonBody 上限），分批调 `/api/import/upload` 落盘同一 uploadId；上传完成后由前端汇总文件清单展示 |
| job 清理 | 完成后保留多久（建议 TTL 1h + 上限 50 个） | 技术评审确认 |

## 变更记录

- 2026-08-08 v1：初版
