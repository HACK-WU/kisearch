// 既有入口回归：编辑文档的「插入链接 → 读取标题/段落」下拉（本次改动动过它的锚点口径）
// 全程不保存，结束复核知识库 revision 未变。
import { connect, evaluate, goto, waitFor, sleep } from './cdp.mjs';
import { HELPERS } from './helpers.mjs';
const SCOPE = 'kafka', G = 'kafka', SRC = '00-评审清单';
const REVISION = '04522d65369dfe8a1171a83349627fbb9f34d1aea226df95b151975ca799880a';
const results = [];
const log = (k, v) => console.log(`[${k}] ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const check = async (name, cond, detailExpr) => {
  const detail = typeof detailExpr === 'string' ? await evaluate(detailExpr) : detailExpr;
  const pass = typeof cond === 'function' ? await cond() : Boolean(cond);
  results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${String(detail).slice(0, 80)}`);
};
const get = (path) => `fetch(${JSON.stringify(path)}).then(r=>r.json())`;
const setSelect = (index, value) => `(() => {
  const el = document.querySelectorAll('.ki-editor__links select')[${index}];
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value;
})()`;
const clickText = (sel, text) => `(() => {
  const b = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).find(x => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return 'not-found';
  b.click(); return b.disabled ? 'clicked-but-disabled' : 'clicked';
})()`;

await connect();
const guard = setTimeout(() => { console.log('FATAL timeout'); process.exit(11); }, 180000);
guard.unref();

await goto(`http://127.0.0.1:5188/browse?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}`);
await waitFor("document.querySelector('.ki-markdown--drawer')", 30000);
await sleep(1500);
await evaluate(HELPERS);
log('drawer-buttons', await evaluate(`Array.from(document.querySelectorAll('.ki-drawer__copy')).map(b=>b.textContent).join('|')`));
log('open-editor', await evaluate(`(() => { const b = Array.from(document.querySelectorAll('.ki-drawer__copy')).find(x => x.textContent.includes('编辑文档')); if (!b) return 'not-found'; b.click(); return 'clicked'; })()`));
await waitFor("document.querySelector('.ki-editor__links')", 20000);
// 编辑器正文是异步载入的：draft 为空时点「读取标题/段落」只会得到「请先选择目标文档」
await waitFor("(document.querySelector('.ki-editor__textarea')?.value.length || 0) > 50", 25000);
log('draft-length', await evaluate(`document.querySelector('.ki-editor__textarea').value.length`));
log('editor', await evaluate(`(() => {
  const sels = Array.from(document.querySelectorAll('.ki-editor__links select'));
  return { selects: sels.length, typeValue: sels[0]?.value, typeOpts: Array.from(sels[0]?.options || []).map(o => o.value).join(','), buttons: Array.from(document.querySelectorAll('.ki-editor__links button')).map(b => b.textContent.slice(0, 10)).join('|') };
})()`));
log('set-self', await evaluate(setSelect(0, 'self')));
await sleep(600);
log('selects-after-type', await evaluate(`Array.from(document.querySelectorAll('.ki-editor__links select')).map(s => s.value).join(',')`));
log('load-anchors-click', await evaluate(clickText('.ki-editor__links button', '读取标题/段落')));
const loaded = await (async () => {
  for (let i = 0; i < 60; i++) {
    const n = await evaluate(`(() => { const s = document.querySelectorAll('.ki-editor__links select')[1]; return s ? Array.from(s.options).filter(o => o.value).length : -1; })()`);
    if (n > 3) return n;
    await sleep(500);
  }
  return -1;
})();
log('anchor-options', loaded);
log('editor-notice', await evaluate(`document.querySelector('.ki-editor__notice')?.textContent?.slice(0, 60) || '无'`));
await check('编辑器段落锚点下拉仍可用且只出 h/p',
  () => evaluate(`(() => { const vs = Array.from(document.querySelectorAll('.ki-editor__links select')[1].options).map(o => o.value).filter(Boolean); return vs.length > 3 && vs.every(v => /^(?:p|h)-[0-9a-f]{16}$/.test(v)); })()`),
  `(() => { const vs = Array.from(document.querySelectorAll('.ki-editor__links select')[1].options).map(o => o.value).filter(Boolean); return 'count=' + vs.length + ' 非h/p=' + vs.filter(v => !/^(?:p|h)-[0-9a-f]{16}$/.test(v)).join(',') + ' 样例=' + (vs[0] || '-'); })()`);
await evaluate(`(Array.from(document.querySelectorAll('.ki-editor__foot button')).find(b => /取消|关闭/.test(b.textContent)) || document.querySelector('.ki-editor__head button'))?.click()`);
await sleep(800);
await check('未保存：知识库正文与 revision 未变',
  () => evaluate(`${get(`/api/doc/edit?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}`)}.then(d => d.revision === ${JSON.stringify(REVISION)} && !d.content.includes('ki-link:'))`),
  `${get(`/api/doc/edit?scope=${SCOPE}&group=${G}&relation=${encodeURIComponent(SRC)}`)}.then(d => 'revision=' + d.revision.slice(0, 12) + ' len=' + d.content.length + ' hasLink=' + d.content.includes('ki-link:'))`);
console.log(`\n汇总 ${results.filter(r => r.pass).length}/${results.length} 通过`);
process.exit(results.every(r => r.pass) ? 0 : 1);
