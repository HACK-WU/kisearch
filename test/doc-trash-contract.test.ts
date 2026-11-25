/**
 * doc-trash-contract.test.ts —— `/api/doc/get` 404 的 `trash` 字段前后端契约守卫（2026-11-25）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/doc-trash-contract.test.ts
 *
 * 为什么需要：后端这份 payload 是**手写对象**（没有 DTO 类可被类型系统共享），前端
 * `web/src/api/httpApi.ts` 里另有一份同名 interface。两边靠人肉同步 —— 加字段忘了改
 * 另一边，前端就静默少一个字段（事件 #99 就是同一类漂移：`scopesUsed` 只改了服务层
 * 与前端副本，漏了 DTO）。这里用纯静态比对把漂移变成红灯，不依赖磁盘与网络。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

/** 抓出 `export interface <name> { ... }` 体内的字段名与可选标记（不支持嵌套，本用例无需） */
function parseInterfaceFields(source: string, name: string): Array<{ field: string; optional: boolean }> {
  const header = `export interface ${name} {`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `未找到 ${name} 定义（改名了？同步更新本测试）`);
  const body = source.slice(start + header.length);
  const end = body.indexOf('\n}');
  assert.notEqual(end, -1, `${name} 定义缺少收尾的 }`);

  const out: Array<{ field: string; optional: boolean }> = [];
  for (const rawLine of body.slice(0, end).split('\n')) {
    const line = rawLine.trim();
    // 跳过注释与空行（interface 内字段都有 JSDoc，不能把它们当字段）
    if (!line || line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue;
    const m = /^(\w+)(\?)?:/.exec(line);
    if (m) out.push({ field: m[1], optional: m[2] === '?' });
  }
  return out;
}

/**
 * 抓 `reason:` 的类型字面量。
 *
 * 后端 `reason` 的类型是别名 `TrashReason`（字面量定义在 `trash-store.ts`），
 * 前端是内联联合 —— 所以两边解析入口不同，比对的是**值域**而不是写法。
 */
function parseReasonLiterals(source: string, name: string): string[] {
  const header = `export interface ${name} {`;
  const start = source.indexOf(header);
  const body = source.slice(start, source.indexOf('\n}', start));
  const line = body.split('\n').find((l) => /^\s*reason\??:/.test(l));
  assert.ok(line, `${name} 缺少 reason 字段`);
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** 后端的值域真源：`export type TrashReason = 'manual' | …` */
function parseTrashReasonUnion(source: string): string[] {
  const start = source.indexOf('export type TrashReason');
  assert.notEqual(start, -1, 'trash-store.ts 里找不到 TrashReason 定义（改名了？同步更新本测试）');
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('DocTrashHit 前后端字段一致', () => {
  const backendSrc = read('src/lib/doc-trash-hint.ts');
  const frontendSrc = read('web/src/api/httpApi.ts');

  it('字段集（含可选标记）完全一致', () => {
    const backend = parseInterfaceFields(backendSrc, 'DocTrashHit');
    const frontend = parseInterfaceFields(frontendSrc, 'DocTrashHit');
    const normalize = (rows: Array<{ field: string; optional: boolean }>): string[] =>
      rows.map((r) => `${r.field}${r.optional ? '?' : ''}`).sort();

    assert.ok(backend.length > 0, '后端 DocTrashHit 应该有字段');
    assert.deepEqual(
      normalize(frontend),
      normalize(backend),
      '前端 web/src/api/httpApi.ts 的 DocTrashHit 与后端 doc-trash-hint.ts 不一致（加/删字段必须两边同步）',
    );
  });

  it('reason 值域一致（少一个值前端就会类型不符）', () => {
    assert.deepEqual(
      parseReasonLiterals(frontendSrc, 'DocTrashHit'),
      parseTrashReasonUnion(read('src/lib/trash-store.ts')),
    );
  });

  it('前端 DocContentResponse 暴露 code 与 trash（否则抽屉拿不到判据）', () => {
    const fields = parseInterfaceFields(frontendSrc, 'DocContentResponse').map((f) => f.field);
    assert.ok(fields.includes('code'), 'DocContentResponse 缺 code');
    assert.ok(fields.includes('trash'), 'DocContentResponse 缺 trash');
  });
});