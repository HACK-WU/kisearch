/**
 * 对话工具卡片展示契约（2026-11-11，用户三轮指出后定型）
 *
 * 结论（三条，缺一即回退）：
 *  1. **入参一律 JSON**：所有 MCP 工具的入参（检索类的 query/mode + 其余工具的 args 摘要）
 *     合并成一个对象交给 `JsonCode`，不得再有横排 `<pre>` 纯文本；
 *  2. **只有检索类显示命中数**：检索类判定 = `mode !== undefined`（只有 `ki_search` 会带），
 *     其余工具的 hits 恒为 0，显示「0 命中」是噪音；
 *  3. **刷新前后同一份数据**：落盘还原必须把 `query`/`args` 透传给 `toolStartStep`，
 *     否则生成中看得见、刷新后消失（原始缺陷）。
 *
 * 为什么守源码：这几处都是"顺手改回去也照样能跑"的展示分支，没有运行时断言兜底。
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const panel = fs.readFileSync(path.join(webRoot, 'src/chat/ChatPanel.tsx'), 'utf8');

/** 用 typescript 现场转译一个 .ts 模块（注入依赖桩）—— 与 chat-stream.test.mjs 同一手法 */
function loadTs(relative, dependencies = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(webRoot, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)((id) => dependencies[id] ?? require(id), mod, mod.exports);
  return mod.exports;
}

/** 截取一段源码（从 startMark 到其后第一个 endMark） */
function sliceBetween(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, `未找到锚点：${startMark}`);
  const e = src.indexOf(endMark, s);
  assert.ok(e > s, `未找到 ${startMark} 的结束标记 ${endMark}`);
  return src.slice(s, e);
}

describe('工具卡片 · 入参统一 JSON', () => {
  it('入参只走 JsonCode —— 不得再用 <pre> 横排渲染 n.args', () => {
    assert.doesNotMatch(panel, /\{n\.args \? <pre/, '横排 <pre> 渲染 args 必须删除');
    assert.ok(panel.includes('<JsonCode obj={argObj} />'), '入参必须由合并后的对象渲染');
  });

  it('合并对象必须同时收 query / mode / args 三路', () => {
    const block = sliceBetween(panel, 'const argObj: ChatToolArgsDisplay = {', '};');
    assert.match(block, /n\.query/, '检索词必须并入入参 JSON');
    assert.match(block, /n\.mode/, '检索模式必须并入入参 JSON');
    assert.match(block, /n\.args/, '其余工具的入参摘要必须并入同一个 JSON');
  });

  it('入参标题不再重复标注 mode（JSON 主体里已有）', () => {
    assert.ok(
      panel.includes('<div className="ki-chat-tool__label">入参</div>'),
      '入参标题右侧的 `mode xxx` 属于重复信息，应已移除',
    );
  });
});

describe('工具卡片 · 只有检索类显示命中数', () => {
  it('检索类判定仍是 `mode !== undefined`（ki_search 的专属标记）', () => {
    assert.match(panel, /const isSearch = n\.mode !== undefined;/, '改动护栏 #1：判据不得更换');
  });

  it('行内状态：命中数只在 isSearch 分支内出现，其余只给耗时', () => {
    const row = sliceBetween(panel, 'const stat = n.error', 'const toggle =');
    assert.match(row, /isSearch && n\.hits !== undefined/, '命中数必须受 isSearch 守卫');
    assert.match(row, /: n\.durationMs !== undefined\s*\?\s*`\$\{n\.durationMs\}ms`/, '非检索工具只显示耗时');
  });

  it('卡片响应头：结果统计函数同样受 mode 守卫', () => {
    const fn = sliceBetween(panel, 'function resultsStat(', '\n}');
    assert.match(fn, /n\.mode !== undefined && n\.hits !== undefined/, '命中数必须受检索类判定保护');
    assert.match(fn, /n\.durationMs/, '耗时对两类工具都要显示');
  });

  it('响应摘要 / 错误区 / 进行中文案按 isSearch 分支，不得对写工具说"检索"', () => {
    assert.match(panel, /\{isSearch \? `命中 \$\{n\.hits\} 条。` : ''\}/, '旧记录的"命中 N 条"只属于检索类');
    assert.match(panel, /错误\{isSearch \? <em>未产生检索结果<\/em> : null\}/, '错误头不得对写工具写"未产生检索结果"');
    assert.match(panel, /这一步调用失败，AI 已收到该错误并可能改道。/, '非检索失败需要中性文案');
  });
});

describe('工具卡片 · 刷新前后同一份入参', () => {
  it('落盘步骤还原时必须透传 query / args', () => {
    assert.match(
      panel,
      /toolStartStep\(s\.mode, s\.name, s\.query, s\.args\)/,
      '漏传任何一项 → 刷新后入参又消失（护栏 #6）',
    );
  });

  it('退化行判定包含 args（只有入参的步骤也要可展开）', () => {
    assert.match(panel, /const hasDetail = Boolean\([^)]*n\.args/, 'hasDetail 必须把 args 计入');
  });
});

describe('toolStartStep · 入参运行时归一（真跑函数）', () => {
  const { toolStartStep } = loadTs('src/chat/useChatStream.ts', {
    react: { useCallback: (f) => f, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useEffect: () => {} },
    '@/api/chatApi': {
      getConversation() {}, streamEditMessage() {}, streamMessage() {}, streamRegenerate() {},
    },
    '@/api/chatContract': { DEGRADED_LABELS: {} },
    './chatStore': {},
  });

  it('结构化对象原样保留', () => {
    const step = toolStartStep(undefined, 'ki_get_module_info', undefined, { module: 'k8s/x', depth: 4 });
    assert.deepEqual(step.args, { module: 'k8s/x', depth: 4 });
    assert.equal(step.label.startsWith('正在调用'), true, '非检索工具用「正在调用」措辞');
  });

  it('旧 daemon 的字符串 args 收进单键，不得被展成字符索引对象', () => {
    const step = toolStartStep(undefined, 'ki_get_module_info', undefined, 'module=k8s/x mode=full');
    assert.deepEqual(step.args, { 参数摘要: 'module=k8s/x mode=full' }, '原样保留，不假装能解析');
    assert.equal(Object.keys(step.args).length, 1, '只能有一个键 —— 出现 "0"/"1"/… 即说明又走回展开');
    assert.equal('0' in step.args, false, '字符索引键是这次事故的形态，必须绝迹');
  });

  it('空对象 / 数组 / null 一律不下发', () => {
    assert.equal('args' in toolStartStep(undefined, 'ki_scope_list', undefined, {}), false);
    assert.equal(toolStartStep(undefined, 'x', undefined, [1, 2]).args, undefined);
    assert.equal(toolStartStep(undefined, 'x', undefined, null).args, undefined);
  });

  it('检索类仍走完整字段（mode 前缀 + query 保留）', () => {
    const step = toolStartStep('fulltext', 'ki_search', 'init', undefined);
    assert.equal(step.query, 'init');
    assert.equal(step.mode, 'fulltext');
    assert.equal(step.label, '正在检索知识库…（全文）');
  });
});
