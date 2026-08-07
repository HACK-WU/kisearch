# 体验计划 Batch1：外部Wiki直导链路

> requirement_ref: REQ-20260806-001（REQ-01/02/04/06 + §4.4）
> 前置门禁：e2e journey-wiki-direct-import ✅ PASS
> 策略：负面/边界路径优先（错误反馈是体验核心），正向补进度反馈

## 体验点

| # | 体验点 | 类型 | 操作 | 预期（规格锚定） |
|---|--------|------|------|------------------|
| 1 | 空目录直导 | 负面 | `import --source <空目录> --root-name X` | 明确报错"目录下未发现 .md 文件" |
| 2 | sourceDir 不存在 | 负面 | `import --source /no/such --root-name X` | 明确报错"不存在或不是目录" |
| 3 | full 缺 root-name | 负面 | `import --source <dir>`（无 --root-name） | 前置校验报错"必须传 --root-name" |
| 4 | 未知 mode | 负面 | `import --source <dir> --mode bogus` | 报错"未知 --mode" |
| 5 | 未首导跑增量 | 负面 | 新 scope 直接 `--mode incremental` | 报错"尚未首次导入" |
| 6 | 大文件跳过 | 边界 | 直导含 3MB 文件的目录 | 告警"文件过大已跳过"+ 最终统计含 skipped |
| 7 | 切分进度反馈 | 正向 | 直导含大文件目录 | 输出"切分完成：共 N chunks"统计 |
| 8 | 自动备份反馈 | 正向 | 直导成功 | "自动备份完成"提示 |

## 执行环境
- 隔离 config：`/tmp/ki-exp-config.yaml`（独立 dataDir/vectorDir）
- 观察维度：正确性 + 错误反馈友好度 + 进度可见性
