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

# S-05：zvec-studio 占位跳转 + 端到端集成

## 术语

| 术语 | 定义 |
|------|------|
| 占位跳转 | 前端仅提供外链（`http://127.0.0.1:7861`），不启动/不检测/不打开 ki 向量库（v3 决策） |
| zvec-studio | 向量可视化工具（用户手动启动，端口 7861） |

## 现状（AS-IS）

- demo 侧边栏已有"向量可视化"外链（`http://127.0.0.1:7861`，target=_blank）
- ki 无 zvec-studio 启动/检测逻辑；v3 决策：前端不负责启动

## 方案（TO-BE）

### 1. 占位跳转

`web/src/components/Sidebar.tsx`：集成区"向量可视化"链接 → `http://127.0.0.1:7861`，`target="_blank"` `rel="noopener noreferrer"`。

- **不检测** zvec 是否启动（v3：前端不启动/不检测）
- 用户未启动 zvec → 浏览器显示连接失败，属预期行为（文档指引用户手动 `zvec-studio --port 7861`）
- **不打开 ki 向量库**（后续实现，不在本需求）

### 2. 端到端集成

| 集成点 | 说明 |
|--------|------|
| 启动命令 | `ki mcp --http --web`（S-01）→ 7423 提供页面 + MCP + `/api/*` |
| 用户访问 | 浏览器 `http://127.0.0.1:7423/` |
| 通信链路 | 页面 → MCP SDK（`/mcp`，同源）+ `/api/*` → ki 核心 |
| zvec | 用户手动 `zvec-studio --port 7861` → 外链跳转（占位） |

### 3. 验收冒烟（联调脚本）

```bash
# 0. 前置：手动启动 zvec-studio（可选，步骤 8 需要）
zvec-studio --port 7861

# 1. 构建前端
cd web && npm install && npm run build

# 2. 启动服务
ki mcp --http --web

# 3. 浏览器访问 http://127.0.0.1:7423/ → 总览页显示 scope 列表 + 健康状态
# 4. 浏览页：输入文件名关键词 → 文档列表按文件名过滤 + Group 分组
# 5. 搜索页：输入查询 → 结果含原文内容 + Group 路径 → 点击看原文
# 6. 上传页：选 scope → 上传文件 → 导入进度 → 完成后搜索验证
# 7. 写入页：选 scope → 单条写入 → 搜索结果可见
# 8. 侧边栏"向量可视化"→ 外链 7861（zvec 已手动启动）
```

## 关键决策点

| 决策 | 选择 | 被否决方案 | 否决理由 |
|------|------|-----------|----------|
| zvec 集成 | 占位外链 | 检测/启动/打开集合 | v3 决策：不启动、不打开 ki 向量库；后续实现 |
| 集成验证 | 冒烟脚本 + 人工验收 | 自动化 e2e | 涉及真实向量库 + 外部 zvec，人工冒烟足够 |

## 影响范围

| 文件 | 改动 |
|------|------|
| `web/src/components/Sidebar.tsx` | 集成区外链 |
| `docs/` 或 README | 用户启动指引（`ki mcp --http --web` + `zvec-studio --port 7861`） |

## 变更记录

- 2026-08-08 v1：初版
