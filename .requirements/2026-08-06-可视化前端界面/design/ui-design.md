---
id: REQ-20260806-003
feature: 可视化前端界面
status: 设计中
created: 2026-08-06
updated: 2026-08-06
version: 1
tags: [feat, ux, ui]
depends_on: [REQ-20260806-001]
author: AI
document_type: ui-design
---

# UI 设计：可视化前端界面（首页总览）

> 定位：ui-designer 产出 —— 交互逻辑（interaction-design.md）→ 视觉层（本文件）→ 技术设计（design-craft）
> 风格基准：**zvec-studio 前端**（Apple 风，tokens.css 逐项对齐），场景匹配失败降级为内置默认风格（ui-tools 未安装）

## 1. 概述与输入来源

- **输入**：`interaction-design.md` 场景 S-01（总览 Dashboard）；需求文档 REQ-20260806-003 功能清单 F02/F09
- **风格参考**：`zvec-studio/apps/frontend/src/styles/tokens.css`、`layouts/AppShell.css`、`pages/collections/*.css`（Apple 风：`#0071e3` 主色、浅灰底、卡片+细分边框、大写表头）
- **目标设备**：桌面优先（本机单用户管理工具，参考 zvec-studio 桌面布局）
- **设计范围**：首页总览 Dashboard（S-01），作为全站视觉范式样板
- **技术栈约束**：demo 为纯原生单文件 HTML，零构建（前端正式实现技术栈由 design-craft 决定）

## 2. 页面清单与信息层级

| 页面 | 目的 | 首要信息 | 次要信息 | 来源场景 |
|------|------|----------|----------|----------|
| 总览 Dashboard（首页） | 一眼看清知识库全貌：服务状态 + scope 统计 + 健康度 | 4 张统计卡（scope/向量/Group/tag）、scope 列表卡 | 健康状态列表、服务横幅 | S-01 |

信息优先级：统计数字 > scope 卡片列表 > 健康状态。

> 入口去重决策（2026-08-06，两轮）：侧边栏导航为**唯一**页面入口。第一轮删除「导入知识库」按钮 + 快捷操作卡；第二轮删除页头「⇪ 上传文档」按钮（与侧边栏"上传导入"重复）。页头不再放置任何主操作，与 zvec 欢迎页"页头无操作按钮"一致。空状态引导按钮仍保留（指向上传导入）。

## 3. 布局设计

```
┌─────────────────────────────────────────────────────────┐
│ Sidebar 232px  │  Topbar 52px: 总览 · 服务状态徽标 · 刷新  │
│   Logo         ├─────────────────────────────────────────┤
│   导航:         │  Content (padding 24px, max 1440px)      │
│   总览(active)  │  [服务未就绪横幅]                         │
│   知识库        │  [统计卡 × 4]  Scope 向量 Group tag        │
│   搜索          │  [Scope 列表卡]  (彩色圆点+名称+徽标+统计)  │
│   上传导入       │  [健康状态卡]   ✅/⚠️/❌ 检查项             │
│   写入          │                                           │
│   向量可视化 ↗   │                                           │
│   ──────────   │                                           │
│   footer: 版本  │                                           │
└─────────────────────────────────────────────────────────┘
```

- **布局模式**：侧边栏导航 + 单列内容（master-detail 变体），与 zvec-studio AppShell 完全一致
- **栅格**：统计卡 4 列网格（`repeat(4, 1fr)`，gap 12px）；<1024px 降 2 列；<640px 降 1 列
- **Scope 列表卡**：表格式行（圆点 · 名称+路径 · 徽标 · 统计 · 操作），hover 行高亮 + 操作浮现

## 4. 组件与状态

| 组件 | 默认 | 悬停 | 聚焦 | 禁用/加载 | 错误/空 |
|------|------|------|------|-----------|---------|
| 主按钮 `.ki-btn--primary` | 主色底 #0071e3 白字 圆角8 | #0077ed | — | loading spinner + 禁用 | — |
| 次级按钮 | 白底描边 rgba(0,0,0,0.1) | #f5f5f7 | — | — | — |
| 统计卡 | 白底 圆角12 1px 边框 | 浅蓝高亮边框 | — | 骨架屏（灰块动画） | — |
| 服务状态徽标 | 绿点"已就绪"/红点"未就绪" | — | — | 灰点"检测中" | — |
| 空状态 | 虚线边框 + 引导文案 + 主按钮 | — | — | — | "暂无 scope，导入第一个知识库" |
| 破坏性操作 | 危险红字按钮 | 红底 8% 透明 | — | — | 需确认弹窗 |

## 5. 视觉 Token（继承 zvec-studio tokens.css，100% 对齐）

