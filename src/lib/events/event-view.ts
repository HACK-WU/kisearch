/**
 * 事件列表项的**响应形状**组装（`GET /governance/events` 单库与视图合并共用）
 *
 * 为什么单独成文件：这是「实现层的记录结构 → 对外 DTO」唯一转换点。
 * 返回类型**显式标成契约 DTO**（`governance-contract.ts` 的 `EventListItem`），
 * 于是任何一侧改动都会让 `tsc` 立刻报错 —— 契约与实现从此有机械约束，
 * 不再依赖人工同步两份副本（2026-11-20 修「契约无人 import」根因）。
 *
 * 注意：不要为了迁就历史契约而放宽返回类型（如 `Record<string, unknown>`），
 * 那会把这条唯一的约束通道重新掐断。
 */

import type { EventListItem } from '../governance-contract.js';
import type { EventListItemView } from './event-service.js';

/**
 * 把服务层的列表项转成对外响应体。
 *
 * **必须逐字段显式列出，不能用 `...item.event` 展开**：展开会抑制 TypeScript 的
 * 多余属性检查（excess property check），契约里多出的幽灵字段、实现里漏声明的字段
 * 都会被静静吞掉 —— 2026-11-20 实测：用展开写法时 tsc 只报出 1 处差异，
 * 逐字段后报出全部 12 处。这条函数是契约约束的唯一支点，不要为省事退回展开。
 *
 * @param item 服务层列表项（含记录、类型、阶段、成员）
 * @param scopeOf 事件所属库（视图下是成员库名，不是视图名）
 */
export function toEventListView(item: EventListItemView, scopeOf: string): EventListItem {
  const e = item.event;
  return {
    id: e.id,
    shortId: e.shortId,
    // 事件所属库：详情 / refs / analysis 都靠它定位（视图名不是库）
    scope: scopeOf,
    title: e.title,
    description: e.description,
    // 无条件列出（即使 undefined）：契约守卫测试按 `f in view` 判「记录字段有没有进响应」，
    // 用 `...(e.expectedEffect ? ... : {})` 条件展开会让无值场景判定为「漏产」而变红。
    expectedEffect: e.expectedEffect,
    typeId: e.typeId,
    typeName: item.type?.name ?? null,
    stageKey: e.stageKey,
    stageIndex: e.stageIndex,
    closedAt: e.closedAt,
    pinnedAt: e.pinnedAt,
    revision: e.revision,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    stage: item.stage,
    memberTotal: item.memberTotal,
    docsPreview: item.members.map((m) => ({ group: m.group, name: m.name })),
    visibilitySummary: item.visibilitySummary,
  };
}
