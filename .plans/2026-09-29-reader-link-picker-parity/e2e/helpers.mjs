export const HELPERS = `
window.__ki = {
  textNodes(root) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const out = []; let n; while ((n = w.nextNode())) out.push(n); return out; },
  firstText(block) { return this.textNodes(block)[0] || null; },
  rank(el) { const t = el.tagName.toLowerCase(); return t === 'p' ? 0 : t === 'li' ? 1 : (t === 'td' || t === 'th') ? 2 : 3; },
  blocksIn(rootSel) { return Array.from(document.querySelector(rootSel).querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th')); },
  norm(el) { return el.textContent.replace(/\\s+/g, ' ').trim(); },
  // 与产品 anchorKind 同口径：六级标题共用 h，其余按标签。anchor 相同 <=> kind + 归一化文本相同。
  anchorKind(el) { const t = el.tagName.toLowerCase(); return (t === 'p' || t === 'li' || t === 'td' || t === 'th') ? t : t.startsWith('h') ? 'h' : t; },
  anchorKey(el) { return this.anchorKind(el) + '\\u0001' + this.norm(el); },
  anchorCounts(rootSel) {
    const counts = new Map();
    for (const b of this.blocksIn(rootSel)) { const k = this.anchorKey(b); counts.set(k, (counts.get(k) || 0) + 1); }
    return counts;
  },
  // 找第一个「落点数符合 wantDup」且文本足够长的块；at 是块在 blocksIn 里的下标，供 selectBlock 用
  findBlockByAnchor(rootSel, wantDup, minTextLen) {
    const counts = this.anchorCounts(rootSel);
    const blocks = this.blocksIn(rootSel);
    for (let i = 0; i < blocks.length; i++) {
      const n = counts.get(this.anchorKey(blocks[i])) || 0;
      if ((n > 1) !== wantDup) continue;
      const node = this.firstText(blocks[i]);
      if (!node || node.textContent.length < minTextLen) continue;
      return { at: i, kind: this.anchorKind(blocks[i]), times: n, text: this.norm(blocks[i]).slice(0, 28) };
    }
    return null;
  },
  selectBlock(rootSel, at, from, len) {
    const block = this.blocksIn(rootSel)[at];
    const node = block ? this.firstText(block) : null;
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, from); range.setEnd(node, Math.min(from + len, node.length));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { picked: this.norm(block).slice(0, 24), selected: range.toString() };
  },
  pick(rootSel, source) {
    const blocks = this.blocksIn(rootSel).map((b, i) => ({ b, i }))
      .sort((x, y) => this.rank(x.b) - this.rank(y.b) || x.i - y.i).map(x => x.b);
    for (const b of blocks) {
      if (b.querySelector('a,code')) continue;
      const text = this.norm(b);
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
    const block = this.blocksIn(rootSel).find(b => this.norm(b) === p.blockText);
    const node = this.textNodes(block)[p.nodeIndex];
    if (node.textContent.slice(p.offset, p.offset + p.label.length) !== p.label) throw new Error('text node drift');
    const range = document.createRange();
    range.setStart(node, p.offset); range.setEnd(node, p.offset + p.label.length);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  },
  selectWhole(rootSel, blockIndex, from, len) {
    const block = this.blocksIn(rootSel).filter(b => this.norm(b).length > from + len)[blockIndex];
    const node = this.firstText(block);
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, from); range.setEnd(node, Math.min(from + len, node.length));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return this.norm(block).slice(0, 16);
  },
  selectAcross(rootSel) {
    const withText = this.blocksIn(rootSel).filter(b => this.firstText(b));
    const a = withText[0], b = withText[1];
    const na = this.firstText(a), nb = this.firstText(b);
    const range = document.createRange();
    range.setStart(na, 2); range.setEnd(nb, Math.min(6, nb.length));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    a.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return this.norm(a).slice(0, 12) + ' -> ' + this.norm(b).slice(0, 12);
  },
};
true`;
