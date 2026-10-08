import assert from 'node:assert/strict';
import path from 'node:path';
import { after, it } from 'node:test';
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
const { revealTreeRow } = await vite.ssrLoadModule('/src/lib/treeReveal.ts');
after(async () => vite.close());

function directory(nameLeft, nameWidth) {
  const container = {
    scrollLeft: 110, scrollTop: 0, clientWidth: 284, clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    scrollTo({ left, top }) { this.scrollLeft = Math.max(0, left); this.scrollTop = Math.max(0, top); },
  };
  const row = {
    getBoundingClientRect: () => ({ top: 1000, height: 32 }),
    querySelector: (selector) => ({ getBoundingClientRect: () => selector.includes('__name')
      ? ({ left: nameLeft, right: nameLeft + nameWidth, width: nameWidth })
      : ({ left: nameLeft - 21, right: nameLeft - 6, width: 15 }) }),
  };
  return { container, row };
}

it('keeps horizontal context when a sibling has a short name near the left edge', () => {
  const { container, row } = directory(0, 30);
  revealTreeRow(container, row, true);
  assert.equal(container.scrollLeft, 110);
  assert.ok(container.scrollTop > 0, 'the new document still needs vertical reveal');
});

it('keeps horizontal context for a sibling name wider than the directory', () => {
  const { container, row } = directory(180, 900);
  revealTreeRow(container, row, true);
  assert.equal(container.scrollLeft, 110);
});

it('still reveals the name horizontally on the first navigation', () => {
  const { container, row } = directory(400, 100);
  revealTreeRow(container, row);
  assert.ok(container.scrollLeft > 110);
  assert.ok(container.scrollTop > 0);
});

it('reveals the complete file icon with a left inset for a long document name', () => {
  const { container, row } = directory(180, 900);
  const originalIconLeft = 159;
  revealTreeRow(container, row);
  const iconLeft = originalIconLeft - (container.scrollLeft - 110);
  assert.equal(iconLeft, 16);
});
