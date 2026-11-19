/**
 * code-ref.test.ts —— 结论正文里的代码位置 / 符号识别（2026-11-19）
 *
 * 背景：真实分析里模型把路径与符号写在 `chain[].text` 的反引号里
 * （`` `src/lib/governance-contract.ts` ``、`` `liveThinking?` ``），`ref` 字段却是空的 ——
 * 只在 ref 有值时才给胶囊，等于页面上"看得见位置、点不动"。
 *
 * 规则取向：**先精确后宽松**。有行号就精确匹配，没有行号就取同文件 / 同符号里行号最小的一处；
 * 歧义不隐藏 —— 由浮层首行的 `file:line` 与页脚「该文件另有 N 处」交代。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/code-ref.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  countSiblingsInFile,
  matchConfirmedLocation,
  normalizeRefPath,
  parseRefSymbol,
  parseRefText,
} from '../web/src/lib/codeRef.js';

const ROOT = process.cwd();
const loc = (id: string, file: string, line: number, endLine?: number, snippet?: string) => ({
  id,
  file,
  line,
  ...(endLine === undefined ? {} : { endLine }),
  ...(snippet === undefined ? {} : { snippet }),
});

describe('parseRefText：什么样的文本才算"代码位置"', () => {
  it('接受 path 与 path:line', () => {
    assert.deepEqual(parseRefText('src/auth/guard.ts'), { path: 'src/auth/guard.ts', line: null });
    assert.deepEqual(parseRefText('src/auth/guard.ts:128'), { path: 'src/auth/guard.ts', line: 128 });
  });

  it('去掉开头的 ./ 与反斜杠，正斜杠归一', () => {
    assert.equal(parseRefText('./src/a.ts')!.path, 'src/a.ts');
    assert.equal(parseRefText('web\\src\\a.tsx')!.path, 'web/src/a.tsx');
    assert.equal(normalizeRefPath('./a/b.ts'), 'a/b.ts');
  });

  it('行号 0 视为没给行号（写错的行号不该被当成精确位置）', () => {
    assert.deepEqual(parseRefText('src/a.ts:0'), { path: 'src/a.ts', line: null });
  });

  it('裸符号 / 目录 / URL 一律不当路径', () => {
    for (const text of ['catch', 'setMessage', 'pinnedAt', 'src/lib/events', 'GET /api/governance/events/:id', '']) {
      assert.equal(parseRefText(text), null, `${text} 不该被当成路径`);
    }
  });
});

describe('parseRefSymbol：符号形态', () => {
  it('取最后一段，去掉调用括号与可选标记', () => {
    assert.equal(parseRefSymbol('liveThinking?'), 'liveThinking');
    assert.equal(parseRefSymbol('EventView.pinnedAt'), 'pinnedAt');
    assert.equal(parseRefSymbol('loadDetail()'), 'loadDetail');
  });

  it('太短或通用关键字不认（否则会把满屏代码链到随机快照）', () => {
    for (const text of ['abc', 'type', 'props', 'catch', 'true', 'a.b']) {
      assert.equal(parseRefSymbol(text), null, `${text} 不该被当成符号`);
    }
  });
});

describe('matchConfirmedLocation：路径匹配', () => {
  const confirmed = [
    loc('a', 'src/lib/governance-contract.ts', 63, 64),
    loc('b', 'web/src/api/governanceContract.ts', 412, 413),
    loc('c', 'web/src/api/governanceContract.ts', 448, 452),
    loc('d', 'src/lib/events/types.ts', 199, 226),
  ];

  it('精确行号命中', () => {
    assert.equal(matchConfirmedLocation('`src/lib/governance-contract.ts:63`', confirmed)?.id, 'a');
  });

  it('行号落在该位置的起止区间内也算命中', () => {
    assert.equal(matchConfirmedLocation('src/lib/events/types.ts:210', confirmed)?.id, 'd');
  });

  it('行号对不上（同文件但不在这几处）→ 不认', () => {
    assert.equal(matchConfirmedLocation('src/lib/governance-contract.ts:999', confirmed), null);
  });

  it('不带行号且同文件多处 → 取行号最小的一处（不是不认）', () => {
    // 412 < 448，所以取 b；歧义由浮层的 file:line 与页脚交代
    assert.equal(matchConfirmedLocation('web/src/api/governanceContract.ts', confirmed)?.id, 'b');
  });

  it('省略前缀目录也能对上（file 一侧是 text 的后缀）', () => {
    assert.equal(matchConfirmedLocation('api/governanceContract.ts:448', confirmed)?.id, 'c');
  });

  it('路径完全无关 → 不认', () => {
    assert.equal(matchConfirmedLocation('src/other/thing.ts:1', confirmed), null);
  });
});

describe('matchConfirmedLocation：符号匹配（按快照正文找）', () => {
  const confirmed = [
    loc('a', 'src/lib/governance-contract.ts', 63, 64, '/** 置顶时间 */\n  pinnedAt?: number;'),
    loc('b', 'web/src/api/governanceContract.ts', 265, 266, '  thinkingChars?: number;'),
    loc('c', 'web/src/api/governanceContract.ts', 448, 452, '  liveThinking?: { round: number; text: string; chars: number };'),
    loc('d', 'web/src/api/governanceContract.ts', 412, 413, '  thinkingChars?: number;'),
  ];

  it('符号出现在唯一一处快照里 → 命中', () => {
    assert.equal(matchConfirmedLocation('`liveThinking?`', confirmed)?.id, 'c');
    assert.equal(matchConfirmedLocation('`pinnedAt?`', confirmed)?.id, 'a');
  });

  it('限定名取最后一段再匹配（EventView.pinnedAt → pinnedAt）', () => {
    assert.equal(matchConfirmedLocation('`EventView.pinnedAt`', confirmed)?.id, 'a');
  });

  it('同一符号出现在多处 → 取行号最小的一处', () => {
    // thinkingChars 同时在 265(b) 与 412(d)，265 更小
    assert.equal(matchConfirmedLocation('`thinkingChars?`', confirmed)?.id, 'b');
  });

  it('快照里根本没有该符号 → 不认（不做"就近猜"）', () => {
    assert.equal(matchConfirmedLocation('`useSomethingElse`', confirmed), null);
  });
});

describe('countSiblingsInFile：浮层页脚的同文件提示', () => {
  const confirmed = [
    loc('a', 'web/src/api/governanceContract.ts', 412),
    loc('b', 'web/src/api/governanceContract.ts', 448),
    loc('c', 'src/lib/governance-contract.ts', 63),
  ];

  it('同文件其它位置计数（不含自己）', () => {
    assert.equal(countSiblingsInFile(confirmed[0]!, confirmed), 1);
    assert.equal(countSiblingsInFile(confirmed[2]!, confirmed), 0);
  });
});

describe('组件接线：正文反引号里的位置要能变成胶囊', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'web/src/components/governance/event-detail/ConclusionChain.tsx'),
    'utf8',
  );

  it('复用 codeRef 的解析，且正文片段也走匹配（不是只看 node.ref）', () => {
    assert.ok(src.includes("from '@/lib/codeRef'"), '必须复用 codeRef 的解析');
    assert.ok(
      src.includes('matchConfirmedLocation(inner, confirmed)'),
      '正文片段（反引号内）也要走匹配，否则模型不填 ref 时整块都点不动',
    );
  });

  it('浮层交代同文件还有几处（避免"跳到了别的位置"的误解）', () => {
    assert.ok(src.includes('countSiblingsInFile'), '打开浮层时要算同文件其它位置数');
    assert.ok(src.includes('该文件另有'), '页脚要有对应文案');
  });
});
