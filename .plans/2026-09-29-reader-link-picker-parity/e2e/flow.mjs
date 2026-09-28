import { connect, evaluate, goto, waitFor, sleep } from './cdp.mjs';
const SCOPE = 'kafka', SRC_GROUP = 'kafka', SRC = '00-评审清单', TGT = '09-排障速查手册';
const log = (k, v) => process.stdout.write(`[${k}] ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
const get = (path) => `fetch(${JSON.stringify(path)}).then(r=>r.json())`;
let original = null, saved = null;

const HELPERS = `
window.__ki = {
  textNodes(root) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const out = []; let n; while ((n = w.nextNode())) out.push(n); return out; },
  rank(el) { const t = el.tagName.toLowerCase(); return t === 'p' ? 0 : t === 'li' ? 1 : (t === 'td' || t === 'th') ? 2 : 3; },
  pick(scope, source) {
    const blocks = Array.from(document.querySelectorAll(scope)).map((b, i) => ({ b, i }))
      .sort((x, y) => this.rank(x.b) - this.rank(y.b) || x.i - y.i).map(x => x.b);
    for (const b of blocks) {
      if (b.querySelector('a,code')) continue;
      const text = b.textContent.replace(/\\s+/g, ' ').trim();
      if (text.length < 12) continue;
      const nodes = this.textNodes(b);
      for (let k = 0; k < nodes.length; k++) {
        const t = nodes[k].textContent;
        for (let i = 0; i + 10 <= t.length; i += 5) {
          const label = t.slice(i, Math.min(i + 14, t.length)).replace(/\\s+$/, '');
          if (label.length < 10 || /[\\r\\n]/.test(label)) continue;
          if (source && source.split(label).length - 1 !== 1) continue;
          return { tag: b.tagName, blockText: text, label, nodeIndex: k, offset: i };
        }
      }
    }
    return null;
  },
  select(rootSel, p) {
    const root = document.querySelector(rootSel);
    const block = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th'))
      .find(b => b.textContent.replace(/\\s+/g, ' ').trim() === p.blockText);
    const node = this.textNodes(block)[p.nodeIndex];
    if (node.textContent.slice(p.offset, p.offset + p.label.length) !== p.label) throw new Error('text node drift');
    const range = document.createRange();
    range.setStart(node, p.offset); range.setEnd(node, p.offset + p.label.length);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  },
};
true`;

async function restoreDoc() {
  if (!original || !saved) { log('restore-skipped', 'no write happened'); return; }
  // 写入已推进 revision / sourceRevision，还原必须按「当前值」下单，否则会被乐观锁拦下
  const current = await evaluate(`${get(`/api/doc/edit?scope=${SCOPE}&group=${SRC_GROUP}&relation=${encodeURIComponent(SRC)}`)}.then(d=>({revision:d.revision,sourceRevision:d.sourceRevision,indexMode:d.indexMode}))`);
  const body = JSON.stringify({
    scope: SCOPE, group: SRC_GROUP, relation: SRC, content: original.content,
    expectedRevision: current.revision, expectedSourceRevision: current.sourceRevision,
    vectorize: current.indexMode === 'dense',
  });
  const r = await evaluate(`fetch('/api/doc/edit', {method:'POST', headers:{'content-type':'application/json'}, body: ${JSON.stringify(body)}}).then(x=>x.json())`);
  log('restored', { ok: r.ok, revision: r.revision && r.revision.slice(0, 12), error: r.error });
  const after = await evaluate(`${get(`/api/doc/edit?scope=${SCOPE}&group=${SRC_GROUP}&relation=${encodeURIComponent(SRC)}`)}.then(d=>({content:d.content,revision:d.revision}))`);
  log('verify-restore', { identical: after.content === original.content, revisionBack: after.revision === original.revision });
}

const guard = setTimeout(() => { log('FATAL', 'scenario timeout'); process.exitCode = 11; }, 220000);
guard.unref();
await connect();
try {
  await goto(`http://127.0.0.1:5188/browse?scope=${SCOPE}&group=${SRC_GROUP}&relation=${encodeURIComponent(SRC)}`);
  await waitFor("document.querySelector('.ki-markdown--drawer')", 30000);
  await sleep(1500);
  await evaluate(HELPERS);
  original = await evaluate(`${get(`/api/doc/edit?scope=${SCOPE}&group=${SRC_GROUP}&relation=${encodeURIComponent(SRC)}`)}.then(d=>({content:d.content,revision:d.revision,sourceRevision:d.sourceRevision,indexMode:d.indexMode}))`);
  log('restore-point', { revision: original.revision.slice(0, 12), len: original.content.length });

  const srcPick = await evaluate(`window.__ki.pick('.ki-markdown--drawer p, .ki-markdown--drawer li, .ki-markdown--drawer h1, .ki-markdown--drawer h2, .ki-markdown--drawer h3', ${JSON.stringify(original.content)})`);
  if (!srcPick) throw new Error('no selectable source block');
  log('source-block', { tag: srcPick.tag, label: srcPick.label });
  await evaluate(`window.__ki.select('.ki-markdown--drawer', ${JSON.stringify(srcPick)})`);
  await waitFor("document.querySelector('.ki-reader-link-panel')", 8000);
  log('panel', await evaluate(`({quote: document.querySelector('.ki-reader-link-panel__quote')?.textContent, buttons: Array.from(document.querySelectorAll('.ki-reader-link-panel button')).map(b=>b.textContent.trim())})`));

  await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-panel button')).find(b=>b.textContent.includes('选择知识库文档或段落')).click()`);
  await waitFor("(document.querySelector('.ki-reader-link-dialog__doc-list')?.querySelectorAll('button').length || 0) > 1", 20000);
  for (let i = 0; i < 50 && !(await evaluate(`Boolean(Array.from(document.querySelectorAll('.ki-reader-link-dialog__doc-list button')).find(x=>x.textContent.includes(${JSON.stringify(TGT)})))`)); i++) {
    if (i === 15) await evaluate(`(() => { const el = document.querySelector('#ki-reader-doc-search'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(TGT)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
  }
  log('dialog-open', { docs: await evaluate(`document.querySelectorAll('.ki-reader-link-dialog__doc-list button').length`), foundTarget: await evaluate(`Boolean(Array.from(document.querySelectorAll('.ki-reader-link-dialog__doc-list button')).find(x=>x.textContent.includes(${JSON.stringify(TGT)})))`) });
  await evaluate(`Array.from(document.querySelectorAll('.ki-reader-link-dialog__doc-list button')).find(x=>x.textContent.includes(${JSON.stringify(TGT)})).click()`);
  await waitFor("(document.querySelector('.ki-reader-link-dialog__preview')?.querySelectorAll('p,li,h1,h2,h3').length || 0) > 5", 30000);
  await sleep(1500);

  const tgtPick = await evaluate(`window.__ki.pick('.ki-reader-link-dialog__preview p, .ki-reader-link-dialog__preview li, .ki-reader-link-dialog__preview h2, .ki-reader-link-dialog__preview h3', null)`);
  if (!tgtPick) throw new Error('no selectable target block');
  log('target-block', { tag: tgtPick.tag, label: tgtPick.label });
  await evaluate(`window.__ki.select('.ki-reader-link-dialog__preview', ${JSON.stringify(tgtPick)})`);
  await waitFor("Boolean(document.querySelector('.ki-reader-link-dialog__selection button:not([disabled])'))", 10000);
  log('footer', await evaluate(`(() => { const s=document.querySelector('.ki-reader-link-dialog__selection'); const d=s.closest('.ki-reader-link-dialog'); return { head: s.querySelector('strong').textContent, quote: s.querySelector('small').textContent, highlight: d.querySelector('.ki-reader-link-target')?.textContent.replace(/\\s+/g,' ').trim().slice(0,36) }; })()`));

  await evaluate(`document.querySelector('.ki-reader-link-dialog__selection button').click()`);
  await waitFor("!document.querySelector('.ki-reader-link-dialog')", 30000);
  await sleep(2000);
  saved = await evaluate(`${get(`/api/doc/edit?scope=${SCOPE}&group=${SRC_GROUP}&relation=${encodeURIComponent(SRC)}`)}.then(d=>({content:d.content,revision:d.revision}))`);
  const written = /\[([^\]]*)\]\(ki-link:([^)]+)\)/.exec(saved.content);
  const link = written ? JSON.parse(decodeURIComponent(written[2])) : null;
  log('saved', { label: written && written[1], anchor: link && link.anchor, target: link && `${link.group}/${link.relation}`, changed: saved.content !== original.content });
  const href = await evaluate(`(() => { const a = Array.from(document.querySelectorAll('.ki-markdown--drawer a.ki-jump-link')).find(x=>x.textContent===${JSON.stringify(written[1])}); return a ? { href: a.getAttribute('href'), blank: a.target } : null; })()`);
  log('link-rendered', href);

  await goto('http://127.0.0.1:5188' + href.href);
  await waitFor("document.querySelector('.ki-anchor-target') || document.querySelector('.ki-drawer__copy-failed')", 30000);
  await sleep(1000);
  log('jumped', await evaluate(`(() => {
    const el = document.querySelector('.ki-anchor-target'); const body = document.querySelector('.ki-drawer__body'); const warn = document.querySelector('.ki-drawer__copy-failed');
    return { head: document.querySelector('.ki-drawer__head')?.textContent.replace(/\\s+/g,' ').trim().slice(0,26), landed: el ? el.tagName + ' :: ' + el.textContent.replace(/\\s+/g,' ').trim().slice(0,40) : null, scrollTop: Math.round(body?.scrollTop || 0), warning: warn ? warn.textContent.slice(0,50) : null };
  })()`));
} catch (error) {
  log('FAIL', error.message);
} finally {
  await restoreDoc();
  process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
}
