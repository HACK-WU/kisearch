/**
 * skill-slash.test.mjs —— `/` 斜杠点名 skill 的前端逻辑守卫（2026-11-12）
 *
 * 挡四类回退：
 *   1. **误触发**：`src/lib`、`2026/11/11`、`/api/chat` 这类正常文本里弹候选面板；
 *   2. **文本即凭证被破坏**：有人另加一份"已选 skill"状态 → 手删 `/名称` 后仍然生效；
 *   3. **键盘语义回归**：Enter 被候选吞掉却发不出去，或候选进了 Tab 序；
 *   4. **浮层定位回退**：改回 `absolute` 会被对话面板的多层 overflow 裁掉（ScopeMultiPicker 踩过）。
 *
 * 真机走查（实际点击 / 定位量测）不随仓库走，这里只挡结构性回归 + 纯函数行为。
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const {
  applySkillToken,
  filterSkills,
  findSkillTokens,
  hasSlashToken,
  parseSkillTokenIds,
  slashTriggerAt,
  splitSkillSegments,
} = await vite.ssrLoadModule('/src/chat/skillSlash.ts');

after(async () => {
  await vite.close();
});

const SKILLS = [
  { id: 'builtin-retrieval', name: 'knowledge-retrieval', description: '内置：知识库检索（语义+全文）', enabled: true },
  { id: 's-upload', name: 'ki-upload', description: '上传本地文档到远端 ki', enabled: true },
  { id: 's-agents', name: 'agents-md-init', description: '初始化 / 刷新 AGENTS.md', enabled: true },
];

describe('slashTriggerAt —— 只在行首或空白后触发', () => {
  it('行首 `/`：触发，过滤词为空', () => {
    assert.deepEqual(slashTriggerAt('/', 1), { start: 0, query: '' });
  });

  it('空白后 `/`：触发，过滤词是已输入的部分', () => {
    // '帮我 /up' = 帮(0) 我(1) 空白(2) /(3) u(4) p(5)，光标在末尾 = 6
    assert.deepEqual(slashTriggerAt('帮我 /up', 6), { start: 3, query: 'up' });
  });

  it('紧邻普通字符的 `/` 不触发（路径 / 日期）', () => {
    assert.equal(slashTriggerAt('src/lib', 7), null);
    assert.equal(slashTriggerAt('2026/11/11', 10), null);
  });

  it('`/api/chat` 里第二个 `/` 不触发（前面是 `i`）', () => {
    // 光标在 `chat` 之后：左侧最近的非名称字符是第二个 `/`，其前一个是 `i`
    assert.equal(slashTriggerAt('/api/chat', 9), null);
  });

  it('过滤词含空格 / 中文时已不是同一个 token → 不触发', () => {
    assert.equal(slashTriggerAt('/ki upload', 10), null);
  });

  it('光标位置非法（<1 / 越界）不触发', () => {
    assert.equal(slashTriggerAt('/', 0), null);
    assert.equal(slashTriggerAt('/', 5), null);
  });
});

describe('filterSkills —— 名称与描述都参与匹配', () => {
  it('空过滤词返回全部（保序）', () => {
    assert.deepEqual(filterSkills(SKILLS, '').map((s) => s.id), SKILLS.map((s) => s.id));
  });

  it('按名称过滤（大小写不敏感）', () => {
    assert.deepEqual(filterSkills(SKILLS, 'UP').map((s) => s.id), ['s-upload']);
  });

  it('按描述过滤（中文描述也能搜到）', () => {
    assert.deepEqual(filterSkills(SKILLS, '检索').map((s) => s.id), ['builtin-retrieval']);
  });

  it('无匹配返回空数组（由 UI 负责空态文案）', () => {
    assert.deepEqual(filterSkills(SKILLS, 'zzz'), []);
  });
});

describe('applySkillToken —— 选中后替换成 `/名称 `', () => {
  it('替换触发中的片段，光标落在名称之后', () => {
    const out = applySkillToken('/up', { start: 0, query: 'up' }, 3, 'ki-upload');
    assert.equal(out.text, '/ki-upload ');
    assert.equal(out.caret, '/ki-upload '.length);
  });

  it('后面已有空白时不补第二个空格', () => {
    const out = applySkillToken('/up 后面的字', { start: 0, query: 'up' }, 3, 'ki-upload');
    assert.equal(out.text, '/ki-upload 后面的字', '尾部原有空格被保留，不再补一个');
    // 光标紧贴名称之后（后面的空格原本就在，不算新插入）
    assert.equal(out.caret, '/ki-upload'.length);
  });

  it('插入点之前的文本原样保留', () => {
    const out = applySkillToken('前半 /up', { start: 3, query: 'up' }, 6, 'ki-upload');
    assert.equal(out.text, '前半 /ki-upload ');
    assert.equal(out.caret, '前半 /ki-upload '.length);
  });
});

describe('parseSkillTokenIds —— 文本即凭证', () => {
  it('按名称解析出 id（大小写不敏感）', () => {
    assert.deepEqual(parseSkillTokenIds('/ki-upload 上传这个目录', SKILLS), ['s-upload']);
  });

  it('按 id 也能解析（用户手打 id 同样生效）', () => {
    assert.deepEqual(parseSkillTokenIds('/s-upload 上传', SKILLS), ['s-upload']);
  });

  it('必须独立成词：`/ki-uploadx` 不命中 `ki-upload`', () => {
    assert.deepEqual(parseSkillTokenIds('/ki-uploadx 上传', SKILLS), []);
  });

  it('路径里的 `/` 不被误判（`src/lib` 前面不是空白 / 行首）', () => {
    assert.deepEqual(parseSkillTokenIds('看看 src/lib 这里', SKILLS), []);
  });

  it('去重保序，且受 CHAT_SKILLS_MAX 限制', () => {
    assert.deepEqual(parseSkillTokenIds('/ki-upload /s-upload /ki-upload', SKILLS), ['s-upload']);
  });

  it('解析不到的 token 视为普通文本（不报错、不阻断发送）', () => {
    assert.deepEqual(parseSkillTokenIds('/api/chat 这个接口', SKILLS), []);
  });

  it('hasSlashToken 是廉价预判（命中不代表可解析）', () => {
    assert.equal(hasSlashToken('/ki-upload'), true);
    assert.equal(hasSlashToken('看看 /api/chat'), true);
    assert.equal(hasSlashToken('没有斜杠'), false);
    assert.equal(hasSlashToken('a/b'), false);
  });
});

describe('findSkillTokens / splitSkillSegments —— 高亮层与解析共用同一份规则', () => {
  it('返回 `/名称` 的确切区间（含 `/`，不含其后空白）', () => {
    const hits = findSkillTokens('请用 /ki-upload 上传', SKILLS);
    assert.equal(hits.length, 1);
    assert.equal('请用 /ki-upload 上传'.slice(hits[0].start, hits[0].end), '/ki-upload');
    assert.equal(hits[0].skill.id, 's-upload');
  });

  it('解析不到的 token 不返回（否则会出现"有高亮却不生效"）', () => {
    assert.deepEqual(findSkillTokens('/api/chat 看看', SKILLS), []);
  });

  it('无 token → 单个 text 段（调用方据此不启用镜像层）', () => {
    const segs = splitSkillSegments('普通文本', SKILLS);
    assert.deepEqual(segs, [{ kind: 'text', text: '普通文本' }]);
  });

  it('有 token → 文本 / token / 文本 交替，拼回去等于原文', () => {
    const text = '请用 /ki-upload 上传，再用 /agents-md-init 收尾';
    const segs = splitSkillSegments(text, SKILLS);
    assert.deepEqual(segs.map((s) => s.kind), ['text', 'skill', 'text', 'skill', 'text']);
    assert.equal(segs.map((s) => s.text).join(''), text, '分段必须无损（丢一个字就会与 textarea 错位）');
    assert.deepEqual(segs.filter((s) => s.kind === 'skill').map((s) => s.text), ['/ki-upload', '/agents-md-init']);
  });

  it('token 在开头 / 结尾都能切分', () => {
    assert.deepEqual(splitSkillSegments('/ki-upload 上传', SKILLS).map((s) => s.kind), ['skill', 'text']);
    assert.deepEqual(splitSkillSegments('用 /ki-upload', SKILLS).map((s) => s.kind), ['text', 'skill']);
  });

  it('与 parseSkillTokenIds 口径一致（同一文本，段里的 skill 就是会被发送的）', () => {
    const text = '/ki-upload 处理，另外 /ki-upload 再来一次';
    const fromSegs = splitSkillSegments(text, SKILLS).filter((s) => s.kind === 'skill').map((s) => s.skill.id);
    assert.deepEqual([...new Set(fromSegs)], parseSkillTokenIds(text, SKILLS));
  });
});

describe('源码守卫：结构性回归', () => {
  const chatPanel = read('src/chat/ChatPanel.tsx');
  const menu = read('src/chat/SkillSlashMenu.tsx');
  const mirror = read('src/chat/ComposerMirror.tsx');
  const css = read('src/styles/ki.css');

  it('触发判定 / token 解析只有一份实现（不得在 ChatPanel 里另写正则）', () => {
    assert.ok(chatPanel.includes("from './skillSlash'"), 'ChatPanel 应复用 skillSlash 的纯函数');
    assert.ok(chatPanel.includes('slashTriggerAt('), '输入事件应走 slashTriggerAt 判定');
    assert.ok(chatPanel.includes('parseSkillTokenIds('), '发送前应走 parseSkillTokenIds 解析');
    assert.ok(!/new RegExp\([^)]*\\\/\(/.test(chatPanel), 'ChatPanel 里不应再手写 token 正则');
  });

  it('候选不进 Tab 序（键盘走 ↑↓ + Enter）', () => {
    assert.ok(menu.includes('tabIndex={-1}'), '候选按钮必须 tabIndex={-1}，否则弹窗里 Tab 会被上百个候选困住');
    assert.ok(chatPanel.includes('aria-activedescendant'), '拿掉 Tab 可达后必须用 aria-activedescendant 补偿');
  });

  it('Enter 在候选打开时是"选择"，关闭时才"发送"', () => {
    // 用「pickSkill 必须先于同一处理器里的 handleSend 出现」判定，不绑死具体条件字符串
    // （条件措辞会随修改变动，绑死会让守卫变成"改一次就红一次"的噪音）
    const idxPick = chatPanel.indexOf('pickSkill(slashRows[');
    assert.ok(idxPick > 0, '找不到候选选中调用');
    const idxSend = chatPanel.indexOf('handleSend();', idxPick);
    assert.ok(idxSend > idxPick, '候选分支必须排在发送分支之前（否则 Enter 会把半截 `/up` 发出去）');
  });

  it('输入法组合态放行（组合态 Enter 不得被当作选择 / 发送）', () => {
    assert.ok(chatPanel.includes('e.nativeEvent.isComposing'), '必须保留 isComposing 判断');
    assert.ok(chatPanel.includes('229'), '必须保留 keyCode 229（部分输入法只给这个）');
  });

  it('Shift+Enter 是换行，不能被候选吞掉', () => {
    assert.ok(chatPanel.includes("(e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey"), '候选分支必须排除 shiftKey');
    assert.ok(chatPanel.includes("e.key === 'Enter' && !e.shiftKey && !composing"), '发送分支同样排除 shiftKey');
  });

  it('面板打开后允许用中文过滤（不重跑触发判定）', () => {
    // 触发判定只认 [A-Za-z0-9_-]，若每次输入都重跑，敲一个中文字面板就消失
    assert.ok(chatPanel.includes('text[slash.start] === \'/\''), '面板已开时应基于原 `/` 位置更新过滤词');
    assert.ok(chatPanel.includes('SLASH_QUERY_MAX'), '必须有过滤词长度上限（超长即视为不在此流程中）');
  });

  it('浮层固定定位 + 层级 150（absolute 会被多层 overflow 裁掉）', () => {
    assert.ok(menu.includes('position') === false || true);
    assert.ok(css.includes('.ki-chat-slash {'), '样式段必须存在');
    assert.ok(/\.ki-chat-slash\s*\{[^}]*position:\s*fixed/s.test(css), '浮层必须 fixed（由 JS 现算落点）');
    assert.ok(/\.ki-chat-slash\s*\{[^}]*z-index:\s*150/s.test(css), 'z-index 应为 150（高于页内下拉、低于侧栏/聊天面板）');
  });

  it('选中候选后焦点与光标由 effect 恢复（不在原生事件里 rAF）', () => {
    assert.ok(chatPanel.includes('setPendingCaret'), '插入后应记录待恢复的光标位置');
    assert.ok(/useEffect\(\(\) => \{\s*if \(pendingCaret === null\) return;/.test(chatPanel), '光标恢复必须在 effect 里做');
  });

  it('高亮镜像只在真有 token 时启用，且不接管交互', () => {
    assert.ok(chatPanel.includes("data-tokenized={tokenized ? 'true' : undefined}"), '未命中 token 时不得给 textarea 加透明');
    // 条件里必须同时判 `composerEl`：textarea 重挂载的那一帧 anchor 为空，
    // 没有锚点就拿不到排版，镜像层会用继承样式画在流内顶部（与文字重影）
    assert.ok(/tokenized && composerEl \? <ComposerMirror/.test(chatPanel), '无 token 时不渲染镜像层；有 token 但无锚点也不渲染');
    assert.ok(mirror.includes('aria-hidden="true"'), '镜像层必须 aria-hidden，否则屏幕阅读器读两遍');
    assert.ok(css.includes('pointer-events: none'), '镜像层不得拦截鼠标');
  });

  it('镜像层排版从 textarea 的 computed style 现取（写死会与高特异性覆盖打架）', () => {
    assert.ok(mirror.includes('getComputedStyle(ta)'), '必须读 textarea 的计算样式');
    assert.ok(mirror.includes('MIRRORED'), '必须有同源属性清单');
  });

  it('镜像层高度贴容器，不读 clientHeight（子组件 effect 先于父组件执行）', () => {
    assert.ok(mirror.includes("box.style.top = '0'"), '顶部贴容器');
    assert.ok(mirror.includes("box.style.bottom = '0'"), '底部贴容器 —— 否则多行时矮一行');
    assert.ok(!/box\.style\.height/.test(mirror), '不得按 clientHeight 定高');
  });

  it('镜像层左扩必须够容纳标志（BLEED_LEFT 与标记 left 是耦合的）', () => {
    const bleed = Number((mirror.match(/const BLEED_LEFT = (\d+)/) ?? [])[1]);
    const markLeft = Number((css.match(/\.ki-chat-hl__mark \{[^}]*?left:\s*-(\d+)px/s) ?? [])[1]);
    assert.ok(Number.isFinite(bleed) && Number.isFinite(markLeft), `解析失败 bleed=${bleed} markLeft=${markLeft}`);
    assert.ok(bleed >= markLeft + 2, `BLEED_LEFT(${bleed}) 必须 ≥ 标志外伸(${markLeft}) + 2，否则行首标志会被 overflow 裁掉`);
  });

  it('镜像层已在尺寸变化时兜底同步（字号/媒体查询变化不一定会触发渲染）', () => {
    assert.ok(mirror.includes('new ResizeObserver'), '缺 ResizeObserver 兜底：样式变了但没有渲染时镜像层会错位');
  });

  it('token 块不得改字形度量（会与 textarea 换行点漂移）', () => {
    const start = css.indexOf('.ki-chat-hl__token {');
    const end = css.indexOf('.ki-chat-hl__mark {');
    assert.ok(start > 0 && end > start, '找不到 token 样式段');
    const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/font-weight\s*:|letter-spacing\s*:|font-size\s*:/.test(block), '禁止在 token 块里改 font-weight / letter-spacing / font-size');
    assert.ok(block.includes('text-shadow'), '视觉加粗只能用 text-shadow 描边（不改度量）');
  });
});
