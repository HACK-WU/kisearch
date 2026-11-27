/**
 * web/test/code-roots-ui.test.mjs —— S-03 界面与可观测（REQ-20261127-001）
 *
 * 静态源码断言（与 event-source-analysis.test.mjs 同风格）：只锁「文案口径 / 组件落点 /
 * 动作标签 / 契约字段」，不验证真实渲染（渲染走真机走查）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const layer = read('src/chat/PromptConfigLayer.tsx');
const chat = read('src/chat/ChatPanel.tsx');
const api = read('src/api/chatApi.ts');
const contract = read('src/api/chatContract.ts');

describe('S-03 · 文案口径', () => {
  it('对话面板声明 fs_* 与 AI 分析各自独立', () => {
    assert.match(layer, /各自独立开关/);
  });

  it('分析 / 查找面板不再声称 fs_* 仅限 AI 分析', () => {
    assert.doesNotMatch(layer, /仅限事件「AI 分析」使用/);
    assert.doesNotMatch(layer, /属「AI 分析」专属，不在此提供/);
  });

  it('目录卡片改名为「代码目录（分析 / 对话共用）」', () => {
    assert.match(layer, /代码目录（分析 \/ 对话共用）/);
    assert.match(layer, /视图会话不适用默认目录/);
  });
});

describe('S-03 · 视图清单', () => {
  it('渲染 CodeRootsBlock，且只在视图会话展示清单', () => {
    assert.match(layer, /function CodeRootsBlock/);
    assert.match(layer, /codeRoots\.isView/);
    assert.match(layer, /要修改请切到具体知识库/);
  });

  it('reason 码有前端文案映射', () => {
    for (const code of ['unmapped', 'unreadable', 'strict-skipped', 'view-empty', 'view-error', 'forbidden']) {
      assert.ok(layer.includes(`${code}:`) || layer.includes(`'${code}':`), `缺少 ${code} 的文案映射`);
    }
  });

  it('整视图级原因不混入成员列表（view-empty / view-error / forbidden）', () => {
    assert.match(layer, /const memberSkipped = codeRoots\.skipped\.filter/);
    assert.match(layer, /const scopeIssues = codeRoots\.skipped\.filter/);
    const start = layer.indexOf('const members = [');
    const membersBlock = layer.slice(start, layer.indexOf('return (', start));
    assert.match(membersBlock, /memberSkipped/, '成员列表只取 memberSkipped');
    assert.doesNotMatch(membersBlock, /codeRoots\.skipped/, '成员列表不得直接用全部 skipped');
  });

  it('无权限时 banner 显示「成员不可见」而不是「无成员」', () => {
    assert.match(layer, /成员不可见/);
  });

  it('视图清单不可编辑：块内没有输入框 / 开关', () => {
    const block = layer.slice(layer.indexOf('function CodeRootsBlock'), layer.indexOf('export function PromptConfigLayer'));
    assert.doesNotMatch(block, /<input|role="switch"/);
  });
});

describe('S-03 · 动作标签与接口', () => {
  it('时间线为 4 个 fs_* 提供动作名', () => {
    for (const [name, label] of [
      ['fs_read', '读取文件'],
      ['fs_grep', '检索源码'],
      ['fs_find', '查找文件'],
      ['fs_ls', '浏览目录'],
    ]) {
      assert.match(chat, new RegExp(`${name}: '${label}'`), `${name} 缺少动作名 ${label}`);
    }
  });

  it('设置接口按当前 scope 拉取 codeRoots', () => {
    assert.match(api, /scope=\$\{encodeURIComponent\(scope\)\}/);
    assert.match(contract, /codeRoots\?: CodeRootsDto/);
    assert.match(contract, /'unmapped'[\s\S]{0,200}'forbidden'/);
  });
});
