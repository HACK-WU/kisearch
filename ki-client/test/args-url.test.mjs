/**
 * 参数解析与 URL 拼接的单元测试（跑编译后的 dist，零额外构建配置）。
 *
 * 运行：npm test（会先 build）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../dist/args.js';
import { joinUrl } from '../dist/http.js';
import { safeFileName } from '../dist/commands/doc.js';
import { ClientError } from '../dist/errors.js';

/** 断言抛出指定 code 的 ClientError */
function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ClientError, `期望 ClientError，实际 ${err?.constructor?.name}`);
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`);
    return err;
  }
  assert.fail(`期望抛出 ${code}，实际没有抛`);
}

describe('parseArgs：值型 / 布尔 / 未知', () => {
  it('值型 flag 吞下一个词，位置参数不受影响', () => {
    const args = parseArgs(['upload-dir', '--scope', 'demo', '--wait', '/tmp/src']);
    assert.deepEqual(args.positionals, ['upload-dir', '/tmp/src']);
    assert.equal(args.string('scope'), 'demo');
    assert.equal(args.bool('wait'), true);
  });

  it('布尔 flag 不会吞掉后面的位置参数（曾经的 bug）', () => {
    const args = parseArgs(['--wait', '/tmp/src']);
    assert.deepEqual(args.positionals, ['/tmp/src']);
    assert.equal(args.bool('wait'), true);
  });

  it('--name=value 形态', () => {
    const args = parseArgs(['--scope=demo', '--json']);
    assert.equal(args.string('scope'), 'demo');
    assert.equal(args.bool('json'), true);
  });

  it('-- 之后全部当位置参数（即使看起来像 flag）', () => {
    const args = parseArgs(['--', '--wait', 'a.md']);
    assert.deepEqual(args.positionals, ['--wait', 'a.md']);
    assert.equal(args.bool('wait'), false);
  });

  it('未知 flag 立刻报错，不静默变成布尔', () => {
    expectCode(() => parseArgs(['--scop', 'demo']), 'USAGE');
  });

  it('值型 flag 缺值立刻报错', () => {
    expectCode(() => parseArgs(['--scope']), 'USAGE');
    expectCode(() => parseArgs(['--scope', '--json']), 'USAGE');
  });
});

describe('joinUrl：基地址与编码', () => {
  it('基地址带子路径时保留前缀', () => {
    assert.equal(joinUrl('https://h/ki', '/open/v1/ping'), 'https://h/ki/open/v1/ping');
  });

  it('基地址尾部斜杠不影响拼接', () => {
    assert.equal(joinUrl('http://h:1/', '/open/v1/ping'), 'http://h:1/open/v1/ping');
  });

  it('query 里的 / 与中文被正确编码，空值被跳过', () => {
    const url = new URL(joinUrl('http://h:1', '/open/v1/asset', {
      path: 'shots/a.png',
      group: '故障/复盘',
      scope: undefined,
      empty: '',
    }));
    assert.equal(url.searchParams.get('path'), 'shots/a.png');
    assert.equal(url.searchParams.get('group'), '故障/复盘');
    assert.equal(url.searchParams.has('scope'), false);
    assert.equal(url.searchParams.has('empty'), false);
  });
});

describe('safeFileName：落盘文件名净化', () => {
  it('路径分隔与 Windows 非法字符换成连字符', () => {
    assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  });

  it('去掉首尾空格与点（避免 .hidden / 尾点导致的落盘异常）', () => {
    assert.equal(safeFileName('  ..名字..  '), '名字');
  });

  it('净化后为空时回退 untitled（全是空白或点）', () => {
    assert.equal(safeFileName('...'), 'untitled');
    assert.equal(safeFileName('   '), 'untitled');
    // 全非法字符会退化成连字符串：仍可落盘，不做额外折叠（保留用户输入的可辨识度）
    assert.equal(safeFileName('///'), '---');
  });
});
