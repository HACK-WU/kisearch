/**
 * filter/compiler.ts —— 结构化 Filter → zvec 类 SQL 字符串编译器
 *
 * 与设计文档对齐：S-02 §3 / §4a
 *
 * 规则：
 *   - 字段名白名单（仅 schema 已声明的 scalarFields + fts.field）
 *   - 字符串值单引号包裹，内部 ' → \'
 *   - 数字/布尔原样输出
 *   - and/or/not 递归编译，括号保证优先级
 *   - 嵌套深度上限 32，防 DoS
 *   - 空 and/or 数组、null/undefined/NaN 值 → InvalidFilterError
 *   - v1 不支持 {raw} 逃生口、不支持 IN
 */

import { InvalidFilterError } from '../errors.js';
import type { Filter, ScalarFieldDef, ScalarValue } from '../types.js';

const MAX_DEPTH = 32;

export function buildAllowedFields(
  scalarFields: ScalarFieldDef[],
  ftsField?: string,
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const f of scalarFields) set.add(f.name);
  if (ftsField) set.add(ftsField);
  return set;
}

export function compileFilter(
  filter: Filter,
  allowedFields: ReadonlySet<string>,
): string {
  return compileNode(filter, allowedFields, 0);
}

function compileNode(
  node: Filter,
  allowedFields: ReadonlySet<string>,
  depth: number,
): string {
  if (depth > MAX_DEPTH) {
    throw new InvalidFilterError(`filter nesting too deep (> ${MAX_DEPTH})`);
  }

  if ('and' in node) {
    if (node.and.length === 0) {
      throw new InvalidFilterError('and requires at least 1 clause');
    }
    const parts = node.and.map((c) => `(${compileNode(c, allowedFields, depth + 1)})`);
    return parts.join(' AND ');
  }

  if ('or' in node) {
    if (node.or.length === 0) {
      throw new InvalidFilterError('or requires at least 1 clause');
    }
    const parts = node.or.map((c) => `(${compileNode(c, allowedFields, depth + 1)})`);
    return parts.join(' OR ');
  }

  if ('not' in node) {
    return `NOT (${compileNode(node.not, allowedFields, depth + 1)})`;
  }

  // 叶子比较节点
  const { field, op, value } = node;
  if (!allowedFields.has(field)) {
    throw new InvalidFilterError(
      `field "${field}" not declared in scalarFields`,
      { data: { field } },
    );
  }
  validateValue(value, field);
  const sqlOp = op === '==' ? '=' : op;
  return `${field} ${sqlOp} ${renderValue(value)}`;
}

function validateValue(value: ScalarValue, field: string): void {
  if (value === null || value === undefined) {
    throw new InvalidFilterError(`filter value for field "${field}" is null/undefined`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new InvalidFilterError(`filter value for field "${field}" is NaN/Infinity`);
  }
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') {
    throw new InvalidFilterError(
      `filter value for field "${field}" has unsupported type: ${t}`,
    );
  }
}

function renderValue(value: ScalarValue): string {
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (typeof value === 'number') return String(value);
  return value ? 'true' : 'false';
}
