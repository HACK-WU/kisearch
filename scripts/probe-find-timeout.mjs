#!/usr/bin/env node
/**
 * 探测「AI 查找」深度通道在你的真实部署上能跑多久。
 *
 * 为什么要这个脚本：深度查找是**同步长请求**（服务端硬超时固定 45s，不可配），本机回环能跑通
 * 不代表经过网关也能跑通 —— 网关常在自己的超时点直接断掉连接，服务端只会看到
 * "客户端提前断开"，前端看到的是一个没有错误码的失败。这件事没法在代码里推断，
 * 只能在目标环境实测一次。
 *
 * 用法：
 *   node scripts/probe-find-timeout.mjs --event <事件 id> --scope <库名> [--base URL] [--token T] [--repeat N]
 *
 *   事件可以随手建一个（哪怕没关联文档），本脚本只关心**耗时**与**是否被断开**。
 *
 * 判读：
 *   · 成功 200  → 打印实际耗时；repeat 多次时取最大值，与 45s 硬超时比对给出余量判断
 *   · 502/504/000/连接被重置 → 大概率是网关超时（超时已不可配，只能放行网关或缩小范围）
 *   · 503 FIND_LLM_UNAVAILABLE 等业务码 → 不是网关问题，按错误码去修配置
 */

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const base = (arg('base', 'http://127.0.0.1:7423')).replace(/\/+$/, '');
const event = arg('event');
const scope = arg('scope');
const token = arg('token', '');
const repeat = Math.max(1, Math.min(5, Number(arg('repeat', '1')) || 1));
const mode = arg('mode', 'deep');

if (!event || !scope) {
  console.error('缺少参数：--event <事件 id> --scope <库名>');
  console.error('示例：node scripts/probe-find-timeout.mjs --event evt_xxx --scope my-kb');
  process.exit(2);
}

const url = `${base}/api/governance/events/${encodeURIComponent(event)}/refs/search`;
const headers = { 'Content-Type': 'application/json' };
if (token) headers.Authorization = `Bearer ${token}`;

const results = [];

for (let i = 1; i <= repeat; i += 1) {
  const started = Date.now();
  let status = 0;
  let body = null;
  let netError = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope, mode }),
    });
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 300) };
    }
  } catch (err) {
    netError = err?.message ?? String(err);
  }
  const elapsed = Date.now() - started;
  results.push({ i, status, elapsed, netError, body });
  const tag = status === 0 ? `网络错误：${netError}` : `HTTP ${status}`;
  console.log(`#${i} ${tag} · ${elapsed}ms${body?.partial ? ` · partial=${JSON.stringify(body.partial)}` : ''}`);
}

const ok = results.filter((r) => r.status === 200);
/*
 * 只有「连不上 / 网关自己的错误码 / 503 且无业务码」才算被断开。
 * 503 也可能是 `FIND_LLM_UNAVAILABLE` 这类业务码 —— 那种是配置问题，
 * 归到 broken 会让用户跑去调超时，白费一轮。
 */
const broken = results.filter(
  (r) => r.status === 0 || [502, 504].includes(r.status) || (r.status === 503 && !r.body?.code),
);
const slowestOk = ok.reduce((m, r) => Math.max(m, r.elapsed), 0);

console.log('');
if (ok.length === 0) {
  const code = results.find((r) => r.body?.code)?.body?.code;
  if (broken.length > 0) {
    console.log('结论：本次请求**没跑完**就被断开（网关超时 / 连接被重置）。');
    console.log(`· 断开前最长耗时：${Math.max(...results.map((r) => r.elapsed))}ms`);
    console.log('· 处理：让网关放行长请求（深度查找的 45 秒硬超时不可配），或缩小检索范围改用快速查找。');
  } else {
    console.log(`结论：请求被拒绝（${code ?? '无错误码'}），不是超时问题；按错误码先修配置。`);
  }
  process.exit(1);
}

console.log(`结论：深度查找在 ${base} 上可完成，最慢一次 ${slowestOk}ms（服务端硬超时 45s，不可配）。`);
if (slowestOk > 30_000) {
  console.log('· ⚠️ 已逼近 45 秒硬超时：再慢会被服务端掐断，建议缩小检索范围或减少额外库。');
}
if (broken.length > 0) {
  console.log(`· ⚠️ 另有 ${broken.length} 次被断开：该路径不稳定，需让网关放行长请求，或缩小检索范围。`);
}
