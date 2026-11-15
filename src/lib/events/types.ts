/**
 * 事件与事件类型 · 实体类型（S-02 契约层）
 *
 * 本文件在 B0 期只含**类型**，无任何实现；B3 起由 `events/store.ts` 等落地。
 *
 * 关键约束（改任何字段前先读 design/S02）：
 *   - 事件位置存 `stageKey`（稳定），`stageIndex` 只是展示冗余；
 *   - `closedAt` 是收口唯一权威，**不能**用「是否停在末位」推导；
 *   - `terminalAction` 是**类型级**字段，不挂阶段。
 */

/** 检索可见性三档；不是布尔 —— 只关 dense 时 FTS 仍会命中 */
export type Visibility = 'full' | 'fts-only' | 'hidden';

export interface EventStage {
  /** 稳定标识（`st_1`…）：拖动排序 / 改名都不改它 */
  key: string;
  /** 可改 */
  name: string;
  /** 首次名称，改名后保留用于历史展示兜底（Q6） */
  originalName?: string;
  visibility: Visibility;
  /** 停用：不可进入；**末位不可停用**（否则事件永远收不了口） */
  disabled?: boolean;
}

export interface EventTypeRecord {
  id: string;
  scope: string;
  name: string;
  builtin: boolean;
  /** 有序；末位 = 终态 */
  stages: EventStage[];
  /** 类型级终态动作：收口时关联文档去留 */
  terminalAction: 'keep' | 'trash';
  /** 未收口兜底天数（默认 90，null 关闭） */
  fallbackDays: number | null;
  /** 乐观锁（N12：两个标签页同时编辑） */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface EventRecord {
  id: string;
  /** 展示编号 `#3`；per-scope 单调递增，**删除后不复用** */
  shortId: number;
  scope: string;
  title: string;
  typeId: string;
  stageKey: string;
  /** 展示冗余：读时按 stageKey 反查重算，不在写入侧当作依据 */
  stageIndex: number;
  /** 收口唯一权威；非空即已收口 */
  closedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface EventStageLog {
  eventId: string;
  /** null = 创建事件 */
  fromKey: string | null;
  toKey: string;
  at: number;
  by: 'user' | 'ai';
  note?: string;
  /** 状态写失败时记 aborted（仅诊断用） */
  status?: 'committed' | 'aborted';
}

/** `_types.json` */
export interface EventTypesDoc {
  version: 1;
  revision: number;
  types: EventTypeRecord[];
}

/** `_meta.json` */
export interface EventsMeta {
  version: 1;
  nextShortId: number;
}

/**
 * 参考文档（S-05）。
 *
 * 与「关联文档」的区别：关联文档靠 `Relation.eventId` 指向事件，可见性随阶段变；
 * 参考文档只是**一条引用记录**，可见性取被引文档自身，加入/移除**不修改被引文档任何字段**
 * （A13 红线：操作前后该 Relation 的分片条目必须字节级不变）。
 */
export interface EventRefDoc {
  scope: string;
  group: string;
  name: string;
  addedBy: 'ai' | 'manual';
  addedAt: number;
  /** ai 加入时记录当时分数，便于复现"为什么它被选中" */
  score?: number;
}

/** `{eventId}.refs.json` */
export interface RefsDoc {
  version: 1;
  eventId: string;
  refs: EventRefDoc[];
  updatedAt: number;
}
