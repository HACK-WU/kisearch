/**
 * trash-broken-judgement.test.mjs —— 回收站「正文缺失」判据的静态守卫（事件 #81）
 *
 * 背景：判据曾用 `sizeBytes === 0`，而 sizeBytes 是**入站瞬间**的目录字节快照
 * （此刻还没写 meta.json）。入站后 content.md 丢失的条目该值停在旧值 >0，
 * 于是页面无「正文缺失」徽标、名字可点、恢复可点，diagnostics 同时漏报。
 * 真机复现见 `.debug/trash-broken-judgement-20261123/`。
 *
 * 交互本身靠真机验证，这里只挡「判据退回 sizeBytes」这类结构性回退：
 *   ① 前端 broken / 批量可恢复都认 `hasContent`，且只认 `false`（兼容旧 daemon）
 *   ② 前端不再拿 sizeBytes 判正文存在性
 *   ③ 后端列表下发 hasContent、diagnostics 同口径
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

const trashPage = read('src/pages/TrashPage.tsx');
/**
 * 去掉注释后再做「不许出现 X」的断言：注释里必须能写清"为什么不能用 sizeBytes"
 * （那正是这个 bug 的可复盘部分），否则守卫会逼着后来人删掉解释。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');
const trashCode = stripComments(trashPage);
const api = read('src/api/governanceApi.ts');
const contract = read('src/api/governanceContract.ts');
const store = readRepo('src/lib/trash-store.ts');
const http = readRepo('src/lib/governance-http.ts');

test('前端：broken 判据是 hasContent === false，不是 sizeBytes', () => {
  assert.match(
    trashPage,
    /const broken = item\.kind !== 'group' && item\.hasContent === false;/,
    '「正文缺失」必须按 hasContent 判定 —— sizeBytes 是入站旧值，入站后正文丢失时会失效',
  );
  assert.ok(
    !/sizeBytes === 0/.test(trashCode),
    'TrashPage 的**代码**里不许再出现 sizeBytes === 0（这正是事件 #81 的坏判据）',
  );
});

test('前端：批量恢复用 hasContent !== false（只排除确证缺失的）', () => {
  assert.match(
    trashPage,
    /const restorable = docSelected\.filter\(\(i\) => i\.hasContent !== false\);/,
    '批量恢复必须与行内判据同口径；`=== false` 才排除，undefined（旧 daemon）按未知放行',
  );
  assert.ok(!/sizeBytes > 0/.test(trashCode), '批量恢复的代码里不许再用 sizeBytes > 0');
});

test('前端：批量恢复失败必须说出原因（不能静默吞错误）', () => {
  assert.ok(
    !/restoreTrash\([^)]*\)\s*\.catch\(\(\) => null\)/.test(trashCode),
    '批量循环里不许再用 catch(() => null) —— 服务端 fail-closed（TRASH_CORRUPTED/409）会被算成"没成功"而原因丢失',
  );
  assert.match(trashCode, /失败 \$\{failures\.length\} 篇/, '批量回执里要带上失败篇数与原因');
});

test('契约：后端与前端 DTO 都声明 hasContent?（可选，兼容旧数据）', () => {
  for (const [label, src] of [['web contract', contract], ['api view', api]]) {
    assert.match(src, /hasContent\?: boolean;/, `${label} 必须声明 hasContent?: boolean`);
  }
});

test('后端：列表按 content.md 存在性算 hasContent，且只给 doc 条目', () => {
  assert.match(store, /function hasRestorableContent\(/, '应有一个统一的正文存在性判定函数');
  assert.match(
    store,
    /if \(item\.kind === 'doc'\) item\.hasContent = hasRestorableContent\(item\.dir\);/,
    'doc 条目才有 hasContent；组条目没有单篇正文，不能参与「坏条目」判定',
  );
  assert.match(store, /probeContent !== false/, '到期清理/体积统计应能跳过读盘');
});

test('后端：diagnostics 的 emptyContent 与列表同口径', () => {
  const hits = [...http.matchAll(/hasContent === false/g)];
  assert.equal(hits.length, 2, '单库与视图两个分支都要改用 hasContent（各一处）');
  assert.ok(
    !/emptyContent[\s\S]{0,400}sizeBytes === 0/.test(http),
    'diagnostics 不许再按 sizeBytes 判正文缺失',
  );
});
