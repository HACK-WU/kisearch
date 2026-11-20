/**
 * governance-contract-live.test.ts —— 契约「活体」对账（2026-11-20）
 *
 * 为什么需要它：`governance-contract.test.ts` ① 只比对**两份契约副本**之间的字段名，
 * 实现层不在输入集内 —— 于是「契约与真实响应不是同一形状」它一个字都发现不了
 * （实测：列表接口 13 个声明里 3 个幽灵、真实响应 18 个键里 9 个未声明，该用例依然全绿）。
 *
 * 本文件补的是那条缺失的边：
 *   ① 契约文件**必须被实现层 import**（根因守卫：退回「手工平行描述」立即红）；
 *   ② 列表响应的**真实键集**与契约字段集双向一致（幽灵 / 未声明都要红）；
 *   ③ `EventRecord` 的每个字段都进响应（逐字段改造后不再有 spread 兜底，防静默丢字段）；
 *   ④ 组装点**不得把返回类型放宽**为 `Record<string, unknown>`（编译期约束的唯一支点）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-contract-live.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { toEventListView } from '../src/lib/events/event-view.js';
import type { EventListItemView } from '../src/lib/events/event-service.js';

const ROOT = process.cwd();
const CONTRACT_REL = 'src/lib/governance-contract.ts';

/** 递归列出 `src` 下的 .ts 文件（跳过 zvec-engine 的生成物与 node_modules） */
function listSrcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      listSrcFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 提取 `export interface X { ... }` 的字段名（含 `?` 标记），忽略行内嵌套对象 */
function parseInterfaces(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /export interface\s+(\w+)(?:<[^>]*>)?\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const fields: string[] = [];
    for (const line of m[2].split('\n')) {
      const fm = line.match(/^\s{2}(\w+)(\?)?:/);
      if (fm) fields.push(fm[2] ? `${fm[1]}?` : fm[1]);
    }
    out.set(m[1], fields);
  }
  return out;
}

const contractSrc = fs.readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');
const contract = parseInterfaces(contractSrc);

describe('① 契约必须与实现耦合（根因守卫）', () => {
  it('`governance-contract.ts` 至少被 2 个实现文件 import', () => {
    const importers: string[] = [];
    for (const file of listSrcFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (rel === CONTRACT_REL) continue;
      const src = fs.readFileSync(file, 'utf8');
      // 只认真正的 import 语句，注释里提到路径不算
      if (/^\s*import\s[\s\S]*?from\s+['"][^'"]*governance-contract(?:\.js)?['"]/m.test(src)) {
        importers.push(rel);
      }
    }
    assert.ok(
      importers.length >= 2,
      `契约必须被实现层 import（否则又退回手工平行描述）。当前 import 方：${importers.join(', ') || '无'}`,
    );
  });
});

describe('② 列表响应键集与契约双向一致', () => {
  /** 一份最小的服务层列表项（不依赖真实 kb 数据）；可选字段也填上，供④校验透传完整性 */
  const sample: EventListItemView = {
    event: {
      id: 'evt_test',
      shortId: 1,
      scope: 'kb',
      title: 'T',
      description: 'D',
      typeId: 'et_1',
      stageKey: 'st_1',
      stageIndex: 0,
      closedAt: null,
      pinnedAt: 5,
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    type: null,
    stage: { key: 'st_1', name: '排查中', index: 0, visibility: 'hidden' },
    members: [{ group: 'g', name: 'n', relation: {} as never }],
    memberTotal: 1,
    visibilitySummary: { full: 0, ftsOnly: 0, hidden: 1 },
  };

  const view = toEventListView(sample, 'kb') as Record<string, unknown>;
  const actualKeys = Object.keys(view);
  const declared = contract.get('EventListItem');
  const required = (declared ?? []).filter((f) => !f.endsWith('?')).map((f) => f.replace(/\?$/, ''));
  const optional = (declared ?? []).filter((f) => f.endsWith('?')).map((f) => f.replace(/\?$/, ''));

  it('契约里声明了 EventListItem', () => {
    assert.ok(declared && declared.length > 0, '契约缺少 EventListItem');
  });

  it('响应里没有契约未声明的字段（防幽灵）', () => {
    const extra = actualKeys.filter((k) => !required.includes(k) && !optional.includes(k));
    assert.deepEqual(extra, [], `以下字段真实返回但契约未声明：${extra.join(', ')}`);
  });

  it('契约的必填字段都在响应里（防漏产）', () => {
    const missing = required.filter((k) => !actualKeys.includes(k));
    assert.deepEqual(missing, [], `以下契约必填字段在响应里缺失：${missing.join(', ')}`);
  });
});

describe('③ EventRecord 字段必须全部进入列表响应', () => {
  /*
   * 为什么需要：`toEventListView` 从 `...item.event` 展开改成了逐字段显式列出。
   * 好处是幽灵字段能被 tsc 抓到，代价是 **`EventRecord` 以后新增字段不会自动进响应**
   * （返回类型是 EventListItem 而非 EventRecord，tsc 不会报）。
   * 这条用例就是那个代价的守卫：记录类型上的字段必须在真实响应里出现。
   */
  const recordFields = parseInterfaces(
    fs.readFileSync(path.join(ROOT, 'src/lib/events/types.ts'), 'utf8'),
  ).get('EventRecord') ?? [];
  const view = toEventListView({
    event: {
      id: 'evt_test', shortId: 1, scope: 'kb', title: 'T', description: 'D',
      typeId: 'et_1', stageKey: 'st_1', stageIndex: 0, closedAt: null, pinnedAt: 5,
      revision: 1, createdAt: 1, updatedAt: 2,
    },
    type: null,
    stage: { key: 'st_1', name: '排查中', index: 0, visibility: 'hidden' },
    members: [],
    memberTotal: 0,
    visibilitySummary: { full: 0, ftsOnly: 0, hidden: 0 },
  }, 'kb') as Record<string, unknown>;

  it('解析到 EventRecord 且字段数 > 5', () => {
    assert.ok(recordFields.length > 5, `EventRecord 解析异常：${recordFields.join(', ')}`);
  });

  it('每个 EventRecord 字段都出现在响应里', () => {
    const missing = recordFields
      .map((f) => f.replace(/\?$/, ''))
      .filter((f) => !(f in view));
    assert.deepEqual(missing, [], `以下记录层字段被逐字段改造漏掉了：${missing.join(', ')}`);
  });
});

describe('④ 组装点不得放宽返回类型', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/events/event-view.ts'), 'utf8');

  it('`toEventListView` 返回类型必须是契约 DTO', () => {
    assert.match(
      src,
      /export function toEventListView\([^)]*\): EventListItem\s*\{/,
      '返回类型被放宽（或改了签名）：契约约束会失效',
    );
  });

  it('不允许用 `...` 展开记录结构（会抑制多余属性检查）', () => {
    // 只看代码行（行首缩进后直接是 ...），注释里提到它不算
    assert.ok(
      !/^\s*\.\.\.item\.event/m.test(src),
      '展开写法会吞掉幽灵字段检测，必须逐字段显式列出',
    );
  });
});
