# AI 对话独立页（/chat）视觉精修方案

> 来源：product-manager M4 走查（2026-10-10，用户截图 + 代码直读）→ 接力 ui-designer。
> 输入性质：需求描述 + M4 发现清单（无独立交互设计文档；交互流程沿用 REQ-20261008-001 已定实现，本方案只动视觉层）。
> 关联实现：`web/src/pages/ChatPage.tsx`、`web/src/chat/ChatPanel.tsx`（page 变体）、`web/src/chat/ConversationList.tsx`（inline 变体）、`web/src/styles/ki.css:2316-3450`（对话面板段 + 独立页段）。
> Demo：`demo/chat-page-redesign/index.html`（零构建单文件）。

## 1. 背景与根因

设计基准 demo（`demo/chat-tools-config/index.html`）只覆盖 dock 面板形态；/chat 独立页是 web 端后续自行扩展（`ki.css:3371-3450`），**无页面级设计基准**，导致它与其他六个 tab 的「page-head + 白卡 + mono kicker 卡头」语言脱节——这是「不够精致」的根因（M4 F1–F6）。

## 2. 设计约束（不可违背）

| 约束 | 出处 |
|------|------|
| 暖中性色板 + 深绿强调 `#2d6755`；一个强调色锁（选中/主操作/进度一律 primary） | `ki.css:4,21-23` |
| 语义色（success/warning/danger）只用于状态徽标与横幅 | `ki.css:22-23` |
| 圆角刻度：面板 14 / 控件 6 / 标签 4 / 胶囊 999 | `ki.css:44` |
| **页内卡片不用阴影，仅浮层用阴影** | `ki.css:71` |
| dock 面板形态不受本方案影响（所有 page 样式限 `.ki-chat-panel--page` 作用域） | 接力影响面评估 |
| 昨日精修的组件层（代码块工具条、来源 chip、时间线、思考块）不动 | M4 排除项 |

## 3. 页面结构

单页：`/chat`（含 `/chat/:convId` 深链）。信息优先级：

- 首要：消息流 + 输入区（composer）
- 次要：当前会话身份（标题/模型/状态）
- 辅助：会话列表管理（搜索/新建/归档/删除）

## 4. 布局

桌面（≥1024px）双栏工作台，沿用现有 grid `264px + 1fr`、主列对话列 880px 居中不变：

```
┌────────────────────────────────────────────────────────────────┐
│ AppShell 顶栏（既有，不动）                                       │
├──────────────┬─────────────────────────────────────────────────┤
│ 左栏 #f9faf8 │ 主列 #f5f6f3（底色分色，新增）                      │
│ ┌──────────┐ │ ┌─────────────────────────────────────────────┐ │
│ │栏头 57px  │ │ │会话头 57px（新）：标题+mono副行｜状态pill+配置│ │
│ │kicker+计数│ │ ├─────────────────────────────────────────────┤ │
│ ├──────────┤ │ │                                             │ │
│ │搜索框(白卡)│ │ │   消息流（880 居中，滚动）                     │ │
│ ├──────────┤ │ │   · 空态：图标+标题+建议chips（新）             │ │
│ │最近      │ │ │   · user 气泡：白底+边线（改）                 │ │
│ │▌会话项   │ │ │   · assistant 平铺 + meta + 来源 + 操作条       │ │
│ │ 会话项   │ │ │   · 日期分隔线（新）                           │ │
│ │  …       │ │ │                                             │ │
│ ├──────────┤ │ ├─────────────────────────────────────────────┤ │
│ │+新建会话  │ │ │composer 卡：focus 光环/hint 降噪/发送钮 36px   │ │
│ │(全宽主钮) │ │ └─────────────────────────────────────────────┘ │
│ └──────────┘ │                                                 │
└──────────────┴─────────────────────────────────────────────────┘
```

窄屏（<1024px）：左栏转覆盖式抽屉（沿用现有 `ki.css:3430-3447` 方案，不动）。

## 5. 精修点明细（D1–D7 ↔ M4 F1–F6）

### D1 会话头（新增，取代 `ki-chat-ctx` 细条在 page 下的呈现）
- 结构：左 = 会话标题（15px/600，单行省略）+ mono 副行 xs `qwen3.8-flash · 12 条 · 更新 10:42`；右 = 状态 pill + 配置 iconbtn + 窄屏列表钮。
- 样式：surface 白底、底边线、高 57px、padding 0 20px——对齐各页卡头节奏（62px 卡头的对话语境变体）。
- 状态 pill：胶囊 999、`bg-muted` 底、6px 状态灯（就绪 success / 生成中 primary 脉冲 / 未就绪 subtle）+ xs 文案。语义仅此处使用状态色，合规。
- dock 面板继续用原 `ki-chat-ctx`，不受影响。

### D2 底色分色
- 左栏 `bg-secondary #f9faf8`、主列 `bg #f5f6f3`：0 成本获得纵深，无需阴影。

### D3 user 气泡
- `surface #fff` + `border-strong #c8d3c9`（去 `surface-muted` 灰底；demo 走查发现弱边线在灰底上近隐形，升一级）；圆角 14 保持；右对齐保持。

### D4 空态
- 图标 52px、圆角方块 14px、`primary-soft` 底 + primary 图标（取代灰圆）；标题 17px/600；描述 13px muted。
- 渲染已预留未使用的提问建议 chips（`ki.css:2465-2472` 的 `.ki-chat-q`）：2×2 网格、白卡 + 边线、hover primary 边 + `primary-soft` 底；点击填入 composer。

