import { connect, evaluate, goto, waitFor, sleep } from './cdp.mjs';
import { HELPERS } from './helpers.mjs';
const SCOPE = 'kafka', G = 'kafka', SRC = '00-评审清单', TGT = '09-排障速查手册';
const results = [];
const check = async (name, cond, detailExpr) => {
  const detail = typeof detailExpr === 'string' ? await evaluate(detailExpr) : detailExpr;
  const pass = typeof cond === 'function' ? await cond() : Boolean(cond);
  results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${String(detail).slice(0, 70)}`);
};
const setInput = (sel, value) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`;
await connect();
const guard = setTimeout(() => { console.log('FATAL timeout'); process.exit(11); }, 240000);
guard.unref();
await goto(`http://127.0.0.1:5188/browse?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}`);
await waitFor("document.querySelector('.ki-markdown--drawer')", 30000);
await sleep(1200);
await evaluate(HELPERS);
// 只读源文档正文：用例 3/5 需要「源码里恰好出现一次」的选区，才能走到真正的保存分支
const srcContent = await evaluate(`fetch('/api/doc/edit?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}').then(r=>r.json()).then(d=>d.content)`);
if (!srcContent) throw new Error('读不到源文档正文');

// 1) 跨块选区
await evaluate(`window.__ki.selectAcross('.ki-markdown--drawer')`);
await sleep(800);
await check('跨块选区被拒且不弹面板',
  () => evaluate(`!document.querySelector('.ki-reader-link-panel') && /请只选中同一/.test(document.querySelector('.ki-drawer__copy-failed')?.textContent || '')`),
  `document.querySelector('.ki-drawer__copy-failed')?.textContent?.slice(0,44) || '无提示'`);

// 1b) 空选区：不弹面板、不误报
await evaluate(`window.getSelection()?.removeAllRanges(); true`);
await sleep(700);
await check('清空选区后不弹面板',
  () => evaluate(`!document.querySelector('.ki-reader-link-panel') && !document.querySelector('.ki-reader-link-dialog')`),
  `JSON.stringify({panel: Boolean(document.querySelector('.ki-reader-link-panel')), dialog: Boolean(document.querySelector('.ki-reader-link-dialog'))})`);

// 2) 链接 / 代码内的文字
const inLink = await evaluate(`(() => {
  const a = Array.from(document.querySelectorAll('.ki-markdown--drawer a, .ki-markdown--drawer code')).find(x => window.__ki.firstText(x)?.textContent.length > 6);
  if (!a) return null;
  const n = window.__ki.firstText(a);
  const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 6);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  a.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return a.tagName + ':' + n.textContent.slice(0, 8);
})()`);
await sleep(800);
await check('链接/代码内文字引导去编辑器',
  inLink === null ? true : () => evaluate(`/编辑文档/.test(document.querySelector('.ki-drawer__copy-failed')?.textContent || '')`),
  inLink === null ? '正文里没有链接或代码，跳过' : `document.querySelector('.ki-drawer__copy-failed')?.textContent?.slice(0,44)`);

// 3) 非法外链（选区取「源码唯一」的片段，保证后续用例能走到保存）
const srcPick = await evaluate(`window.__ki.pick('.ki-markdown--drawer', ${JSON.stringify(srcContent)})`);
if (!srcPick) throw new Error('源文档里找不到源码唯一的可选片段，负向用例无法走到保存分支');
await evaluate(`window.__ki.select('.ki-markdown--drawer', ${JSON.stringify(srcPick)})`);
await waitFor("document.querySelector('.ki-reader-link-panel')", 8000);
await evaluate(setInput('#ki-reader-external-url', 'not a url'));
await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-panel button')).find(b=>b.textContent.includes('添加外部链接')).click()`);
await sleep(1000);
await check('非法外链被拒',
  () => evaluate(`/有效网址|空格/.test(document.querySelector('.ki-reader-link-panel [role=status], .ki-reader-link-panel .ki-reader-link__error')?.textContent || '')`),
  `document.querySelector('.ki-reader-link-panel [role=status], .ki-reader-link-panel .ki-reader-link__error')?.textContent?.slice(0,44) || '无提示'`);

// 4) 弹窗内重复落点
await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-panel button')).find(b=>b.textContent.includes('选择知识库文档或段落')).click()`);
await waitFor("(document.querySelector('.ki-reader-link-dialog__doc-list')?.querySelectorAll('button').length || 0) > 1", 20000);
for (let i = 0; i < 60 && !(await evaluate(`Boolean(Array.from(document.querySelectorAll('.ki-reader-link-dialog__doc-list button')).find(x=>x.textContent.includes(${JSON.stringify(TGT)})))`)); i++) await sleep(300);
await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-dialog__doc-list button')).find(x=>x.textContent.includes(${JSON.stringify(TGT)})).click()`);
await waitFor("(document.querySelector('.ki-reader-link-dialog__preview')?.querySelectorAll('p').length || 0) > 5", 30000);
await sleep(1500);
// 判重口径必须与产品一致：anchor = kind + 归一化文本（th|步骤 与 td|步骤 是两个不同落点）
const dup = await evaluate(`window.__ki.findBlockByAnchor('.ki-reader-link-dialog__preview', true, 4)`);
if (!dup) throw new Error(`目标文档 ${TGT} 内找不到同 kind 重复块，用例 4 无从验证`);
await evaluate(`window.__ki.selectBlock('.ki-reader-link-dialog__preview', ${dup.at}, 1, 11)`);
await sleep(900);
await check(`重复落点提示出现 ${dup.times} 次（${dup.kind}:${dup.text}）`,
  () => evaluate(`/出现 ${dup.times} 次/.test(document.querySelector('.ki-reader-link-dialog__foot span')?.textContent || '')`),
  `document.querySelector('.ki-reader-link-dialog__foot span')?.textContent?.slice(0,60)`);
await check('重复落点无法确认',
  () => evaluate(`document.querySelector('.ki-reader-link-dialog__selection button')?.disabled === true && /尚未选择位置/.test(document.querySelector('.ki-reader-link-dialog__selection')?.textContent || '')`),
  `JSON.stringify({disabled: document.querySelector('.ki-reader-link-dialog__selection button')?.disabled, foot: document.querySelector('.ki-reader-link-dialog__selection')?.textContent?.slice(0,24)})`);

// 5) 保存冲突 → 重试（拦截 POST，全程不写库）
await evaluate(`(() => {
  window.__realFetch = window.fetch;
  window.__saves = [];
  window.__mode = 'conflict';
  const json = (obj, status) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = (input, init) => {
    if (!String(input).includes('/api/doc/edit') || init?.method !== 'POST') return window.__realFetch(input, init);
    window.__saves.push(String(init.body));
    if (window.__mode === 'conflict') return json({ ok: false, error: '文档已被他人修改', details: { editId: 'e-test-1', retryable: true } }, 409);
    if (window.__mode === 'partial') return json({ ok: false, error: '源文件写入失败', details: { kb: 'written', source: 'failed', retryable: false } }, 500);
    return json({ ok: true, revision: 'mock-retry', sourceConfigured: true, sourceWritten: true, fullTextUpdated: false, vectorStored: false, indexedAs: 'unchanged' }, 200);
  };
  return true; })()`);
const uniq = await evaluate(`window.__ki.findBlockByAnchor('.ki-reader-link-dialog__preview', false, 20)`);
if (!uniq) throw new Error('目标文档里找不到唯一落点块');
await evaluate(`window.__ki.selectBlock('.ki-reader-link-dialog__preview', ${uniq.at}, 1, 11)`);
await waitFor("Boolean(document.querySelector('.ki-reader-link-dialog__selection button:not([disabled])'))", 10000);
await evaluate(`document.querySelector('.ki-reader-link-dialog__selection button').click()`);
await waitFor("/保存失败/.test(document.querySelector('.ki-reader-link-dialog__foot span')?.textContent || '')", 20000);
await check('保存冲突给出失败提示',
  () => evaluate(`/保存失败.*他人修改/.test(document.querySelector('.ki-reader-link-dialog__foot span')?.textContent || '')`),
  `document.querySelector('.ki-reader-link-dialog__foot span')?.textContent?.slice(0,60)`);
await check('冲突期间不落新链接且提供重试入口',
  () => evaluate(`Boolean(Array.from(document.querySelectorAll('.ki-reader-link-dialog button')).find(b=>b.textContent.includes('重试保存'))) && !document.querySelector('.ki-jump-link')`),
  `Array.from(document.querySelectorAll('.ki-reader-link-dialog button')).map(b=>b.textContent).join('|').slice(0,60)`);
await evaluate(`window.__mode = 'ok'; Array.from(document.querySelectorAll('.ki-reader-link-dialog button')).find(b=>b.textContent.includes('重试保存')).click()`);
await waitFor("!document.querySelector('.ki-reader-link-dialog')", 20000);
await check('重试沿用同一请求并按 editId 下单',
  () => evaluate(`(() => { const s = window.__saves.map(x => JSON.parse(x)); return s.length === 2 && !s[0].editId && s[1].editId === 'e-test-1' && s[0].content === s[1].content && !!s[1].expectedRevision && s[1].expectedRevision === s[0].expectedRevision; })()`),
  `window.__saves.map(x => { const j = JSON.parse(x); return 'len=' + x.length + ' editId=' + (j.editId || '-') + ' rev=' + String(j.expectedRevision).slice(0, 10); }).join(' ; ')`);

// 5b) 部分写入（KB 已写 / 源文件失败）：提示 + 锁定，不重复下单。重试成功那单是 mock 的 200，未写库
await evaluate(`window.__mode = 'partial'; true`);
const srcPick2 = await evaluate(`window.__ki.pick('.ki-markdown--drawer', ${JSON.stringify(srcContent)})`);
if (!srcPick2) throw new Error('部分写入用例找不到第二个源码唯一片段');
await evaluate(`window.__ki.select('.ki-markdown--drawer', ${JSON.stringify(srcPick2)})`);
await waitFor("document.querySelector('.ki-reader-link-panel')", 8000);
await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-panel button')).find(b=>b.textContent.includes('选择知识库文档或段落')).click()`);
await waitFor("(document.querySelector('.ki-reader-link-dialog__doc-list')?.querySelectorAll('button').length || 0) > 1", 20000);
await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-dialog__doc-list button')).find(x=>x.textContent.includes(${JSON.stringify(TGT)})).click()`);
await waitFor("(document.querySelector('.ki-reader-link-dialog__preview')?.querySelectorAll('p').length || 0) > 5", 30000);
await sleep(1200);
const uniq2 = await evaluate(`window.__ki.findBlockByAnchor('.ki-reader-link-dialog__preview', false, 20)`);
await evaluate(`window.__ki.selectBlock('.ki-reader-link-dialog__preview', ${uniq2.at}, 1, 11)`);
await waitFor("Boolean(document.querySelector('.ki-reader-link-dialog__selection button:not([disabled])'))", 10000);
await evaluate(`document.querySelector('.ki-reader-link-dialog__selection button').click()`);
await waitFor("/保存失败/.test(document.querySelector('.ki-reader-link-dialog__foot span')?.textContent || '')", 20000);
await check('部分写入提示 KB 已更新与源文件状态',
  () => evaluate(`Array.from(document.querySelectorAll('.ki-drawer__copy-failed')).some(el => /KB 正文已更新.*failed/.test(el.textContent || ''))`),
  `Array.from(document.querySelectorAll('.ki-drawer__copy-failed')).map(el => el.textContent.slice(0, 44)).join(' / ')`);
await check('部分写入后不提供重试且只下一单',
  () => evaluate(`window.__saves.length === 3 && !Array.from(document.querySelectorAll('.ki-reader-link-dialog button, .ki-reader-link-panel button')).some(b => b.textContent.includes('重试保存'))`),
  `'POST 次数=' + window.__saves.length`);
await evaluate(`document.querySelector('.ki-reader-link-dialog__head button')?.click(); true`);
await sleep(700);
await evaluate(`window.fetch = window.__realFetch; true`);

// 6) 失效锚点
await goto(`http://127.0.0.1:5188/browse?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(TGT)}&anchor=p-0000000000000000`);
await waitFor("document.querySelector('.ki-drawer__copy-failed')", 30000);
await check('失效锚点提示而非乱跳', /目标段落/.test(await evaluate(`document.querySelector('.ki-drawer__copy-failed')?.textContent || ''`)),
  `document.querySelector('.ki-drawer__copy-failed')?.textContent?.slice(0,44)`);

// 7) 全程未写库
await check('知识库未被本次负向测试改动',
  () => evaluate(`fetch(${JSON.stringify(`/api/doc/edit?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}`)}).then(r=>r.json()).then(d=>!d.content.includes('ki-link:') && d.revision === '04522d65369dfe8a1171a83349627fbb9f34d1aea226df95b151975ca799880a')`),
  `fetch(${JSON.stringify(`/api/doc/edit?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}`)}).then(r=>r.json()).then(d=>'revision=' + d.revision.slice(0,12) + ' len=' + d.content.length + ' hasLink=' + d.content.includes('ki-link:'))`);
console.log(`\n汇总 ${results.filter(r=>r.pass).length}/${results.length} 通过`);
process.exit(results.every(r=>r.pass) ? 0 : 1);
