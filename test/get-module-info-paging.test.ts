/**
 * get-module-info 分段读取（长文档分页）单测
 *
 * 背景：内置 AI 对话对「工具返回」有字符上限，超限由序列化层按码点硬切 ——
 * JSON 被切坏且没有任何续读手段，导致长文档读不全。分页让工具自己沿**行边界**切片，
 * 返回 nextStart 供续读，从而彻底避开那刀硬切。
 *
 * 覆盖：
 *   · sliceDocWindow —— 连续分页拼接等于原文、单行超窗的字符续读、空文档、参数钳制
 *   · 不传 maxChars 时**完全不上报文段字段**（老行为逐字节兼容）
 *   · start_line 越界 fail-loud、revision 始终是整篇的
 *   · 批量：start_line 互斥报错、maxChars 按条数均分
 *   · CLI：--max-chars / --start-line 真的接上了
 *
 * 运行：npx jiti test/get-module-info-paging.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig, JITI_CLI } from './test-config.js';
import {
  sliceDocWindow,
  executeGetModuleInfoLocal,
  executeGetModuleInfoBatch,
  PAGE_MIN_CHARS,
  PAGE_MAX_CHARS,
} from '../src/get-module-info.js';
import { serializeToolResponse } from '../src/lib/chat/retrieval/tool-response.js';

// ─── 夹具 ───

const SCRIPT_PATH = path.resolve(import.meta.dirname, '..', 'src', 'get-module-info.ts');
const scope = `getmod-page-${Date.now()}`;
const group = '分页/长文档';
const relation = '超长设计文档';
/** >10000 字符（200 行 × 约 66 字符），确保一定触发旧实现的截断 */
const longDoc = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行 ` + 'x'.repeat(60)).join('\n');

function runCli(args: string[]): string {
  try {
    return execFileSync(process.execPath, [JITI_CLI, SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv(),
    });
  } catch (err: any) {
    return err.stdout ? String(err.stdout) : '';
  }
}

/** 连续分页直到 truncated:false，返回所有片段 */
async function readAllPages(maxChars: number): Promise<string[]> {
  const pages: string[] = [];
  let startLine: number | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const r = await executeGetModuleInfoLocal({
      scope,
      group,
      relation,
      maxChars,
      ...(startLine !== undefined ? { startLine } : {}),
    });
    assert.equal(r.ok, true, `分页中断：${r.ok ? '' : r.error}`);
    if (!r.ok) break;
    pages.push(r.content);
    if (!r.truncated) return pages;
    assert.ok(r.nextStart, 'truncated 必须给 nextStart');
    startLine = r.nextStart!.line;
  }
  throw new Error('分页未在上限次数内结束（疑似死循环）');
}

before(async () => {
  registerTestScope(scope);
  const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
  const { getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');

  initScope(scope);

  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<any>(cachePath)!;
  cache.groups[group] = {
    hot_relations: [
      { id: 'rel_p1', text: relation, score: 5, useCount: 1, lastUsedTime: 0, isImported: false },
      { id: 'rel_p2', text: '短文档', score: 4, useCount: 1, lastUsedTime: 0, isImported: false },
      // 批量 10 条（窗口均分 + 每条结构开销）的验证数据
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `rel_b${i}`, text: `批量文档${i}`, score: 3, useCount: 1, lastUsedTime: 0, isImported: false,
      })),
    ],
    keywords: ['分页'],
  };
  writeJson(cachePath, cache);

  const localKbPath = getLocalKbDir(scope, group);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  writeJson(localKbPath, {
    [relation]: longDoc,
    短文档: '很短的内容',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`批量文档${i}`, longDoc])),
  });
});

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

// ─── 纯函数 ───

describe('sliceDocWindow（行边界切片）', () => {
  it('连续分页拼接后与原文完全一致', () => {
    const pages: string[] = [];
    let next: { line: number; char: number } | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const s = sliceDocWindow(longDoc, { maxChars: 4000, startLine: next?.line, startChar: next?.char });
      pages.push(s.content);
      if (!s.truncated) break;
      next = s.nextStart;
    }
    assert.equal(pages.join('\n'), longDoc);
  });

  it('每段正文不超过窗口（正常路径）', () => {
    const s = sliceDocWindow(longDoc, { maxChars: 3000 });
    assert.ok(s.content.length <= 3000, `实际 ${s.content.length}`);
    assert.equal(s.startLine, 1);
    assert.equal(s.totalLines, 200);
    assert.equal(s.truncated, true);
    assert.equal(s.endLine, s.nextStart!.line - 1);
  });

  it('单行超窗退化为字符切分，且续读有进展、能拼回原行', () => {
    const oneLine = 'y'.repeat(5000);
    const a = sliceDocWindow(oneLine, { maxChars: PAGE_MIN_CHARS });
    assert.equal(a.content.length, PAGE_MIN_CHARS);
    assert.deepEqual(a.nextStart, { line: 1, char: PAGE_MIN_CHARS });
    const b = sliceDocWindow(oneLine, { maxChars: PAGE_MIN_CHARS, startLine: a.nextStart!.line, startChar: a.nextStart!.char });
    assert.equal(a.content + b.content, oneLine.slice(0, PAGE_MIN_CHARS * 2));
  });

  it('单行超窗时不劈开代理对（emoji 不被切成半个）', () => {
    // 每个 emoji 占 2 个 UTF-16 单元，窗口 501 会正好落在 emoji 中间
    const line = '😀'.repeat(1000);
    const a = sliceDocWindow(line, { maxChars: 501 });
    assert.equal(a.content.includes('\uFFFD'), false);
    assert.equal(Array.from(a.content).every((c) => c === '😀'), true, '不得出现半个代理对');
    const b = sliceDocWindow(line, { maxChars: 501, startLine: a.nextStart!.line, startChar: a.nextStart!.char });
    assert.equal(a.content + b.content, line.slice(0, 1000), '两段拼起来必须与原文逐字符一致');
  });

  it('空文档返回 1 行且不报截断', () => {
    const s = sliceDocWindow('', { maxChars: PAGE_MIN_CHARS });
    assert.deepEqual(
      { content: s.content, startLine: s.startLine, totalLines: s.totalLines, truncated: s.truncated },
      { content: '', startLine: 1, totalLines: 1, truncated: false },
    );
  });

  it('窗口越界被钳制到合法区间', () => {
    // 传 1 会被抬到 PAGE_MIN_CHARS —— 若没钳制，正文只有 1 个字符
    const tiny = sliceDocWindow(longDoc, { maxChars: 1 });
    assert.ok(tiny.content.length <= PAGE_MIN_CHARS, `不应超过最小窗口，实际 ${tiny.content.length}`);
    assert.ok(tiny.content.length > 400, `应被抬到最小窗口附近，实际 ${tiny.content.length}`);
    const huge = sliceDocWindow(longDoc, { maxChars: PAGE_MAX_CHARS * 2 });
    assert.equal(huge.truncated, false);
    assert.equal(huge.content, longDoc);
  });
});

// ─── 老行为兼容 ───

describe('不传 maxChars = 全文（老行为不变）', () => {
  it('返回全文且不带任何分段字段', async () => {
    const r = await executeGetModuleInfoLocal({ scope, group, relation });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.content, longDoc);
    for (const k of ['startLine', 'endLine', 'truncated', 'nextStart']) {
      assert.equal(k in r, false, `不应出现字段 ${k}`);
    }
  });
});

// ─── 分段读取 ───

describe('分段读取（start_line / max_chars / nextStart）', () => {
  it('能连续读全 13000+ 字符的文档，拼接等于原文', async () => {
    const pages = await readAllPages(3000);
    assert.ok(pages.length > 1, '应分成多段');
    assert.equal(pages.join('\n'), longDoc);
  });

  it('每段都带 totalLines，revision 始终等于整篇的（供 ki_edit_relation 使用）', async () => {
    const full = await executeGetModuleInfoLocal({ scope, group, relation });
    const first = await executeGetModuleInfoLocal({ scope, group, relation, maxChars: 3000 });
    assert.equal(full.ok, true);
    assert.equal(first.ok, true);
    if (!full.ok || !first.ok) return;
    assert.equal(first.revision, full.revision);
    assert.equal(first.totalLines, 200);
    assert.equal(first.startLine, 1);
  });

  it('start_line 越界 fail-loud，并回报真实行数', async () => {
    const r = await executeGetModuleInfoLocal({ scope, group, relation, maxChars: 3000, startLine: 9999 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /9999/);
    assert.match(r.hint ?? '', /200/);
  });

  it('只给 start_line 不给 max_chars：报错而不是静默返回全文', async () => {
    for (const extra of [{ startLine: 3 }, { startChar: 5 }]) {
      const r = await executeGetModuleInfoLocal({ scope, group, relation, ...extra });
      assert.equal(r.ok, false, `start_line/start_char 单独出现（${JSON.stringify(extra)}）时必须报错`);
      if (r.ok) continue;
      assert.match(r.error, /max_chars/);
      assert.match(r.hint ?? '', /max_chars/);
    }
  });

  it('从中间行开始读：content 是原文的连续子串', async () => {
    const r = await executeGetModuleInfoLocal({ scope, group, relation, maxChars: 2000, startLine: 51 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.startLine, 51);
    assert.ok(longDoc.includes(r.content), '分段正文必须是原文的连续子串');
  });
});

// ─── 批量 ───

describe('批量查询与分页参数的互斥/均分', () => {
  it('relations 与 start_line / start_char 同时传 → 报错并指路单条', async () => {
    for (const extra of [{ startLine: 2 }, { startChar: 4 }]) {
      const r = await executeGetModuleInfoBatch({ scope, group, relations: [relation], ...extra });
      assert.equal(r.ok, false, `${JSON.stringify(extra)} 应被拒绝`);
      if (r.ok) continue;
      assert.match(r.error, /start_line/);
      assert.match(r.hint ?? '', /单条/);
    }
  });

  it('maxChars 按条数均分并扣掉每条结构开销，且每条带 totalLines', async () => {
    const r = await executeGetModuleInfoBatch({ scope, group, relations: [relation, '短文档'], maxChars: 6000 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.succeeded, 2);
    const long = r.results.find((x) => x.relation === relation)!;
    const short = r.results.find((x) => x.relation === '短文档')!;
    assert.ok(long.truncated, '长文档在均分窗口下应被截断');
    // 6000 ÷ 2 = 3000，再扣 300 结构开销 ⇒ 2700
    assert.ok(long.content!.length <= 2700, `实际 ${long.content!.length}`);
    assert.equal(long.totalLines, 200);
    assert.equal(short.truncated, false);
    assert.equal(short.content, '很短的内容');
  });

  it('10 条批量在对话预算下序列化后仍不超 10000、不触发硬切', async () => {
    // 与 chat 真实注入一致：窗口 = 预算的 75%
    const BUDGET = 10000;
    const maxChars = Math.floor(BUDGET * 0.75);
    const names = Array.from({ length: 10 }, (_, i) => `批量文档${i}`);
    const r = await executeGetModuleInfoBatch({ scope, group, relations: names, maxChars });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.succeeded, 10);
    const ser = serializeToolResponse(r, BUDGET, 'ki_get_module_info');
    assert.equal(ser.truncated, false, `10 条批量被硬切了（序列化 ${ser.originalChars} 字符 > ${BUDGET}）`);
  });
});

// ─── CLI 接线 ───

describe('CLI 选项接线', () => {
  it('不带 --max-chars 时输出全文', () => {
    const out = runCli(['--scope', scope, '--group', group, '--relation', relation]);
    assert.ok(out.includes('第 200 行'), '全文应包含末行');
  });

  it('--max-chars + --start-line 生效（选项名到参数名的映射没接错）', () => {
    const out = runCli(['--scope', scope, '--group', group, '--relation', relation, '--max-chars', '1000', '--start-line', '101']);
    assert.ok(out.includes('[scope:'), '应正常输出');
    assert.ok(out.includes('第 101 行'), '应从指定行开始');
    assert.equal(out.includes('第 200 行'), false, '应只返回一段');
  });
});
