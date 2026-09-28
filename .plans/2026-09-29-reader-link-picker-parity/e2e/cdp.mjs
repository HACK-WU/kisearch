import { setTimeout as sleep } from 'node:timers/promises';
const DEBUG = 'http://127.0.0.1:9334';
let id = 0, ws, pending = new Map();

export async function connect() {
  const res = await fetch(`${DEBUG}/json/new?` + new URLSearchParams({ url: 'about:blank' }).toString(), { method: 'PUT' });
  const page = await res.json();
  if (!page.webSocketDebuggerUrl) throw new Error('cannot create page target: ' + JSON.stringify(page).slice(0, 200));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  return page;
}
export function send(method, params = {}) {
  return new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
}
export async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
  return r.result.value;
}
export async function goto(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await evaluate('document.readyState')) return; }
}
export async function waitFor(exprLabel, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await evaluate(`Boolean(${exprLabel})`);
    if (ok) return true;
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + exprLabel);
}
export { sleep };
