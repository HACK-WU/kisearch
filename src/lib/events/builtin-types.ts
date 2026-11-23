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

/*
 * 曾导出 `BUILTIN_EVENT_TYPE_IDS = ['et_1','et_2','et_3']` 作为「内置」的兜底判据。
 * 2026-11-23（S-02）移除：它按固定 id 判内置，会误伤其他库里恰好占用同 id 的自定义类型；
 * 认领后 `builtin: true` 由 `mergeBuiltinTypes` 保证，不需要这份名单。
 */

function stages(defs: Array<{ name: string; visibility: 'full' | 'fts-only' | 'hidden' }>) {
  return defs.map((d, i) => ({ key: `st_${i + 1}`, name: d.name, visibility: d.visibility }));
}

export function buildBuiltinTypes(scope: string, now = 0): EventTypeRecord[] {
  return [
    {
      id: 'et_1',
      scope,
      name: 'bug 排查',
      description: '功能不符合预期、报错、数据不对；查清根因并修复的过程。',
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
      description: '慢、占内存、CPU 高、容量或索引膨胀；有量化目标与验证的优化过程。',
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
      description: '缺功能、要改造、要新增入口；从动手到上线的实现过程。',
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
    /*
     * 技术债（REQ-20261123-007）。比另外三条多一步「已排期」：
     * 债的典型困境是「登记了没人动」，只有把「已认账排进计划」与「正在还」分开，
     * 看板才能回答「下个迭代还哪几笔」。终态沿 `keep`：还完的复盘值得长期可检索。
     *
     * 注意：已落盘的库看不到这条定义（内置只在文件缺失时生效），需跑
     * `ki event-types migrate` 把存量两阶段类型中间插入成四阶段。
     */
    {
      id: 'et_4',
      scope,
      name: '技术债',
      description: '长期不还、越滚越大的实现欠账（兜底未实现、声明未消费、依赖过期）；从登记、排期到偿还的过程。',
      builtin: true,
      stages: stages([
        { name: '待处理', visibility: 'hidden' },
        { name: '已排期', visibility: 'fts-only' },
        { name: '偿还中', visibility: 'fts-only' },
        { name: '已收敛', visibility: 'full' },
      ]),
      terminalAction: 'keep',
      fallbackDays: 90,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
