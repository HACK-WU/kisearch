/**
 * 对话页头部与路由顺序守卫（REQ-20261116-003）
 *
 * 这两处都是"改回去也照样能编译、单测也不红"的地方，只能靠源码守卫：
 * 1. 切换会话列表按钮必须在「居中 / 铺满」**右侧**（用户 2026-11-16 指出的可发现性问题）；
 * 2. `/chat/ask/:askId` 必须排在 `/chat/:convId` **之前**，否则 `ask` 会被当成 convId 吞掉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

describe('对话页上下文条按钮顺序', () => {
  it('切换按钮位于「居中/铺满」之后、配置之前', () => {
    const src = read('../src/chat/ChatPanel.tsx');
    const start = src.indexOf('<div className="ki-chat-ctx">');
    assert.ok(start > 0, '找不到上下文条');
    const ctx = src.slice(start, start + 4000);

    const iModel = ctx.indexOf('ki-chat-ctx__model');
    const iSeg = ctx.indexOf('ki-chatpage__widthseg');
    const iBtn = ctx.indexOf('{convBtnNode}');
    const iCfg = ctx.indexOf('ki-chat-cfg__entry');

    assert.ok(iModel >= 0 && iSeg >= 0 && iBtn >= 0 && iCfg >= 0, '上下文条里缺少某个元素');
    assert.ok(iModel < iSeg, '模型名应在宽度切换之前');
    assert.ok(iSeg < iBtn, '切换会话列表按钮必须在「居中 / 铺满」右侧');
    assert.ok(iBtn < iCfg, '切换会话列表按钮应在「配置」之前');
  });

  it('上下文条左侧不再残留 convbtn 内联实现', () => {
    const src = read('../src/chat/ChatPanel.tsx');
    const start = src.indexOf('<div className="ki-chat-ctx">');
    const ctx = src.slice(start, start + 4000);
    assert.doesNotMatch(ctx, /className="ki-chat-iconbtn ki-chatpage__convbtn"/,
      '按钮应通过 {convBtnNode} 统一渲染，否则会出现两个切换入口');
  });
});

describe('agent 问答详情路由顺序', () => {
  it('/chat/ask/:askId 必须排在 /chat/:convId 之前', () => {
    const src = read('../src/router/routes.tsx');
    const iAsk = src.indexOf('path="chat/ask/:askId"');
    const iConv = src.indexOf('path="chat/:convId"');
    assert.ok(iAsk > 0, '缺少 agent 详情路由');
    assert.ok(iConv > 0, '缺少会话深链路由');
    assert.ok(iAsk < iConv, '顺序错会让 chat/ask/xxx 被 :convId 段匹配');
  });
});
