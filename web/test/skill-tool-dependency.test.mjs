/**
 * skill ↔ MCP 工具的前置依赖（2026-11-11）。
 *
 * 产品口径（用户拍板）：`doc-editing` 通过 `ki_edit_relation` 改文档，**默认停用**；
 * 要启用它，必须**手动**先把 `ki_edit_relation` 工具打开。三层落实，缺一层都能被绕过：
 *
 *   1. 后端保存：skill 开 + 工具关 ⇒ 400（防 API 直连绕过前端）
 *   2. 读取路径：不一致时**就地停用该 skill**并透出原因（绝不整份回退默认）
 *   3. 前端交互：点开关只给「去启用」指路（不代开工具）；关工具时拦一次并联动停用 skill
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.join(webRoot, '..');
const server = fs.readFileSync(path.join(repoRoot, 'src/lib/chat/prompt-config.ts'), 'utf8');
const docSkill = fs.readFileSync(path.join(repoRoot, 'src/lib/chat/retrieval/doc-editing-skill.ts'), 'utf8');
const layer = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');
const css = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');

/** 取某段源码（from 到 to 之间） */
function slice(text, from, to) {
  assert.ok(text.includes(from), `未找到源码片段：${from}`);
  return text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
}

describe('skill ↔ 工具前置依赖（doc-editing 必须手动先开 ki_edit_relation）', () => {
  it('后端声明了依赖，前后端映射同源（同一条 skill id + 同一个工具名）', () => {
    const serverDeps = slice(server, 'export const SKILL_REQUIRED_TOOLS', 'BUILTIN_SKILL_CONTENT');
    assert.match(serverDeps, /\[DOC_EDITING_SKILL_ID\]:\s*DOC_EDITING_REQUIRED_TOOL/, '后端应引用 skill 常量文件里的 id / 工具名，而不是各自写死');
    const layerDeps = slice(layer, 'const SKILL_REQUIRED_TOOLS', '/** 新增 skill 的 id');
    assert.match(layerDeps, /'builtin-doc-editing':\s*'ki_edit_relation'/, '前端依赖表必须与后端一致（手工同源，这里就是那道闸）');
    assert.ok(docSkill.includes("export const DOC_EDITING_SKILL_ID = 'builtin-doc-editing'"), 'skill id 的 SSOT 应在 skill 常量文件里');
    assert.ok(docSkill.includes("export const DOC_EDITING_REQUIRED_TOOL = 'ki_edit_relation'"), '工具名的 SSOT 应在 skill 常量文件里');
  });

  it('doc-editing 默认停用（会写知识库的能力不能默认开）', () => {
    assert.match(server, /BUILTIN_SKILL_ENABLED[\s\S]{0,200}\[DOC_EDITING_SKILL_ID\]:\s*false/, '默认值必须是停用');
    assert.match(server, /'builtin-retrieval':\s*true/, '检索 skill 仍默认启用');
  });

  it('后端：保存严格（400）/ 读取宽松（就地停用 + 说明）', () => {
    assert.match(server, /skillDependencySoft/, '读取路径需要软处理开关');
    assert.ok(server.includes('skillDependencySoft: true'), 'readPromptConfig 必须传它，否则不一致配置会触发整份回退默认');
    assert.match(server, /s\.enabled = false/, '读取路径应就地停用该 skill');
    assert.match(server, /issues\.push\(\{\s*\n?\s*path: 'skills',\s*\n?\s*message: `skill「\$\{s\.name\}」需要先启用工具/, '保存路径应给出指明工具名的 400 文案');
  });

  it('前端：「去启用」只指路，不代开工具', () => {
    const reveal = layer.slice(layer.indexOf('const revealTool'), layer.indexOf('const toggleSkill'));
    assert.match(reveal, /scrollIntoView/, '应滚动到目标工具行');
    assert.doesNotMatch(reveal, /commit\(/, '★ 不得顺手改状态 —— 用户要求"必须手动先启用"');
    assert.match(layer, /yesLabel: '去启用'/, '浮层主按钮应是指路动词');
    assert.match(layer, /yesDanger: false/, '指路动作不是破坏性操作，不该用危险色');
  });

  it('前端：点开关时拦截 + 卡片写明原因且**可点击指路** + 工具行可定位', () => {
    // 文案刻意短（卡片剩余宽度 ~210px，写长会被省略号吃掉），完整路径放 title
    assert.match(layer, /note: `需先启用 \$\{need\} 工具`/, '依赖未满足时卡片要说明原因（不是无提示的灰按钮）');
    assert.match(layer, /工具与权限 → 写入）`?，?点击前往|（工具与权限 → 写入），点击前往/, '完整路径应在 title 里（hover 可见）');
    // ★ 只写一句话不给路 = 用户得自己翻几百行（2026-11-12 实测被吐槽）：提示要能点
    assert.match(layer, /onNoteClick: \(\) => revealTool\(need\)/, '提示行点击应直达工具行');
    assert.match(layer, /ki-chat-cfg__item-note-txt/, '文案与箭头分开，长文案省略号截断时不吞掉箭头');
    assert.match(layer, /data-tool=\{r\.name\}/, '工具行要有定位锚点（revealTool 靠它）');
    assert.match(layer, /ki-chat-cfg__tool--hint/, '定位后要有短暂高亮');
    assert.match(css, /\.ki-chat-cfg__tool--hint\s*\{/, '高亮样式必须真实存在');
    assert.match(css, /\.ki-chat-cfg__item-note\s*\{[^}]*cursor: pointer/, '提示行要有可点的视觉暗示');
  });

  it('★ 提示行不得依赖新布局类（真机事故：旧样式表下中文逐字竖排）', () => {
    // 1) 提示放在 __item-main 内（结构回到既有 DOM 形状），而不是卡片外的独立行
    const main = layer.slice(layer.indexOf('ki-chat-cfg__item-main'), layer.indexOf('ki-chat-cfg__item-meta'));
    assert.match(main, /ki-chat-cfg__item-note/, '提示必须留在 __item-main 里，不能拆成卡片第二行');
    assert.doesNotMatch(layer, /className="ki-chat-cfg__item-row"/, '不得再引入 item-row 这类新结构包裹（旧样式表下会被压成 1 字宽）');
    assert.doesNotMatch(css, /\.ki-chat-cfg__item-row\s*\{/, '样式表里也不该留 item-row 规则（结构已回退）');
    // 2) 用 span[role=button] 承载点击：嵌套 <button> 是非法 HTML
    assert.match(layer, /<span\s+className="ki-chat-cfg__item-note"\s+role="button"/, '提示应是 span[role=button]，不是嵌套 button');
    assert.match(layer, /e\.stopPropagation\(\)/, '点提示不得冒泡进卡片点击区（否则会顺带打开编辑模态）');
    // 3) 回车/空格可用（role=button 的可达性义务）
    assert.match(layer, /e\.key !== 'Enter' && e\.key !== ' '/, '键盘触发要支持 Enter / 空格');
    // 4) CSS 硬兜底：容器再窄也只出省略号，绝不逐字竖排
    const rule = css.slice(css.indexOf('.ki-chat-cfg__item-note {'));
    assert.match(rule.slice(0, rule.indexOf('}')), /white-space: nowrap/, '★ 必须 nowrap —— 否则窄容器下中文会逐字竖排');
    assert.match(css, /\.ki-chat-cfg__item-note-txt \{[^}]*text-overflow: ellipsis/, '被压缩时用省略号收尾');
  });

  it('前端：关闭被依赖的工具时，一并停用该 skill（否则留下调不到工具的 skill）', () => {
    assert.match(layer, /const dependents = draft\?\.skills\.filter/, '关闭工具前要先找出依赖它的 skill');
    assert.match(layer, /将同时停用 skill/, '拦一次并说清后果');
    assert.match(layer, /SKILL_REQUIRED_TOOLS\[s\.id\] === r\.name \? \{ \.\.\.s, enabled: false \}/, '确认后两个开关一起关');
  });
});
