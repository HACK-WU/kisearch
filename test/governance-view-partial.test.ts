/**
 * governance-view-partial.test.ts —— 视图「部分成功」不得静默（#56 / #57）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-view-partial.test.ts
 *
 * 为什么单开：后端对每个成员库单独 try/catch，失败只写 `buckets[].error`、整体仍 200 + ok:true；
 * 列表又用固定 limit + `hasMore` 表示"还有更多"。这两条通道**前端此前一条都没读**，
 * 表现为「某库数据凭空少了 / 100 条以后凭空没了」。触发条件是「某成员库读挂了」或
 * 「合计条数超过 limit」，平时看不出来 —— 所以用单测把消费点钉住，而不是靠人肉回归。
 *
 * 覆盖：
 *   ① `govFailedMembers` 只认失败行（成功行不得被当成失败）；
 *   ② `govFailedNotice` 文案含库名与原因、空数组给空串（可无条件拼接）、超长错误截断；
 *   ③ `govLoadedNotice` 以 `hasMore` 为准（不用 loaded < total 猜）；
 *   ④ 三个页面确实消费了失败库与截断信号（源码守卫，防"顺手清理"）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  govFailedMembers, govFailedNotice, govFailedTitle, govLoadedNotice,
} from '../web/src/lib/governanceView.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('视图部分成功：失败库与截断', () => {
  it('govFailedMembers：只取 buckets 里带 error 的行', () => {
    const failed = govFailedMembers({
      buckets: [
        { scope: 'a', total: 3 },
        { scope: 'b', error: 'EACCES: permission denied' },
        { scope: 'c', error: '' },
        { total: 9 },
      ],
    });
    assert.deepEqual(failed, [{ scope: 'b', error: 'EACCES: permission denied' }]);
  });

  it('govFailedMembers：单库 / 旧 daemon / null 一律空数组（不得抛错）', () => {
    assert.deepEqual(govFailedMembers(null), []);
    assert.deepEqual(govFailedMembers(undefined), []);
    assert.deepEqual(govFailedMembers({}), []);
    assert.deepEqual(govFailedMembers({ buckets: [] }), []);
  });

  it('govFailedNotice：含库名与原因；多库用「；」分隔', () => {
    const failed = [{ scope: 'kisearch-xperts', error: 'ENOENT' }, { scope: 'x2', error: 'boom' }];
    const text = govFailedNotice(failed);
    assert.match(text, /读取失败/);
    assert.match(text, /kisearch-xperts、x2/, '正文只列库名');
    assert.match(text, /不在本次结果里/);
    // 原因不内联（会带服务器绝对路径），走 title
    assert.ok(!text.includes('ENOENT'), '正文不得内联错误原文');
    assert.equal(govFailedTitle(failed), 'kisearch-xperts：ENOENT\nx2：boom');
    assert.equal(govFailedTitle([]), undefined);
  });

  it('govFailedNotice：空数组返回空串（调用方可无条件拼进提示条）', () => {
    assert.equal(govFailedNotice([]), '');
  });

  it('govFailedNotice：超长错误截断到 80 字符 + 省略号', () => {
    const long = 'x'.repeat(300);
    const title = govFailedTitle([{ scope: 's', error: long }]) ?? '';
    assert.ok(title.includes(`${'x'.repeat(80)}…`), 'title 里应保留前 80 字符并加省略号');
    assert.ok(!title.includes('x'.repeat(81)), '不得把 300 字符原样挂上去');
  });

  it('govLoadedNotice：hasMore=false 时闭嘴，即使 loaded < total', () => {
    assert.equal(govLoadedNotice(8, 49, false), '');
  });

  it('govLoadedNotice：hasMore=true 时给出「显示 / 共 N 条」两个数字', () => {
    const text = govLoadedNotice(8, 49, true);
    // 措辞用「显示」不用「前 N 条」：事件列表开了 includePinned，列表 ≠ 筛选结果的前缀
    assert.match(text, /显示 8 条/);
    assert.match(text, /共 49 条/);
    assert.match(text, /还有更多/);
    assert.ok(!/前 8 条/.test(text), '不得写成「前 N 条」（置顶豁免会让 loaded 含筛选外条目）');
  });
});

describe('三个页面必须消费这两条通道（源码守卫）', () => {
  const pages = {
    lifecycle: read('web/src/pages/LifecyclePage.tsx'),
    trash: read('web/src/pages/TrashPage.tsx'),
    events: read('web/src/pages/EventsPage.tsx'),
  };

  for (const [name, src] of Object.entries(pages)) {
    it(`${name}：把 buckets[].error 落进 viewInfo 并渲染 govFailedNotice`, () => {
      assert.match(src, /govFailedMembers\(/, `${name} 未解析 buckets[].error`);
      assert.match(src, /govFailedNotice\(/, `${name} 未把失败库显示出来`);
      assert.match(src, /govFailedTitle\(/, `${name} 未把失败原因挂到 title`);
    });
  }

  it('events：视图下消费 hasMore（此前写死 limit:100 且从不读该字段）', () => {
    assert.match(pages.events, /hasMore/, 'events 页未读取 hasMore');
    assert.match(pages.events, /govLoadedNotice\(/, 'events 页未渲染「还有更多」提示');
    assert.match(pages.events, /skipped/, 'events 页未展示未参与的成员库');
  });

  it('events：单库截断也要提示（#58：那条提示不能只挂在 isViewScope 下）', () => {
    assert.match(
      pages.events,
      /!isViewScope && viewMeta\?\.hasMore/,
      '单库（非视图）截断没有提示出口',
    );
    // 单库分支同样下发 hasMore / total，只在视图下赋值会让单库拿到旧值
    assert.ok(
      /setViewMeta\(\{/.test(pages.events),
      'setViewMeta 必须在视图 / 单库两种模式下都赋值',
    );
  });

  it('events：解释性文案已按用户拍板删除（只留状态提示）', () => {
    assert.ok(
      !/聚合视图：事件按成员库合并展示/.test(pages.events),
      '「聚合视图…」说明句已删除，不得回潮（2026-11-20 用户拍板）',
    );
    assert.match(pages.events, /viewNotices !== ''/, '无状态时整条提示不渲染');
  });
});
