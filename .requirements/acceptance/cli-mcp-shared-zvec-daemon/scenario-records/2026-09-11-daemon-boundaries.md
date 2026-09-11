# L2 场景记录：daemon 状态与边界反馈

- 需求：REQ-20260910-001
- 验收轮次：round-1
- 执行日期：2026-09-11
- 环境：本机 `127.0.0.1:7423`，用户已重启的本地 daemon；仅执行只读探针和必然拒绝的非法参数，不写入默认知识库。
- 凭证：未使用、未记录。

## 场景步骤与观察

| 步骤 | 操作 | 实际观察 | 判定 |
|------|------|----------|------|
| S1 | `curl http://127.0.0.1:7423/healthz` | HTTP 200；`ok=true`、`identityDrift=false`、队列为空；返回 `vectorResources` 的打开/释放次数、耗时和峰值 | ✅ |
| S2 | `ki search --scope '../acceptance-boundary' --query '验收边界' --limit 1` | exit 1；JSON 明确指出 scope 不合法、禁止路径遍历字符，并列出 `.` 与 `/` | ✅ |
| S3 | 查询不存在的 `/api/restore/status?jobId=acceptance-no-such-job` | HTTP 404、`Content-Type: application/json`；提示 job 可能因服务重启不存在，应重新提交 | ✅ |
| S4 | `ki mcp --status` | `running=true`、healthz 正常、目标仍为 7423、无 stdio 实例、队列为空 | ✅ |

## 指标映射

- M-03：S2 验证 scope 边界拒绝；S1/S4 验证身份漂移状态可观测。
- M-07：S1/S3/S4 验证健康、资源、job 不存在和恢复提示均为用户可读的结构化反馈。

## 限制

- 本记录不覆盖真实大规模 restore/rebuild 中途取消；该项需独立大 fixture 演练。
- 本记录不把默认 daemon 的只读状态检查当作真实写入性能证据；性能结论来自 L3 stage3 e2e。
