---
kind: frontend_style
name: ki Web 前端 CSS 设计令牌与原子化样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - web/src/styles/ki.css
    - web/src/App.tsx
    - web/vite.config.ts
    - web/package.json
    - web/src/components/MarkdownPreview.tsx
    - web/src/pages/SearchPage.tsx
---

## 1. 采用的样式系统

ki 的 Web UI（位于 `web/`）是一个独立的 Vite + React 工程，采用**纯 CSS + CSS Custom Properties（CSS 变量）**的设计令牌方案，不依赖任何 CSS-in-JS、Tailwind、Ant Design 等第三方 UI 库。所有样式集中在单一文件 `web/src/styles/ki.css`（约 960 行），在 `App.tsx` 中全局引入。

- **构建工具链**：Vite (`vite.config.ts`) + `@vitejs/plugin-react`；构建产物输出到 `web/dist`，由后端 ki MCP HTTP 服务以静态资源形式提供。
- **主题机制**：通过 `:root` 定义浅色主题的所有设计令牌，并通过 `[data-theme="dark"]` 覆盖同一组变量实现深色模式切换（见 `ki.css` 第 8–92 行）。
- **命名空间**：所有类名统一以 `ki-` 前缀开头（如 `.ki-btn`、`.ki-card`、`.ki-sidebar`、`.ki-search-form`），避免与页面内容或第三方库冲突。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `web/src/styles/ki.css` | 全部样式与设计令牌（颜色、间距、圆角、字体、阴影、动效时长） |
| `web/src/App.tsx` | 应用根组件，唯一引入 `./styles/ki.css` 的位置 |
| `web/vite.config.ts` | Vite 配置，定义 `@` 路径别名、开发代理、构建目标 `es2022` |
| `web/package.json` | 仅声明运行时依赖（react、react-router-dom、marked、mermaid、@tanstack/react-query），无 CSS 相关依赖 |
| `web/src/components/MarkdownPreview.tsx` | Markdown 渲染组件，使用 `marked` 并禁用原始 HTML，配合 `.ki-markdown` 样式 |
| `web/src/pages/SearchPage.tsx` | 搜索页示例，展示如何使用 `ki-*` 类名组合出表单、结果列表、标签筛选等界面 |

## 3. 架构与约定

### 3.1 设计令牌（Design Tokens）

所有视觉变量集中在 `:root` 下，按语义分组：
- 背景/表面：`--ki-color-bg`、`--ki-color-bg-secondary`、`--ki-color-surface`、`--ki-color-border`、`--ki-color-border-strong`
- 文本：`--ki-color-text`、`--ki-color-text-muted`、`--ki-color-text-subtle`
- 品牌/功能色：`--ki-color-primary`（及 hover/active）、`--ki-color-success`、`--ki-color-warning`、`--ki-color-danger`、`--ki-color-info`、`--ki-color-purple`
- 间距：`--ki-space-1`（4px）至 `--ki-space-8`（32px）
- 圆角：`--ki-radius-sm/md/lg`（8/12/16px）
- 字体：`--ki-font-family`（Apple System / SF Pro / PingFang SC）、`--ki-font-mono`、字号从 xs 到 2xl
- 布局常量：`--ki-header-height`（52px）、`--ki-sidebar-width`（232px）、`--ki-content-max-width`（1440px）
- 交互态：`--ki-color-hover`、`--ki-color-hover-strong`、`--ki-color-surface-muted`、`--ki-color-bg-muted`、`--ki-color-scrollbar`
- 阴影：`--ki-shadow-1`、`--ki-shadow-2`
- 动效：`--ki-motion-fast`（150ms）

深色主题通过 `[data-theme="dark"]` 选择器覆盖上述同名变量，保持组件样式代码完全不变。

### 3.2 组件级原子类

`ki.css` 将常用 UI 元素抽象为可复用原子类，涵盖：
- 布局壳：`.ki-shell`、`.ki-sidebar`、`.ki-main`、`.ki-topbar`、`.ki-content`
- 通用组件：`.ki-btn`（含 `--primary/--secondary/--danger/--small/--ghost` 变体）、`.ki-card`、`.ki-table`、`.ki-badge`、`.ki-banner`、`.ki-stats`、`.ki-stat-card`、`.ki-skeleton`、`.ki-progress`、`.ki-dropzone`、`.ki-file-item`、`.ki-health-item`、`.ki-empty`、`.ki-toast`、`.ki-overlay`、`.ki-dialog`
- 表单：`.ki-form-group`、`.ki-form-label`、`.ki-form-input`、`.ki-form-textarea`、`.ki-form-select`、`.ki-checkbox-label`、`.ki-switch`、`.ki-combobox`、`.ki-range`
- 导航与树：`.ki-nav-item`、`.ki-tree-root`、`.ki-tree-dir`、`.ki-gtree-dir`
- 搜索结果：`.ki-qr-item`、`.ki-qr-rank`、`.ki-qr-body`、`.ki-score-bar`
- 抽屉：`.ki-drawer`、`.ki-drawer__head/__body/__foot/__scrim`、`.ki-drawer--fullscreen`
- Markdown 阅读：`.ki-markdown`、`.ki-mermaid`

### 3.3 响应式策略

采用**移动端优先的断点式媒体查询**：
- `max-width: 1024px`：统计卡片网格从 4 列变为 2 列，双栏布局 `.ki-split` 退化为单栏
- `max-width: 640px`：内容区 padding 缩小、表格隐藏第 3/4 列、表单行改为单列

### 3.4 主题与暗黑模式

通过在 `<html>` 或 `<body>` 上设置 `data-theme="dark"` 即可切换全站点主题，无需 JS 层状态管理。`color-scheme` 也同步切换，使浏览器原生控件（滚动条、选中等）适配暗色。

## 4. 约定与约束

- **类名前缀强制**：所有自定义类名必须以 `ki-` 开头，确保与页面内容、第三方库（marked、mermaid）样式隔离。
- **零 CSS 依赖**：项目未安装 Tailwind、PostCSS、Sass/Less、CSS Modules 或 CSS-in-JS；所有样式均为原生 CSS，注释明确标注“零构建：纯 CSS，浏览器直接加载”。
- **设计令牌集中管理**：颜色、间距、圆角、字体、阴影、动效时长等全部通过 CSS 变量定义，禁止在组件样式中硬编码具体数值。
- **主题一致性**：浅色/深色两套变量一一对应，新增颜色必须同时补充两个主题的对应变量。
- **组件样式粒度**：每个 UI 元素拆分为基础类 + 修饰类（BEM 风格，如 `.ki-btn--primary`、`.ki-tab--active`、`.ki-tag-chip--active`），通过 class 拼接组合。
- **安全约束**：Markdown 预览组件显式丢弃原始 HTML（`renderer.html = () => ''`），防止知识库文档注入样式或脚本。
- **构建产物隔离**：`vite.config.ts` 中 `sourcemap: false`，生产构建不生成 source map；开发时通过 proxy 将 `/api`、`/mcp`、`/healthz` 转发到本机 ki MCP 服务（端口 7423）。
- **字体栈**：优先使用 Apple System / SF Pro / PingFang SC 等系统字体，保证跨平台一致外观。
- **动画规范**：所有过渡动画统一使用 `--ki-motion-fast`（150ms），避免随意定义不同时长。