### D5 左栏列表
- 栏头（57px，与主列头同高对齐）：mono kicker「会话」+ 右缘 mono 计数 + 新建 iconbtn。
- 搜索框：白卡 + 边线 + 左放大镜图标，focus primary 环。
- 分组标签「最近/已归档」：mono xs 大写 subtle（对齐表格表头语言）。
- 会话项：两行（标题 13px/500 省略 + mono xs 副行「6 条 · 昨天 20:59」）；选中 = 白卡 + 边线 + 左 3px primary 竖条；操作图标 hover 浮现（沿用）。
- 栏脚：全宽主按钮「+ 新建会话」（38px）+ 刷新 iconbtn。

### D6 composer
- `focus-within`：border-primary + `0 0 0 3px` primary 18% 光环（对齐 dock 重设计基准 `demo/chat-panel-redesign/index.html:484`）。
- hint「Enter 发送 · Shift+Enter 换行」聚焦才显现（默认隐藏降噪）——待确认 Q3。
- 发送按钮：36px 高、padding 0 16、radius 6、primary 实心 + ↑ 图标；禁用态 `surface-muted` 底 + subtle 字（不只靠透明度，沿用 `ki.css:2930` 约定）。

### D7 日期分隔线
- mono xs subtle 居中文本 + 两侧 1px 线，长会话按天分段。

## 6. 组件状态表（新增/变更部分）

| 组件 | 状态 | 视觉 |
|------|------|------|
| 会话项 | 默认/hover/选中/损坏 | 透明 / `hover` 浅底 / 白卡+边线+左 3px primary 竖条 / 灰化禁用 |
| 状态 pill | 就绪/生成中/未就绪 | success 灯 / primary 灯+脉冲 / subtle 灯 |
| composer | 默认/聚焦/禁用 | border-strong / primary 边+光环 / 50% 透明 |
| 发送按钮 | 可用/禁用/hover/active | primary 实心 / surface-muted+subtle / primary-hover / 下沉 1px |
| 建议 chip | 默认/hover | 白卡边线 / primary 边+primary-soft 底 |
| 空态 | 默认 | §5 D4 |
| 失败提示 | err | 沿用 `ki-chat-alert--err`，含重试按钮 |
| 生成中 | streaming | 沿用时间线脉冲 + `ki-chat-reason__spin`，不动 |
| 窄屏 | <1024 | 左栏抽屉 + 遮罩（沿用） |

## 7. Token 总表

全部复用 `--ki-*`（见 `ki.css:9-76`），零新增色值/字号/间距。新增布局尺寸（page 作用域）：

| token | 值 | 用途 |
|-------|-----|------|
| `--ki-chatpage-head-h` | 57px | 会话头 / 左栏头高度 |
| `--ki-chatpage-side-w` | 264px | 左栏宽（现 260，微调对齐 4 的倍数，待确认） |
| `--ki-chatpage-main-max` | 880px | 对话列宽（不变） |

## 8. 响应式规则

- ≥1024px：双栏（§4）。
- <1024px：左栏转抽屉，会话头左侧出现列表钮（沿用现有实现）。

## 9. 待确认项

| ID | 内容 | 默认处理（demo 按此实现） |
|----|------|--------------------------|
| Q1 | 会话头副行信息组合（模型 · 条数 · 更新时间） | 三者全显，mono xs |
| Q2 | 主列底色分色方向（主列深 #f5f6f3 / 左栏亮 #f9faf8） | 按左栏亮、主列深实现 |
| Q3 | composer hint 聚焦才显示 | 聚焦显示，默认隐藏 |
| Q4 | 空态建议 chips 内容来源 | demo 静态示例；落地时建议按 scope 静态配置 |
| Q5 | 左栏宽 260→264 微调 | 可与落地时一并决定，亦可不改 |

### challenger 二次质疑回填（2026-10-10）

| ID | 质疑（风险） | 建议处置 |
|----|-------------|----------|
| Q6（C1 🟡中） | D3 气泡 / D6 composer 是 page/dock 共享样式，"限 page 作用域"会导致两形态视觉分叉；共享改则波及 dock | **需用户拍板**：建议同步 dock（dock 重设计 demo 本就是此方向）；若 page-only 需接受分叉 |
| Q7（C2 🟡中） | assistant 正文仍裸铺灰底，"对齐白卡语言"目标只达成一半；取舍未记录 | 补"备选与取舍"：assistant 平铺是长文呼吸感与代码块宽度的有意取舍，还是被拒的备选？ |
| Q8（C3 🟡低） | 零会话（一个会话都没有）时会话头呈现未定义 | 落地时定义：标题「未选择会话」+ 副行仅模型名 + pill 禁用 |
| Q9（C4 🟡低） | 会话头 pill 与 fail-loud banner 信息冗余 | banner 保留（处置入口），pill 只读降级 |
| Q10（C5 🟡低） | D7 日期分隔线需 TSX 分组逻辑（非纯 CSS）且短会话是噪音 | 降级为可选，或从本期剔除 |
| Q11（C6 🟡低） | D6"对齐 dock 基准"措辞误导（该基准未落地） | 改为"与 dock 重设计方向参考一致" |

## 10. 落地同步清单（供 request-guard/code-review 阶段使用）

1. `ki.css` 独立页段（3371-3450）纯追加新规则，全部限 `.ki-chat-panel--page` 作用域；不改 dock 任何规则。
2. `ChatPanel.tsx`：page 变体下 `ki-chat-ctx` 升级为会话头结构（标题 + 副行 + 状态 pill）；空态补渲染建议 chips。
3. `ConversationList.tsx` inline 变体：栏头 + 栏脚结构调整（视觉层，无交互变更）。
4. demo 验证截图与走查记录随需求文档归档。
