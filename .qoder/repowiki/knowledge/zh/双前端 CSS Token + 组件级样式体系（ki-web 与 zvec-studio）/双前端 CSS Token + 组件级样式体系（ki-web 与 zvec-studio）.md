---
kind: frontend_style
name: 双前端 CSS Token + 组件级样式体系（ki-web 与 zvec-studio）
category: frontend_style
scope:
    - '**'
source_files:
    - web/src/styles/ki.css
    - web/index.html
    - zvec-studio/apps/frontend/src/styles/tokens.css
    - zvec-studio/apps/frontend/src/styles/theme.ts
    - zvec-studio/apps/frontend/src/layouts/AppShell.css
    - zvec-studio/apps/frontend/src/components/ui/Button.css
---

## 1. 使用的系统/方法

仓库包含两个独立的前端应用，均采用 **原生 CSS + CSS Custom Properties（CSS 变量）** 的零构建样式方案，没有引入 Tailwind、Sass/Less、Styled Components 等框架：

- **ki Web（`web/`）**：基于 React + Vite 的知识库演示界面，所有样式集中在 `src/styles/ki.css` 一个文件中，通过 `<link>` 直接加载，注释明确标注“零构建：纯 CSS，浏览器直接加载”。
- **zvec-studio 前端（`zvec-studio/apps/frontend/`）**：基于 React + Vite 的向量数据库工作台，采用按组件拆分 `.css` 文件的原子化组织方式，并通过独立的 `src/styles/tokens.css` 集中管理设计令牌。

两者都使用 **CSS 主题切换**：通过在 `<html>` 上设置 `data-theme="dark"` 并配合 `color-scheme` 切换明暗主题。ki-web 的主题切换由页面逻辑控制；zvec-studio 通过 `src/styles/theme.ts` 暴露 `useTheme()` Hook，支持 `light | dark | system` 三种模式，并将偏好持久化到 `localStorage('zv-theme')`，同时监听 `prefers-color-scheme` 变化。

## 2. 关键文件

- `web/src/styles/ki.css` — ki-web 全部样式（约 960 行），包含布局壳、侧边栏、按钮、表单、表格、抽屉、搜索、导入、写入等完整 UI 组件样式。
- `zvec-studio/apps/frontend/src/styles/tokens.css` — 全局设计令牌（颜色、间距、圆角、字体、阴影、动效时长）。
- `zvec-studio/apps/frontend/src/styles/theme.ts` — 主题状态管理（light/dark/system），通过 `documentElement.dataset.theme` 驱动 CSS 变量切换。
- `zvec-studio/apps/frontend/src/layouts/AppShell.css` — 应用外壳（侧边栏 + 顶栏 + 内容区）。
- `zvec-studio/apps/frontend/src/components/ui/*.css` — 基础 UI 组件样式（Button、Dialog、Input、Select、Table、Tabs、Toast、Skeleton、Spinner、EmptyState、ErrorState、DirectoryPickerDialog 等），每个组件对应一对 `.tsx` + `.css`。
- `web/index.html` — 入口 HTML，仅挂载 `#root` 和 `main.tsx`，无内联样式。

## 3. 架构与约定

### 设计令牌（Design Tokens）
两套前端各自维护一套命名空间化的 CSS 变量：
- ki-web 使用 `--ki-*` 前缀（如 `--ki-color-primary`、`--ki-space-4`、`--ki-radius-md`、`--ki-font-size-md`、`--ki-motion-fast`）。
- zvec-studio 使用 `--zv-*` 前缀（如 `--zv-color-primary`、`--zv-space-4`、`--zv-radius-md`、`--zv-font-size-md`、`--zv-motion-fast`）。

令牌覆盖范围一致：背景/表面色、文本色、品牌/功能色（primary/success/warning/danger/info/purple）、间距（1–8 步长）、圆角（sm/md/lg）、字体族与字号、布局常量（header-height、sidebar-width、content-max-width）、交互态（hover、surface-muted、scrollbar）、阴影、动效时长。两套 token 值高度对齐，体现“风格对齐 zvec-studio”的设计目标（见 ki.css 顶部注释）。

### 主题系统
- 通过 `[data-theme="dark"]` 选择器覆盖 `:root` 中的变量实现明暗切换。
- ki-web 在 `ki.css` 中直接定义两套变量集合；zvec-studio 将主题逻辑抽离为 `theme.ts`，提供 `useTheme()` Hook，支持跟随系统主题。

### 组件样式组织
- **ki-web**：单文件 CSS 方案，按语义块划分（布局壳 → 公共组件 → 页面级补充样式），类名统一以 `ki-` 前缀命名（`.ki-btn`、`.ki-card`、`.ki-table`、`.ki-drawer`、`.ki-search-form` 等）。
- **zvec-studio**：组件级 CSS 方案，每个 UI 组件位于 `components/ui/<Name>.css`，类名以 `zv-` 前缀命名（`.zv-btn`、`.zv-shell`、`.zv-sidebar__item` 等），并通过 `index.ts` 统一导出。

### 响应式策略
- 基于 CSS `@media (max-width: ...)` 断点（1024px、640px）调整网格列数、隐藏表格列、折叠双栏布局等。
- 使用 CSS Grid/Flexbox 实现自适应布局，未使用媒体查询外的响应式工具库。

### 动画与过渡
- 统一通过 CSS 变量 `--ki-motion-fast` / `--zv-motion-fast`（均为 150ms）控制过渡时长。
- 自定义 keyframes：`ki-spin`、`ki-shimmer`、`ki-tree-expand`、`ki-drawer-in`、`ki-scrim-in`、`zv-spin` 等，用于加载指示器、骨架屏、树展开、抽屉滑入等效果。

## 4. 约定与约束

- **命名空间隔离**：ki-web 使用 `ki-` 前缀，zvec-studio 使用 `zv-` 前缀，避免多前端共存时样式冲突。
- **主题切换必须通过 `data-theme` 属性**：zvec-studio 的 `applyToDOM` 函数强制设置 `document.documentElement.dataset.theme` 与 `colorScheme`，禁止直接修改 body class。
- **不使用 CSS 预处理器或原子化框架**：两个前端均不依赖 Sass/Less/Tailwind，所有样式为原生 CSS，便于零构建部署。
- **Token 优先**：颜色、间距、圆角、字号、阴影、动效时长等视觉参数一律通过 CSS 变量引用，禁止硬编码具体数值。
- **组件样式与组件同目录**：zvec-studio 要求每个 `.tsx` 组件配套一个同名 `.css` 文件，保持样式与逻辑就近绑定。
- **响应式断点固定**：当前代码使用 1024px 与 640px 两个断点，新增响应式规则应沿用此约定而非引入新断点。
- **暗黑模式完整性**：新增 token 时必须同时在 `:root` 与 `[data-theme="dark"]` 下定义对应值，确保明暗主题一致性。