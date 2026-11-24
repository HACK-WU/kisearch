/**
 * event-source-analysis.test.mjs —— S-01 / S-05 前端守卫与辅助逻辑单测
 *
 * 运行：cd web && node --test test/event-source-analysis.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

const {
  shouldDefaultCheckCandidate,
  shouldOpenAiSettingsForError,
  formatAnalysisMs,
} = await vite.ssrLoadModule('/src/components/governance/AiAnalyzePanel.tsx');

after(async () => { await vite.close(); });

const eventsSrc = fs.readFileSync(path.join(webRoot, 'src/pages/EventsPage.tsx'), 'utf8');
const aiSettingsSrc = fs.readFileSync(path.join(webRoot, 'src/pages/AiSettingsPage.tsx'), 'utf8');
const layerSrc = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');
const modalSrc = fs.readFileSync(path.join(webRoot, 'src/components/governance/AiAnalyzePanel.tsx'), 'utf8');
/** 改版后「AI 分析」挂在 event-detail/EventAnalysisCard 上（批 2） */
const processPanelSrc = fs.readFileSync(
  path.join(webRoot, 'src/components/governance/AiProcessPanel.tsx'), 'utf8');
const stepMetricsSrc = fs.readFileSync(
  path.join(webRoot, 'src/components/governance/StepMetrics.tsx'), 'utf8');
const toolCallSrc = fs.readFileSync(
  path.join(webRoot, 'src/components/governance/ToolCallRow.tsx'), 'utf8');
const analysisCardSrc = fs.readFileSync(
  path.join(webRoot, 'src/components/governance/event-detail/EventAnalysisCard.tsx'), 'utf8');
/** 2026-11-17 改版：概要卡（含「AI 分析」按钮与描述编辑）已抽到 event-detail/，源码断言改指向新组件 */
const summaryCardSrc = fs.readFileSync(
  path.join(webRoot, 'src/components/governance/event-detail/EventSummaryCard.tsx'), 'utf8');
const scopePickerSrc = fs.readFileSync(path.join(webRoot, 'src/components/ScopeMultiPicker.tsx'), 'utf8');
/** 追问区（2026-11-19 改版：过程与回答复用 AI 分析排版，不再套对话气泡） */
const askBlockSrc = fs.readFileSync(
  path.join(webRoot, 'src/components/governance/event-detail/AskBlock.tsx'), 'utf8');
const kiCss = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');
const govCss = fs.readFileSync(path.join(webRoot, 'src/styles/governance.css'), 'utf8');
const pickerCss = fs.readFileSync(path.join(webRoot, 'src/styles/scope-picker.css'), 'utf8');

describe('S-05 · AiAnalyzeModal 辅助逻辑与前端守卫', () => {
  it('confidence >= 0.6 默认勾选，低置信度不默认勾选', () => {
    assert.equal(shouldDefaultCheckCandidate(0.85), true);
    assert.equal(shouldDefaultCheckCandidate(0.6), true);
    assert.equal(shouldDefaultCheckCandidate(0.59), false);
  });

  it('配置/合规类错误码引导前往 AI 分析设置', () => {
    assert.equal(shouldOpenAiSettingsForError('ANALYSIS_TARGET_NOT_CONFIGURED'), true);
    assert.equal(shouldOpenAiSettingsForError('ANALYSIS_TOOLS_ALL_DISABLED'), true);
    assert.equal(shouldOpenAiSettingsForError('ANALYSIS_DISCLOSURE_REQUIRED'), true);
    assert.equal(shouldOpenAiSettingsForError('TIMEOUT'), false);
    assert.equal(formatAnalysisMs(0), '<1ms');
    assert.equal(formatAnalysisMs(120), '120ms');
  });

  it('概要卡：「AI 分析」按钮仅受 write 权限禁用（已收口事件放行），含描述区；详情页保留代码位置区', () => {
    const aiBtnStart = summaryCardSrc.indexOf('gov-btn--ai"');
    const aiBtnBlock = summaryCardSrc.slice(aiBtnStart, summaryCardSrc.indexOf('</button>', aiBtnStart));
    assert.match(aiBtnBlock, /disabled=\{busy \|\| !canWrite\}/, 'AI 分析按钮必须受 canWrite 门禁');
    assert.match(aiBtnBlock, /AI 分析/);
    assert.match(summaryCardSrc, /事件描述/, '概要卡需包含事件描述区块（C-06：描述并入概要卡）');
    assert.match(eventsSrc, /代码位置/, '详情页需保留代码位置区（批 2 再并入分析卡）');
    assert.match(eventsSrc, /<EventAnalysisCard/, '详情页应渲染 EventAnalysisCard（AI 分析卡）');
    assert.match(modalSrc, /expectedRunId: draft\.runId/, '确认写入必须携带 expectedRunId 防并发重跑错绑');
  });

  it('AiSettingsPage & PromptConfigLayer：对齐 ops.write 与 AI 分析 5 卡配置', () => {
    assert.match(aiSettingsSrc, /can\('ops\.write'\)/, '设置页写权限应与 route-permissions 的 ops.write 对齐');
    assert.match(layerSrc, /分析目标目录/, 'AI 分析设置栏需展示分析目标目录卡片');
    assert.match(layerSrc, /analysisToolGroups/, 'AI 分析设置栏需渲染服务端下发只读工具分组');
    // 2026-11-18：分析预算 / 检索预算整体取消（用户拍板），设置页不得再出现输入框
    assert.doesNotMatch(layerSrc, /分析预算/, '分析预算卡片已取消');
    assert.doesNotMatch(layerSrc, /检索预算/, '检索预算卡片已取消');
  });
});

