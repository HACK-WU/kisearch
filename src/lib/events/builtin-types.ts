/**
 * 内置事件类型（REQ-20261113-004 · S-02 §3.6）
 *
 * 三档可见性按阶段递进：隐藏 → 仅全文 → 语义+全文。这样「事件进行中不希望被语义搜到、
 * 但排障时又要能按关键词查」的诉求成立。
 *
 * `terminalAction` 是**类型级**字段（不挂阶段）：收口时按它决定成员文档去留。
 * demo 曾把它挂在阶段上，追加阶段就会静默丢失 —— 见 design/S02 §3.6。
 *
 * 这里的定义是「内存缺省」：`listTypes` 在 `_types.json` 不存在时返回它们，
 * 但**不落盘**（读路径不建目录）；首次写操作时才把当前视图整体写下去。
 */

import type { EventTypeRecord } from './types.js';

export const BUILTIN_EVENT_TYPE_IDS = ['et_1', 'et_2', 'et_3'] as const;

function stages(defs: Array<{ name: string; visibility: 'full' | 'fts-only' | 'hidden' }>) {
  return defs.map((d, i) => ({ key: `st_${i + 1}`, name: d.name, visibility: d.visibility }));
}

export function buildBuiltinTypes(scope: string, now = 0): EventTypeRecord[] {
  return [
    {
      id: 'et_1',
      scope,
      name: 'bug 排查',
      builtin: true,
      stages: stages([
        { name: '排查中', visibility: 'hidden' },
        { name: '已定位', visibility: 'fts-only' },
        { name: '修复中', visibility: 'fts-only' },
        { name: '已关闭', visibility: 'full' },
      ]),
      terminalAction: 'keep',
      fallbackDays: 90,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'et_2',
      scope,
      name: '性能优化',
      builtin: true,
      stages: stages([
        { name: '分析中', visibility: 'hidden' },
        { name: '优化中', visibility: 'fts-only' },
        { name: '已验证', visibility: 'fts-only' },
        { name: '已完成', visibility: 'full' },
      ]),
      terminalAction: 'trash',
      fallbackDays: 90,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'et_3',
      scope,
      name: '需求实现',
      builtin: true,
      stages: stages([
        { name: '实施中', visibility: 'hidden' },
        { name: '联调中', visibility: 'fts-only' },
        { name: '已上线', visibility: 'full' },
      ]),
      terminalAction: 'keep',
      fallbackDays: 90,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
