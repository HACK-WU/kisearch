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
const kiCss = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');
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

  it('AiSettingsPage & PromptConfigLayer：对齐 ops.write 与 AI 分析 6 卡配置', () => {
    assert.match(aiSettingsSrc, /can\('ops\.write'\)/, '设置页写权限应与 route-permissions 的 ops.write 对齐');
    assert.match(layerSrc, /分析目标目录/, 'AI 分析设置栏需展示分析目标目录卡片');
    assert.match(layerSrc, /分析预算/, 'AI 分析设置栏需展示分析预算卡片');
    assert.match(layerSrc, /analysisToolGroups/, 'AI 分析设置栏需渲染服务端下发只读工具分组');
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

  it('思考片段默认收起且两处可见', () => {
    assert.match(modalSrc, /<ThinkingBlock/, '分析面板要能看思考');
    assert.match(toolCallSrc, /<summary>模型思考<\/summary>/, '思考块默认折叠');
  });

  it('步骤明细用中文标签（不再直接铺英文 key）', () => {
    assert.match(modalSrc, /<StepMetrics/, '分析面板必须用中文标签渲染 metrics');
    assert.match(processPanelSrc, /<StepMetrics/, '查找面板同');
    assert.match(stepMetricsSrc, /members: '关联文档'/, 'members → 关联文档');
    assert.match(stepMetricsSrc, /verified: '保留候选'/, 'verified → 保留候选');
    assert.match(stepMetricsSrc, /hasDescription: \{ yes: '有', no: '无' \}/, '布尔值要翻成中文');
  });
});