| Token | 值 | 用途 |
|-------|-----|------|
| `--ki-color-bg` | #fafafa | 页面背景 |
| `--ki-color-bg-secondary` | #f5f5f7 | 侧边栏背景 |
| `--ki-color-surface` | #ffffff | 卡片表面 |
| `--ki-color-border` | rgba(0,0,0,0.06) | 细分隔线 |
| `--ki-color-border-strong` | rgba(0,0,0,0.1) | 输入框/强边框 |
| `--ki-color-text` | #1d1d1f | 正文 |
| `--ki-color-text-muted` | #636366 | 次要文本 |
| `--ki-color-text-subtle` | #98989d | 弱文本/表头 |
| `--ki-color-primary` | #0071e3 | 主操作/链接 |
| `--ki-color-primary-hover` | #0077ed | 主按钮悬停 |
| `--ki-color-success` | #34c759 | 成功/就绪 |
| `--ki-color-warning` | #ff9500 | 警告 |
| `--ki-color-danger` | #ff3b30 | 危险/未就绪 |
| `--ki-color-purple` | #af52de | 辅助色 |
| `--ki-space-1..8` | 4/8/12/16/20/24/32 | 间距 |
| `--ki-radius-sm/md/lg` | 8/12/16 | 圆角 |
| `--ki-font-family` | -apple-system, SF Pro Text, Helvetica Neue, PingFang SC, sans-serif | 字体 |
| `--ki-font-mono` | SF Mono, Menlo, Monaco, monospace | 等宽 |
| `--ki-font-size-xs..2xl` | 11/12/13/15/17/20/28 | 字号 |
| `--ki-header-height` | 52px | 顶栏高 |
| `--ki-sidebar-width` | 232px | 侧边栏宽 |
| `--ki-shadow-1/2` | 0 1px 3px rgba(0,0,0,0.08) / 0 4px 24px rgba(0,0,0,0.12) | 阴影 |

**暗色模式**：`[data-theme="dark"]` 全套变量覆盖（主色 #2997ff、背景 #1a1a1e、表面 #2c2c30），与 zvec-studio 一致。

**ki 特有约定**（zvec-studio 无，本设计新增）：
- scope 彩色圆点：蓝(primary)/绿(success)/紫(purple)/橙(warning)/青(info) 轮转，标识 scope 身份
- 两层状态徽标：KB（紫）/ 向量（蓝）/ 注册（绿）—— 对应 `scope list` 的 `kb/vector/registered` 布尔
- 得分徽标（搜索页用）：RRF 得分，非百分比

## 6. 响应式规则

| 断点 | 布局变化 |
|------|----------|
| ≥1024px | 统计卡 4 列；侧边栏展开 |
| 640–1024px | 统计卡 2 列；侧边栏可折叠 |
| <640px | 统计卡 1 列；侧边栏隐藏为抽屉（demo 演示折叠按钮） |

## 7. Demo 交互（原生 JS 演示性质）

- 主题切换（light/dark，localStorage 记忆）
- 侧边栏折叠
- 服务状态切换（就绪/未就绪横幅演示）
- 空状态演示（无 scope 引导）
- 统计卡骨架屏加载态
- 无真实后端，数据为 mock

## 8. 待确认项

| 编号 | 事项 | 状态 |
|------|------|------|
| U-01 | 首页统计口径（向量数 = vectorCountScope 各 scope 之和？Group/tag 统计来源） | 待 design-craft 确认 |
| U-02 | 徽标组合在 scope 行内的展示宽度（三个徽标可能过挤） | demo 已用缩写方案（KB/VEC/REG），待确认 |
| U-03 | 暗色模式首版是否要做 | demo 已含，待确认是否纳入正式实现 |

## 9. Demo 文件

位于 `demo/`（本需求目录下），零构建多页面，共享 `shared.css`（token 全站一致），导航真实跳转：

| 文件 | 页面 | 覆盖场景 |
|------|------|----------|
| `index.html` | 总览 Dashboard | S-01 |
| `browse.html` | 知识库浏览（文件夹层级 Group 树 + 文档列表 + 原文抽屉） | S-02 |
| `search.html` | 语义搜索（tags/threshold/limit + RRF 得分 + 空结果） | S-03 |
| `import.html` | 上传导入（文件/目录 + 切分参数 + 进度 + 结果） | S-04 |
| `write.html` | 知识写入（store / sync-relation / 批量 + 校验） | S-05 |
| `shared.css` | 共享样式（token + 布局壳 + 公共组件） | — |

> S-06 管理页**已删除**（2026-08-06 决策：破坏性操作集中易误操作，前端不提供删除/清空/备份恢复入口；此类操作保留在 CLI `ki scope delete/clear`，由熟悉命令的管理员执行）。S-07 向量可视化 = 侧边栏外链跳转 `http://127.0.0.1:7861`，无需独立页面。

**变更记录**：
- 2026-08-06：① 删除管理页 manage.html 及侧边栏"管理"导航（防误操作）；② Group 树由扁平节点改版为**文件夹层级样式**（文件夹/文件图标 + 层级缩进引导线 + 热度徽标保留），贴近 Finder 文件树。
