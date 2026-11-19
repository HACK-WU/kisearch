/**
 * 内置提示词 / skill「内置已更新」提示（2026-11-19）。
 *
 * 结论：
 *  1. 后端读取时会把手动改过的（`edited === true`）原样保留，未改过的（`edited === false`）刷成代码最新版；
 *     能走到界面的只剩「历史配置（没有 edited 字段）」+ 内容与默认不一致 —— 这一种必须提示，否则用户
 *     永远不知道自己看的还是旧版正文（真机症状：设置页 skill 1121 字，代码里已经 1716 字）。
 *  2. 提示不能复用「已修改」：一个是"该点恢复默认"，一个是"你自己改的、不用管"，语义相反。
 *  3. 六个入口（对话/分析/查找 × 提示词 + skill）都要传 `stale`，漏一个就等于那条路径静默。
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
const css = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');
const contract = fs.readFileSync(path.join(webRoot, 'src/api/chatContract.ts'), 'utf8');

describe('内置条目「内置已更新」提示', () => {
  it('判定口径：edited !== true 且内容与代码默认不同', () => {
    const start = layer.indexOf('const isStaleBuiltin');
    assert.ok(start > 0, '未找到 isStaleBuiltin 判定');
    const body = layer.slice(start, start + 400);
    assert.ok(body.includes('defContent !== undefined'), '没有默认内容可比时不得提示（用户自建 skill）');
    assert.ok(body.includes('item.edited !== true'), '用户改过的（edited === true）不算"内置已更新"');
    assert.ok(body.includes('item.content !== defContent'), '内容已等于默认就不该再提示');
  });

  it('三态文案：默认 / 已修改 / 内置已更新 互斥', () => {
    assert.ok(layer.includes("'内置已更新'"), '缺少「内置已更新」文案');
    assert.ok(layer.includes("stale ? '内置已更新' : mod ? '已修改' : '默认'"), '三态必须是互斥分支');
    assert.ok(layer.includes('ki-chat-cfg__item-meta--stale'), '缺少 stale 的独立样式类');
    assert.ok(css.includes('.ki-chat-cfg__item-meta--stale'), 'CSS 未定义 stale 配色');
  });

  it('六个入口都传了 stale（漏一个那条路径就静默）', () => {
    const count = (layer.match(/stale=\{isStaleBuiltin\(/g) ?? []).length;
    assert.equal(count, 6, `应为 6 处（对话/分析/查找 × 提示词 + skill），实际 ${count} 处`);
  });

  it('契约里能读到 edited（否则前端无从判断）', () => {
    assert.ok(contract.includes('edited?: boolean'), 'CapabilityPrompt / PromptSkill 必须暴露 edited');
  });
});
