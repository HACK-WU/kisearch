/**
 * group-vector-contract.test.ts —— 删组清扫所依赖的向量层契约
 *
 * 背景（REQ-20261019-005 跟进项）：
 *   `ki group delete` 靠「按 group 标量字段枚举 ki-relation / ki-path」清扫辅助向量。
 *   该能力依赖三件事，任一处被改动都会让清扫**静默枚举为空**（`auxFound: 0`
 *   看起来像"无残留"）：
 *     ① 集合 schema 里 `group` 字段存在且 `indexed: true`；
 *     ② filter 编译器允许该字段并正确转义（中文 / 单引号）；
 *     ③ 实际使用的 and/or 嵌套条件能编译成合法 SQL。
 *
 * 本用例只做静态契约断言（不启引擎）；真引擎行为另有
 * `test/zvec-engine-engine.test.mjs` 的 `TC-GROUP-01` 覆盖。
 *
 * 运行：npx jiti test/group-vector-contract.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTION_SCALAR_FIELDS } from '../src/lib/vector-client.js';
import { compileFilter, buildAllowedFields } from '../dist/zvec-engine/filter/compiler.js';

type ScalarField = { name: string; dataType: string; indexed?: boolean };
const fields = COLLECTION_SCALAR_FIELDS as unknown as ScalarField[];
const allowed = buildAllowedFields(
  fields as Parameters<typeof buildAllowedFields>[0],
  'content',
);

describe('删组清扫依赖的向量层契约', () => {
  it('C1：schema 声明了 group 且建索引', () => {
    const group = fields.find((f) => f.name === 'group');
    assert.ok(group, 'schema 必须包含 group 字段（否则按 group 枚举会抛 InvalidFilterError）');
    assert.equal(group!.indexed, true, 'group 必须 indexed，否则过滤退化为全扫描或被拒绝');
  });

  it('C2：tag / scope 同样可用（清扫的另外两个条件）', () => {
    for (const name of ['tag', 'scope']) {
      assert.ok(allowed.has(name), `${name} 必须在 filter 白名单内`);
    }
  });

  it('C3：中文组名编译为等值条件', () => {
    const sql = compileFilter(
      { field: 'group', op: '==', value: 'langchain/stages/1-入门与模型层' },
      allowed,
    );
    assert.equal(sql, "group = 'langchain/stages/1-入门与模型层'");
  });

  it('C4：含单引号的组名被转义，不会截断 filter', () => {
    const sql = compileFilter({ field: 'group', op: '==', value: "it's 组" }, allowed);
    assert.equal(sql, "group = 'it\\'s 组'");
    // 未被转义的引号必须恰好 2 个（一对包裹），否则值会截断条件
    const bare = (sql.match(/(?<!\\)'/g) ?? []).length;
    assert.equal(bare, 2, `未被转义的引号应恰好 2 个：${sql}`);
  });

  it('C5：清扫实际使用的 and(scope, or(tag), or(group)) 结构可编译', () => {
    const sql = compileFilter(
      {
        and: [
          { field: 'scope', op: '==', value: 's1' },
          { or: [
            { field: 'tag', op: '==', value: 'ki-relation' },
            { field: 'tag', op: '==', value: 'ki-path' },
          ] },
          { or: [
            { field: 'group', op: '==', value: 'g1' },
            { field: 'group', op: '==', value: 'g2' },
          ] },
        ],
      },
      allowed,
    );
    assert.equal(
      sql,
      "(scope = 's1') AND ((tag = 'ki-relation') OR (tag = 'ki-path')) AND ((group = 'g1') OR (group = 'g2'))",
    );
  });

  it('C6：未声明字段必须抛错（fail-loud，不静默返回空）', () => {
    assert.throws(
      () => compileFilter({ field: 'not_a_field', op: '==', value: 'x' }, allowed),
      /not declared in scalarFields/,
    );
  });
});