describe('S-01 · 分析目标目录：块级草稿 + 显式保存（2026-11-16）', () => {
  it('目录配置走显式保存，不再逐字符落盘', () => {
    assert.match(layerSrc, /function saveAnalysisDirs|const saveAnalysisDirs/, '需要有显式保存动作');
    assert.match(layerSrc, /有未保存改动/, '草稿与磁盘不一致时要有状态提示');
    /*
     * 防回退：旧实现每次输入都按整份 rows 重建 byScope，空值/非绝对路径直接跳过 ——
     * 用户清空某行想重输时，350ms 后就把这条映射删掉了（切 scope 时同样丢）。
     */
    assert.doesNotMatch(layerSrc, /syncByScopeToDraft/, '逐字符重建 byScope 会静默删映射，禁止回退');
  });

  it('保存前逐行校验：绝对路径 + 禁系统路径 + scope 必填/不重复', () => {
    assert.match(layerSrc, /目录路径必须是绝对路径/);
    assert.match(layerSrc, /不允许使用系统路径/);
    assert.match(layerSrc, /scope 重复映射/);
    assert.match(layerSrc, /analysisDirErrors/, '校验失败要逐行给出原因');
  });

  it('scope 选择改为可搜索单选：已选值内联在输入框，不标数据源、不自动填入', () => {
    assert.match(scopePickerSrc, /single\?: boolean/, 'ScopeMultiPicker 需支持单选');
    assert.match(scopePickerSrc, /onChange\(single \? \[name\] : \[\.\.\.value, name\]\)/);
    assert.match(layerSrc, /<ScopeMultiPicker[\s\S]{0,160}\bsingle\b/, '映射行必须用单选模式');
    // 单选把已选项回显在输入框里，不另起一行 chips（用户：选完别显示在上面）
    assert.match(scopePickerSrc, /const inputValue = single \? \(open \? filter : selectedName\) : filter;/);
    assert.match(scopePickerSrc, /\{single \? null : \(/, '单选不得渲染上方 chips 行');
    // 数据源目录 ≠ 分析目标目录：既不给「填入数据源」，也不在选 scope 时自动填充
    assert.doesNotMatch(layerSrc, /填入数据源/, '禁止把数据源路径一键填入分析目录');
    assert.doesNotMatch(layerSrc, /datasourceDirs\[/, '选 scope 时不得自动填充路径');
    assert.match(layerSrc, /sp-tag--ro/, '只读徽标保留（与"能不能读到代码"有关）');
  });

  it('映射行自动保存：选完 scope / 路径失焦 / 删行即落盘，新增行点「确认」', () => {
    assert.match(layerSrc, /onBlur=\{\(\) => saveAnalysisDirs\(\)\}/, '路径失焦应自动保存');
    assert.match(layerSrc, /saveAnalysisDirs\(nextRows\)/, '选 scope 后应带新行直接落盘（state 尚未更新）');
    assert.match(
      layerSrc,
      /const nextRows = analysisByScopeRows\.filter\(\(_, i\) => i !== idx\);[\s\S]{0,200}saveAnalysisDirs\(nextRows\)/,
      '删行也应立即落盘（否则点完 × 磁盘里还在）',
    );
    assert.match(layerSrc, /确认并加入映射（立即生效）/);
    assert.match(layerSrc, />\s*确认\s*</, '新增行按钮文案应为「确认」');
  });

  it('行高与徽标：输入框 32px 与按钮一致，徽标固定行高不撑行', () => {
    assert.match(kiCss, /\.ki-chat-cfg__dirinput \{[^}]*height: 32px/, '输入框需 32px（原先 28px 太窄）');
    assert.match(kiCss, /\.ki-chat-cfg__dirrow \.ki-chat-btn \{[^}]*height: 32px/, '行内按钮需与输入框同高');
    assert.match(pickerCss, /\.sp-tag \{[\s\S]*?line-height: 1;/, '徽标需固定行高，否则会撑高候选行');
  });

  it('草稿不丢：基线回填让位给未保存改动、关闭前拦截、失败态可见', () => {
    // 回填只在本地无脏改动时进行（否则「点保存 → 响应在途 → 又改了」会被服务端旧值冲掉）
    assert.match(layerSrc, /analysisDirtyRef\.current/, '回填 effect 需读脏状态');
    // 关闭配置层时拦截未保存草稿（草稿不进 draftRef，flushPending 兜不住）
    assert.match(layerSrc, /分析目标目录有未保存的改动/);
    assert.match(layerSrc, /保存并关闭/);
    // 乐观更新 + PUT 失败时不能显示「已配置」
    assert.match(layerSrc, /保存失败/, '落盘失败时角标要能反映');
    // 脏判断按 scope 排序比对，避免行序变化被误判成有改动
    assert.match(layerSrc, /\.sort\(\)[\s\S]{0,80}return true;/, '脏判断需排序后比对');
  });

  it('ScopeMultiPicker 单选：选完焦点落到展开按钮，不掉到 body', () => {
    assert.match(scopePickerSrc, /toggleRef\.current\?\.focus\(\)/);
  });

  it('运行中可「停止」：按钮 + 接口 + cancelled 状态文案', () => {
    assert.match(modalSrc, /cancelEventAnalysis/, '弹窗需接入停止接口');
    assert.match(modalSrc, /停止中…/, '停止需有进行中反馈并防连点');
    assert.match(modalSrc, /gov-btn--danger-ghost/, '停止是破坏性动作，用 danger 幽灵样式');
    assert.match(modalSrc, /分析已停止/, 'cancelled 需要独立标题文案');
    assert.match(analysisCardSrc, /text: '已停止'/, '卡头徽标需区分「已停止」与「未完成」');
    // 主动停止不该被当成配置错误而引导去设置页（判据是 SETTINGS_GUIDE_CODES 集合）
    const guideBlock = modalSrc.slice(
      modalSrc.indexOf('SETTINGS_GUIDE_CODES = new Set(['),
      modalSrc.indexOf(']);', modalSrc.indexOf('SETTINGS_GUIDE_CODES = new Set([')),
    );
    assert.doesNotMatch(guideBlock, /ANALYSIS_CANCELED/, '停止不该出现在「去设置」引导码表里');
    // partial + cancelled 也不能显示成「分析完成」：判据必须用 errorCode
    assert.match(modalSrc, /draft\?\.errorCode === 'ANALYSIS_CANCELED'/);
    assert.match(modalSrc, /分析已停止 · 保留 \$\{candidates\.length\} 处候选/);
    // 停止按钮状态必须能复位，否则下次重新分析时永久禁用
    assert.match(modalSrc, /if \(!isRunning\) setStopping\(false\)/);
    // 后台已收尾（canceled:false）时同样要复原，不能停在「停止中…」
    assert.match(modalSrc, /if \(!res\.canceled\) setStopping\(false\)/);
    // 主动停止不挂错误码前缀，免得被当成故障
    assert.match(modalSrc, /draft\.errorCode !== 'ANALYSIS_CANCELED' \? `\[\$\{draft\.errorCode\}\] ` : ''/);
  });
});

/**
 * 真机回归（2026-11-17）：没有草稿的事件点「AI 分析」必须能启动。
 * 曾经的三处组合导致"点了没反应"：卡片在无草稿时不渲染（信号无接收者）、
 * 面板 lastSignal 以 startSignal 初始化（挂载即判定"没变化"）、切事件不复位信号。
 */
describe('S-05b · 「AI 分析」入口必须真的能启动', () => {
  it('卡片在仅有点击信号时也挂载，并把信号交给面板', () => {
    assert.match(
      analysisCardSrc,
      /if \(!draft && confirmed\.length === 0 && startSignal === 0\) return null;/,
      '无草稿时只要 signal > 0 就必须渲染卡片，否则点击没有接收者',
    );
    assert.match(analysisCardSrc, /draft \|\| startSignal > 0 \?/, '面板必须随卡片挂载');
  });

  it('面板的 signal 基线从 0 起，且复位不触发启动', () => {
    assert.match(modalSrc, /const lastSignal = useRef\(0\);/, '基线不能用 startSignal 初始化');
    assert.match(modalSrc, /if \(startSignal === 0\) return;/, '父级复位不应触发一次分析');
    assert.match(modalSrc, /startingRef\.current/, '同一时刻只允许一次在途 start');
  });

  it('切事件时把触发信号归零', () => {
    assert.match(eventsSrc, /setStartSignal\(0\);/, '切 scope/事件必须复位 startSignal');
  });
});

/**
 * 2026-11-18：候选区去重 + 工具调用明细（args/response/thinking）。
 * 这两条都是真机反馈驱动的，最容易在后续重构里被"顺手"改回去。
 */
describe('S-05c · 过程可观测（去重 + 工具明细）', () => {
  it('候选区不再重复展示已确认位置', () => {
    assert.match(modalSrc, /const pendingCandidates = useMemo\(/, '必须按 confirmed 过滤候选');
    assert.match(modalSrc, /pendingCandidates\.map\(/, '候选列表应渲染过滤后的集合');
    assert.doesNotMatch(modalSrc, /gov-cand__done/, '「已确认」徽标应随去重一起移除');
  });

  it('分析与查找共用 ToolCallRow，含 MCP/本地标签与截断提示', () => {
    assert.match(modalSrc, /<ToolCallRow/, '分析面板必须用共用行组件');
    assert.match(processPanelSrc, /<ToolCallRow/, '查找面板必须用同一个行组件');
    assert.match(toolCallSrc, /startsWith\('ki_'\)/, 'MCP 判定按 ki_ 前缀');
    assert.match(toolCallSrc, /已截断（原文/, '截断必须显式告知原文长度');
  });

  it('思考片段默认收起，且复用对话侧的思考块样式（2026-11-18）', () => {
    assert.match(modalSrc, /<ThinkingBlock/, '分析面板要能看思考');
    assert.match(processPanelSrc, /<ThinkingBlock/, '查找面板同');
    // 不再自造 <details className="gov-think">：与 AI 对话的 ReasoningBlock 共用 .ki-chat-reason*
    assert.doesNotMatch(toolCallSrc, /<summary>模型思考<\/summary>/, '不得保留原生的 details/summary 折叠');
    assert.match(toolCallSrc, /ki-chat-reason__toggle/, '折叠头复用对话侧按钮');
    assert.match(toolCallSrc, /ki-chat-reason__spin/, '运行中要有旋转动画');
    assert.match(toolCallSrc, /useState\(false\)/, '默认收起');
  });

  it('未确认点是卡片级独立区块：不随已确认与过程折叠消失（2026-11-18 走查）', () => {
    assert.match(analysisCardSrc, /className="gov-unconfirmed"/, '要有独立的未确认点区块');
    // 2026-11-23：兜底改造后列表来源是 `const unconfirmed = draft?.unconfirmed ?? []`，
    // 断言放宽到 `unconfirmed.map`（`draft.unconfirmed.map` 也命中，语义不变：逐条列出、不 join）
    assert.match(analysisCardSrc, /unconfirmed\.map/, '逐条列出，不再 join 成一行');
    const start = analysisCardSrc.indexOf('className="gov-unconfirmed"');
    const end = analysisCardSrc.indexOf('className="gov-confirmed"');
    assert.ok(start > 0 && end > start, '未确认点应位于已确认位置之前');
    const block = analysisCardSrc.slice(start, end);
    // 条件里不得再出现 committed / procOpen —— 那正是"确认后收起过程就看不见"的成因
    assert.doesNotMatch(block, /committed|procOpen/, '区块条件不得依赖已确认态或过程区展开态');
    assert.doesNotMatch(modalSrc, /未确认点：/, '面板内那段重复小字应移除');
    assert.match(govCss, /\.gov-unconfirmed__list/, '未确认点样式随之落地');
  });

  it('追问区容器化：主色浅底 + 左竖线 + 圆角，图标不与结论撞色', () => {
    const block = govCss.slice(govCss.indexOf('.gov-ask {'), govCss.indexOf('.gov-ask__head'));
    assert.match(block, /border-left: 3px solid/, '要有左侧竖线');
    assert.match(block, /--ki-color-primary/, '用主色，与结论（紫）/未确认点（amber）/已确认位置（蓝）区分');
    assert.match(block, /border-radius/, '要有圆角');
    const iconBlock = govCss.slice(govCss.indexOf('.gov-ask__icon {'), govCss.indexOf('.gov-ask__title'));
    assert.doesNotMatch(iconBlock, /--ki-color-purple/, '图标不得再用紫色（与分析结论撞色）');
    assert.match(iconBlock, /--ki-color-primary/);
  });

  it('思考是流式的：running 期间渲染 liveThinking，并贴底跟随（2026-11-18）', () => {
    assert.match(modalSrc, /draft\.liveThinking/, '分析面板要渲染实时思考');
    const liveStart = modalSrc.indexOf('className="gov-ai-live"');
    assert.ok(liveStart > 0, '实时思考要有独立容器（虚线左框，与定稿步骤区分）');
    const liveBlock = modalSrc.slice(liveStart, liveStart + 1600);
    assert.match(liveBlock, /text=\{draft\.liveThinking\.text\}/, '渲染增量正文');
    assert.match(liveBlock, /\n\s*live\b/, '实时块必须标 live（旋转动画）');
    assert.match(liveBlock, /truncated=\{draft\.liveThinking\.chars\}/, '带原文长度供「已截断」提示');
    /*
     * 首包未到（liveThinking 还没写出来）也必须占位转圈：
     * 只看 step 的话，"最后一步已完成、下一轮还没吐字"这段时间过程区底部完全静止，
     * 用户会以为动画丢了（2026-11-18 反馈）。
     */
    assert.match(liveBlock, /gov-ai-live__spin/, '首包未到要有转圈占位');
    assert.match(liveBlock, /正在思考…/, '占位文案要说清在等什么');
    assert.match(govCss, /\.gov-ai-live__spin \{[\s\S]{0,200}animation: ki-spin/, '占位转圈复用对话侧动画');

    assert.match(toolCallSrc, /stickRef/, '流式追加要贴底跟随（回看时不打断）');
    assert.match(toolCallSrc, /思考内容过长，仅显示前/, '截断必须显式告知原文长度');
    assert.match(processPanelSrc, /truncated=\{step\.thinkingChars\}/, '查找侧也带截断长度');
    // 已完成的轮不再标「思考中」：live 只属于 draft.liveThinking 那一块
    assert.doesNotMatch(modalSrc, /step\.thinking\} live=/, '完成态步骤不得再挂 live');
  });

  it('删除不再"抖一下"：入场动画不得按 nth-child 设延迟，页内提示不占布局（2026-11-18）', () => {
    /*
     * 根因：行列表用 `:nth-child(N) { animation-delay }` 做阶梯入场。删掉一行后，
     * 后面所有行的序号都变 ⇒ animation-delay 变化 ⇒ 浏览器取消并重启 gov-rise
     * ⇒ 整个列表从 opacity 0 + translateY(5px) 重新淡入，用户看到"页面抖一下"。
     */
    assert.doesNotMatch(
      govCss,
      /\.gov-[^\n]*:nth-child\([^)]*\)[^\n]*\{[^}]*animation-delay/,
      '逐行 animation-delay 会让删除后的行重播入场动画',
    );
    assert.match(govCss, /\.gov-page-toast \{[\s\S]{0,300}position: fixed/, '页内提示必须脱离布局，否则出现/消失会推挤下方内容');
    assert.match(govCss, /\.gov-page-toast \{[\s\S]{0,300}pointer-events: none/, '浮层不得吃掉点击');
    assert.match(govCss, /\.gov-page-toast \{[\s\S]{0,300}z-index: 900/, '浮层层级要高于内容、低于弹窗');
    assert.match(eventsSrc, /gov-page-toast/, 'EventsPage 用浮层提示');
    // 提示从"先清空再填"改成直接覆盖：否则浮层卸载重挂会闪一下
    assert.doesNotMatch(eventsSrc, /setBusy\(true\);\s*\n\s*setMessage\(null\);/, '操作开始不得清空提示');
    // 行尾按钮列宽：写死 22px 装不下二次确认的「确认」两字，会把行高顶起来
    assert.doesNotMatch(govCss, /minmax\(0, 1fr\) auto 22px/, '末列不得写死 22px');
    assert.match(govCss, /\.gov-docline__x \{[\s\S]{0,200}min-width: 22px/, '行尾按钮固定最小宽度');
  });

  it('步骤明细用中文标签（不再直接铺英文 key）', () => {
    assert.match(modalSrc, /<StepMetrics/, '分析面板必须用中文标签渲染 metrics');
    assert.match(processPanelSrc, /<StepMetrics/, '查找面板同');
    assert.match(stepMetricsSrc, /members: '关联文档'/, 'members → 关联文档');
    assert.match(stepMetricsSrc, /verified: '保留候选'/, 'verified → 保留候选');
    assert.match(stepMetricsSrc, /hasDescription: \{ yes: '有', no: '无' \}/, '布尔值要翻成中文');
    // 预期效果（2026-11-24）：两栏都注入 prompt，指标层不能只暴露描述
    assert.match(stepMetricsSrc, /hasExpectedEffect: '预期效果'/, '预期效果要有中文标签');
    assert.match(stepMetricsSrc, /hasExpectedEffect: \{ yes: '有', no: '无' \}/, '布尔值要翻成中文');
  });

  it('追问区复用 AI 分析的展示与逻辑，不套对话气泡（2026-11-19）', () => {
    // 过程：折叠头 + 步骤列表 + 思考块，与 AI 分析同款（类名照搬，样式跟着分析卡走）
    assert.match(askBlockSrc, /className="gov-ai-proc__head"/, '过程区要用 AI 分析的折叠头');
    assert.match(askBlockSrc, /gov-ai-proc__steps/, '步骤列表复用 AI 分析的过程列表');
    assert.match(askBlockSrc, /gov-ai-step__mark/, '每步带已完成标记（与分析卡一致）');
    assert.match(askBlockSrc, /<ThinkingBlock/, '思考复用思考块组件（不自己铺长文本）');
    assert.match(askBlockSrc, /gov-ai-proc__toggle/, '折叠头要有「查看过程 / 收起」入口');
    assert.match(askBlockSrc, /stickRef/, '运行中贴底跟随，回看时不打断');
    // 回答：复用「最终结论」块
    assert.match(askBlockSrc, /gov-ai-final gov-ask__answer/, '回答复用 AI 分析的结论块');
    assert.match(askBlockSrc, /gov-ask__q/, '提问平铺成一行');
    // 不再套气泡 / 不再自己造一套过程样式
    assert.doesNotMatch(askBlockSrc, /gov-ask__bubble|gov-ask__msg/, '提问不得再套对话气泡');
    // 注释里会提到它，这里只查 className —— 追问区自己就是容器，不再套一层卡片
    assert.doesNotMatch(askBlockSrc, /className="[^"]*gov-ai-embed/, '不套 AI 分析面板那层卡片');
    assert.doesNotMatch(govCss, /\.gov-ask__bubble/, '气泡样式随之删除，避免复活');
    // 不反向耦合：AI 分析组件不得依赖追问区的类名
    assert.doesNotMatch(modalSrc, /gov-ask/, 'AI 分析组件保持独立，不回引追问样式');
  });
});

/**
 * 重置分析（2026-11-23 用户要求）：清空结论 + 已确认的代码位置，删前二次确认。
 *
 * 这里守三件事，都是"删错了就没有回头路"的地方：
 *   ① 入口只在真有东西可清时出现（避免空按钮/误导）；
 *   ② 二次确认必须是**弹框**（2026-11-23 用户指定），且把"会失去什么"列清楚；
 *   ③ 父级必须把 `startSignal` 归零 —— 否则清完还剩一张空壳卡，且面板会显示"分析完成"。
 */
describe('S-05d · 重置分析：清空结论与已确认位置（2026-11-23）', () => {
  const govApiSrc = fs.readFileSync(path.join(webRoot, 'src/api/governanceApi.ts'), 'utf8');

  it('入口只在有草稿或已确认位置时出现，且运行中 / 只读 / 请求中禁用', () => {
    assert.ok(
      analysisCardSrc.includes('const hasResettable = Boolean(draft) || confirmed.length > 0;'),
      '可重置判定必须同时看草稿与已确认位置（丢弃草稿后只剩位置也要能清）',
    );
    assert.match(analysisCardSrc, /\{hasResettable \? \(/, '没有东西可清时不得渲染按钮');
    assert.match(analysisCardSrc, />\s*重置分析\s*<\/button>/, '按钮文案');
    assert.ok(
      analysisCardSrc.includes('disabled={busy || !canWrite || running}'),
      '运行中、只读账号、请求进行中都要禁用',
    );
    assert.ok(analysisCardSrc.includes('gov-btn gov-btn--sm gov-btn--danger-ghost'), '危险操作用 ghost 危险态样式（不抢主色）');
    assert.ok(analysisCardSrc.includes('分析进行中：先「停止」或等完成再重置'), '禁用时要说明怎么办');
  });

  it('二次确认是弹框，把"会失去什么"列清楚，且清点在触发前算好', () => {
    assert.match(analysisCardSrc, /\{resetConfirm \? \(/, '确认态在这里渲染');
    // 用治理页既有弹窗家族（mask + modal），不引入新样式域、也不引第三方弹窗组件
    assert.ok(analysisCardSrc.includes('gov-modal-mask'), '弹框遮罩');
    assert.ok(analysisCardSrc.includes('gov-modal__head'), '弹框标题区');
    assert.ok(analysisCardSrc.includes('gov-modal__foot'), '弹框底部动作区');
    assert.ok(
      analysisCardSrc.includes('if (e.target === e.currentTarget) setResetConfirm(false)'),
      '点弹框内部不应关闭（只有遮罩自身被点才关，且不阻断冒泡 —— #85 改造）',
    );
    assert.match(analysisCardSrc, /e\.key === 'Escape'/, 'Esc = 取消（危险动作的默认出口必须安全）');
    assert.ok(analysisCardSrc.includes('重置会清空本次分析的全部产物'), '必须写明清空什么');
    assert.ok(analysisCardSrc.includes('且不可恢复'), '必须写明不可恢复');
    assert.ok(analysisCardSrc.includes("resetItems.join(' · ')"), '要列出本次会清掉的条目与数量');
    assert.ok(analysisCardSrc.includes('确认重置'), '确认按钮文案要说清动作');
    assert.ok(
      analysisCardSrc.indexOf('const resetItems =') < analysisCardSrc.indexOf('onReset();'),
      '清点必须在触发重置之前计算（请求成功后这些数据已经没了）',
    );
    // 只查"调用"，注释里提到这个词是允许的（组件注释解释了为什么不用它）
    assert.doesNotMatch(analysisCardSrc, /window\.confirm\(/, '不用浏览器原生确认框');
  });

  it('父级：重置后把触发信号归零，请求打到 DELETE /analysis', () => {
    assert.ok(eventsSrc.includes('onReset={() => void run(async () => {'), '重置动作走 run()，复用错误提示与详情刷新');
    assert.ok(eventsSrc.includes('await resetEventAnalysis(eventScope, active.id)'), '必须落在事件所属库（视图下顶栏 scope 是视图名）');
    const resetBlock = eventsSrc.slice(eventsSrc.indexOf('onReset={() => void run('));
    assert.match(
      resetBlock.slice(0, 900),
      /setStartSignal\(0\)/,
      '信号必须归零：卡片要「无草稿 + 无已确认 + startSignal===0」三条同时成立才消失',
    );

    assert.ok(govApiSrc.includes('export function resetEventAnalysis'), 'API 层要有独立方法（不要复用 discard 草稿那个）');
    assert.ok(
      govApiSrc.includes('/analysis?${new URLSearchParams({ scope }).toString()}'),
      '端点是不带子路径的 /analysis，与 /analysis/draft 区分',
    );
    const resetFn = govApiSrc.slice(govApiSrc.indexOf('export function resetEventAnalysis'));
    assert.match(resetFn.slice(0, 600), /method: 'DELETE'/, '重置用 DELETE');
  });
});
describe('结论只读（H12 · 批 6 · 2026-11-23）', () => {
  const editorSrc = fs.readFileSync(
    path.join(webRoot, 'src/components/governance/event-detail/AnalysisEditor.tsx'), 'utf8');
  const cardSrc = fs.readFileSync(
    path.join(webRoot, 'src/components/governance/event-detail/EventAnalysisCard.tsx'), 'utf8');
  const editSrc = fs.readFileSync(path.join(webRoot, '..', 'src/lib/events/analysis-edit.ts'), 'utf8');

  it('编辑器里没有任何结论编辑控件', () => {
    assert.ok(!editorSrc.includes('gov-dedit__textarea'), '不得再有 summary 输入框');
    assert.ok(!editorSrc.includes('因果链 ·'), '不得再有因果链区块');
    assert.ok(!editorSrc.includes('kindLabel'), '节点编辑已移除，不再需要视角词表');
    assert.ok(!/conclusion:\s/.test(editorSrc), '保存 payload 不得发送 conclusion（结论唯一写路径是追问补丁）');
  });

  it('结论改为只读展示 + 引导语（由卡片渲染后传入）', () => {
    assert.match(cardSrc, /分析结论（只读）/, '编辑态仍有只读结论，便于对照');
    assert.match(cardSrc, /如需修改请追问/, '必须给出可执行的替代路径');
    assert.ok(cardSrc.includes('conclusionBlock'), '只读块由卡片传给编辑器，保持单一 flex 容器');
  });

  it('长度口径统一为 4000（H10）', () => {
    assert.match(editSrc, /CONCLUSION_MAX_CHARS = 4000/);
    assert.ok(!editSrc.includes('CONCLUSION_TEMPLATE_MAX'), '旧 120 常量必须消失');
    assert.ok(!/\b120\b/.test(editorSrc), '前端不得再出现 120 字计数');
  });
  it('保存后保留 resumeAvailable（不得强转丢掉「继续分析」入口）', () => {
    assert.ok(
      cardSrc.includes('...(analysis ?? { draft: null, confirmed: [] })'),
      'onSaved 必须从原 analysis 展开再覆盖 draft/confirmed',
    );
    assert.ok(!/onUpdated\(next as EventAnalysis\)/.test(cardSrc), '不得再用 as 强转整块替换');
  });
});

describe('追问补丁覆盖结论（S03 · 批 5）', () => {
  const askSrc = fs.readFileSync(
    path.join(webRoot, 'src/components/governance/event-detail/AskBlock.tsx'), 'utf8');
  const modalSrc = fs.readFileSync(
    path.join(webRoot, 'src/components/governance/event-detail/AnalysisProposalModal.tsx'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(webRoot, 'src/api/governanceApi.ts'), 'utf8');
  const repoRoot = path.join(webRoot, '..');
  const runnerSrc = fs.readFileSync(path.join(repoRoot, 'src/lib/events/analysis-ask-runner.ts'), 'utf8');
  const patchSrc = fs.readFileSync(path.join(repoRoot, 'src/lib/events/analysis-ask-patch.ts'), 'utf8');
  const httpSrc = fs.readFileSync(path.join(repoRoot, 'src/lib/governance-http.ts'), 'utf8');

  it('不自动覆盖：必须用户确认，且复用唯一写入口', () => {
    assert.match(modalSrc, /确认覆盖/);
    assert.match(modalSrc, /保留当前/);
    assert.ok(askSrc.includes('saveEventAnalysisEdits'), '覆盖必须走 PATCH /analysis');
    assert.ok(askSrc.includes('acceptedProposalTurnId'), '采纳要回写 .ask.json（审计）');
  });

  it('不合规 / 无写权限 → 不给确认', () => {
    assert.ok(modalSrc.includes('disabled={!canConfirm}'), '可用性由校验与写权限共同决定');
    assert.ok(modalSrc.includes('需要写权限'), 'viewer 要看得到原因');
  });

  it('后端：围栏约定 + 按视角骨架校验 + done 前下发事件', () => {
    assert.ok(runnerSrc.includes('ki-conclusion-patch'), '提示词要约定围栏语言');
    assert.ok(patchSrc.includes('viewProfile(view).skeleton'), '补丁必须按该类型骨架校验');
    assert.match(httpSrc, /type: 'proposal', turnId/, '事件要带 turnId 供采纳回写');
  });

  it('前端：流式事件能解析 proposal', () => {
    assert.ok(apiSrc.includes("payload.type === 'proposal'"));
  });

  /*
   * 数据链路（2026-11-24 · REQ-20261124-001 · S03 §3.1/§3.2）：
   * 最易漏的一步不是解析，是**采纳时忘了带** —— 解析出来了但 body 里没有该字段，
   * 后端按"不改链路"处理，用户看到补丁写"已改链路"却什么都没变。
   */
  it('数据链路：解析 → 采纳带进 body → PATCH 白名单三处都认 dataFlow', () => {
    assert.ok(patchSrc.includes('normalizeDataFlow'), '补丁解析必须复用统一归一（不要自写）');
    assert.ok(
      askSrc.includes('dataFlow: p.patch.dataFlow'),
      '采纳补丁时要把 dataFlow 带进 PATCH body（只解析不传 = 不落盘）',
    );
    assert.match(httpSrc, /has\('dataFlow'\)/, 'PATCH /analysis 白名单要收该字段');
    assert.ok(modalSrc.includes("'链路'"), '弹框要给链路差异一个可读标签');
  });
});


