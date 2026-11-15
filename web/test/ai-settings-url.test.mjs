/**
 * AI 设置页 URL 口径（2026-11-15）· 纯函数单测
 *
 * 锁住三条不变量：
 *   1) 入口地址只由 `aiSettingsHref` 产出 —— 4 个入口各自拼字符串必然漂移；
 *   2) `from` 必须能原样往返（含查询串），否则"从带参数的页面进来"返回时会丢参数；
 *   3) `from` **只放行站内绝对路径** —— `//host` 与 `http(s)://` 一律回默认页（开放重定向）。
 *
 * 运行：cd web && node --test test/ai-settings-url.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
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

const {
  AI_SETTINGS_PATH,
  AI_SETTINGS_DEFAULT_BACK,
  aiSettingsHref,
  isAiSettingsPath,
  resolveAiSettingsBack,
} = await vite.ssrLoadModule('/src/lib/aiSettingsUrl.ts');

after(async () => { await vite.close(); });

describe('aiSettingsHref · 入口地址', () => {
  it('无参时就是路径本身', () => {
    assert.equal(aiSettingsHref(), AI_SETTINGS_PATH);
    assert.equal(aiSettingsHref({}), AI_SETTINGS_PATH);
  });

  it('能力分组写进 ?cap=', () => {
    assert.equal(aiSettingsHref({ cap: 'analysis' }), `${AI_SETTINGS_PATH}?cap=analysis`);
  });

  it('from 含查询串时能被完整还原（编码不是"看起来对"就行）', () => {
    const from = '/governance/events?tab=list&q=%E7%99%BB%E5%BD%95';
    const href = aiSettingsHref({ from });
    const parsed = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    assert.equal(parsed.get('from'), from, '往返后应逐字相同');
  });

  it('cap 与 from 可同时带上', () => {
    const href = aiSettingsHref({ cap: 'find', from: '/events' });
    const parsed = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    assert.equal(parsed.get('cap'), 'find');
    assert.equal(parsed.get('from'), '/events');
  });
});

describe('resolveAiSettingsBack · 返回目标只认站内绝对路径', () => {
  it('缺省（直接访问 / 刷新）回默认页', () => {
    assert.equal(resolveAiSettingsBack(null), AI_SETTINGS_DEFAULT_BACK);
    assert.equal(resolveAiSettingsBack(''), AI_SETTINGS_DEFAULT_BACK);
  });

  it('站内路径原样返回（含查询串）', () => {
    assert.equal(resolveAiSettingsBack('/chat'), '/chat');
    assert.equal(resolveAiSettingsBack('/governance/events?tab=list'), '/governance/events?tab=list');
  });

  it('协议相对地址被挡住（开放重定向）', () => {
    assert.equal(resolveAiSettingsBack('//evil.example.com/x'), AI_SETTINGS_DEFAULT_BACK);
  });

  it('绝对 URL 与相对路径被挡住', () => {
    assert.equal(resolveAiSettingsBack('https://evil.example.com'), AI_SETTINGS_DEFAULT_BACK);
    assert.equal(resolveAiSettingsBack('events'), AI_SETTINGS_DEFAULT_BACK);
  });
});

describe('isAiSettingsPath · 顶栏 toggle 的判定', () => {
  it('精确命中与子路径都算"在设置页"', () => {
    assert.equal(isAiSettingsPath('/settings/ai'), true);
    assert.equal(isAiSettingsPath('/settings/ai/'), true);
  });

  it('前缀相近的其它页面不算（避免把 /settings/ai-ray 也当设置页）', () => {
    assert.equal(isAiSettingsPath('/settings/ai-v2'), false);
    assert.equal(isAiSettingsPath('/settings'), false);
    assert.equal(isAiSettingsPath('/'), false);
  });
});
