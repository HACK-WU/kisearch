/**
 * 对话配置**即时生效**（2026-11-11 用户拍板 B 方案）。
 *
 * 用户原话：「取消保存的按钮根本不需要，直接实施生效」。
 *
 * 契约：
 *  1. 底栏**没有**「取消 / 保存」按钮：改动（工具开关、skill 增删启停、上下文 / 预算 / 思考级别）
 *     改完即落盘，关掉层就等于"改完了"。
 *  2. 所有变更都走 `commit` / `commitDebounced`（不再有裸 `setDraft` 改动）——
 *     否则会出现"界面上改了、磁盘没动"的静默失败（历史 bug：确认后开关亮过、重开又关了）。
 *  3. `PUT` 串行 + 合并：整份替换的接口并发会让旧快照盖掉新改动。
 *  4. 文本输入防抖落盘，失焦与关闭层前 flush —— 否则"改完立刻关"会丢最后一次输入。
 *  5. 保存期间服务端回传的旧基线不得铺回本地（`queuedRef` 非空时跳过基线同步）。
 *  6. 保存失败必须可见 + 可重试（fail-loud）。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const layer = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');

/** 底栏渲染分支 */
function footerBlock() {
  const start = layer.indexOf('<footer className="ki-chat-cfg__bar">');
  assert.ok(start > 0, '未找到底栏');
  const end = layer.indexOf('</footer>', start);
  assert.ok(end > start, '未找到底栏结束位置');
  return layer.slice(start, end);
}

describe('对话配置 · 改动即时生效（无「取消 / 保存」）', () => {
  it('底栏不再有取消 / 保存按钮', () => {
    const bar = footerBlock();
    assert.doesNotMatch(bar, />\s*取消\s*</, '底栏不应再有「取消」');
    assert.doesNotMatch(bar, />\s*保存\s*</, '底栏不应再有「保存」');
    assert.doesNotMatch(layer, /const handleSave\b/, '整体保存的入口应已删除');
  });

  it('开关 / 启停 / 增删改都走 commit（不再有裸 setDraft 改动）', () => {
    assert.match(layer, /const apply = \(\) => commit\(/, '危险开关确认后应直接 commit 落盘');
    // 窗口放宽到 1200：toggleSkill 自 2026-11-11 起先做「依赖工具是否已启用」的拦截，再 commit
    assert.match(layer, /const toggleSkill[\s\S]{0,1200}commit\(/, 'skill 启停应即时落盘');
    assert.match(layer, /onSubmit=\{\(\{ name, content, description \}\)[\s\S]{0,200}commit\(/, '编辑提交应即时落盘');
    assert.match(layer, /onDelete[\s\S]{0,400}commit\(/, '删除 skill 应即时落盘');
  });

  it('PUT 串行 + 合并（整份替换不得并发）', () => {
    assert.match(layer, /inflightRef/, '应有在途标志');
    assert.match(layer, /queuedRef/, '应有待存队列');
    assert.match(layer, /if \(queuedRef\.current\) void drain\(\);/, '保存期间的新改动应补存');
  });

  it('文本输入防抖 + 失焦 / 关闭前 flush', () => {
    assert.match(layer, /commitDebounced/, '文本输入应防抖');
    assert.match(layer, /onBlur=\{flushPending\}/, '输入框失焦应立刻落地');
    assert.match(layer, /const handleClose[\s\S]{0,120}flushPending\(\);/, '关闭层前应 flush');
    assert.match(layer, /aria-label="关闭配置" onClick=\{handleClose\}/, '头部 ✕ 应走 handleClose');
    // 关整个 AI 面板 / 切路由会直接卸载，不走 handleClose —— 卸载兜底必须存在
    assert.match(layer, /useEffect\(\(\) => \(\) => \{[\s\S]{0,240}debounceRef\.current/, '卸载时应 flush 防抖中的输入');
  });

  it('服务端回传的旧基线不覆盖在途改动 / 正在输入', () => {
    assert.match(
      layer,
      /if \(!data \|\| queuedRef\.current \|\| debounceRef\.current\) return;/,
      '基线同步必须跳过「有在途改动」与「防抖窗口内正在输入」两种时刻',
    );
  });

  it('保存失败可见且可重试', () => {
    assert.match(layer, /const retrySave =/, '应有重试入口');
    assert.match(footerBlock(), /保存失败：/, '底栏应显式提示保存失败');
    assert.match(footerBlock(), /onClick=\{retrySave\}/, '应提供重试按钮');
  });
});
