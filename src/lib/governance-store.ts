/**
 * 知识治理 · scope 级配置存储（B0 冻结形状）
 *
 * 落点：`{dataDir}/{scope}/governance.json`
 *   - 为什么不塞 `group-index.json`：它的 `groups` 是嵌套字典，**键即子组名**，
 *     塞属性键（如 defaultLifecycle）会被当成一个子组，`query-group` 会列出来；
 *   - 为什么不塞 `relations-cache`：那是文档元数据，与 scope 配置生命周期不同；
 *   - 落 scope 目录内 ⇒ 自动进 `ki backup` 快照（Q2 归零）。
 *
 * fail-loud 口径（S-01 §3.6）：
 *   - 文件不存在 ⇒ 返回内存缺省，**不自动创建文件**；
 *   - 文件存在但损坏 ⇒ 抛 `CORRUPT_JSON`（readJson 已抛），不静默回落缺省 ——
 *     否则回收站期限会"莫名变回 7 天"，用户永远查不出原因。
 */

import path from 'path';
import { getKbDir, validateScope } from './scope.js';
import { readJson, writeJson } from './store.js';

export type TrashKeepDays = 3 | 7 | 14 | 30;
export type TrashExpireAction = 'purge' | 'notify';

export interface TrashSettings {
  keepDays: TrashKeepDays;
  expireAction: TrashExpireAction;
}

export interface LifecyclePreset {
  id: string;
  /** scope 内唯一，用户命名 */
  name: string;
  kind: 'wiki' | 'temp';
  /** kind=temp 必填（1~365） */
  ttlDays?: number;
  /** 内置 3 项不可删、可改期限 */
  builtin?: boolean;
}

export interface GroupDefaultLifecycle {
  kind: 'wiki' | 'temp';
  ttlDays?: number;
}

export interface GovernanceConfig {
  version: 1;
  scope: string;
  lifecyclePresets: LifecyclePreset[];
  groupDefaults: Record<string, GroupDefaultLifecycle>;
  trash: TrashSettings;
  updatedAt: string;
}

export const TRASH_KEEP_DAYS: readonly TrashKeepDays[] = [3, 7, 14, 30];
export const DEFAULT_TRASH_SETTINGS: TrashSettings = { keepDays: 7, expireAction: 'purge' };

/** 内置预设：不可删（改期限可以）；用固定 id 便于幂等合并 */
export const BUILTIN_PRESETS: readonly LifecyclePreset[] = [
  { id: 'preset_builtin_wiki', name: '长期保留', kind: 'wiki', builtin: true },
  { id: 'preset_builtin_temp7', name: '临时 7 天', kind: 'temp', ttlDays: 7, builtin: true },
  { id: 'preset_builtin_temp30', name: '临时 30 天', kind: 'temp', ttlDays: 30, builtin: true },
];

export function getGovernancePath(scope: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), 'governance.json');
}

function defaultConfig(scope: string): GovernanceConfig {
  return {
    version: 1,
    scope,
    lifecyclePresets: BUILTIN_PRESETS.map((p) => ({ ...p })),
    groupDefaults: {},
    trash: { ...DEFAULT_TRASH_SETTINGS },
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * 读取 scope 治理配置。
 *
 * 文件不存在返回缺省（不落盘）。文件存在时把缺失的内置预设补齐到内存视图，
 * 避免旧文件缺项导致 UI 少一个预设 —— 但**不回写**，回写发生在下一次显式写操作。
 */
export function readGovernance(scope: string): GovernanceConfig {
  const raw = readJson<Partial<GovernanceConfig>>(getGovernancePath(scope));
  if (!raw) return defaultConfig(scope);

  const presets = Array.isArray(raw.lifecyclePresets) ? raw.lifecyclePresets : [];
  const merged = [...presets];
  for (const builtin of BUILTIN_PRESETS) {
    if (!merged.some((p) => p.id === builtin.id)) merged.push({ ...builtin });
  }

  return {
    version: 1,
    scope,
    lifecyclePresets: merged,
    groupDefaults: raw.groupDefaults ?? {},
    trash: normalizeTrashSettings(raw.trash),
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
  };
}

/** 设置项归一：非法值不静默纠正到"看起来合理"，而是回落到默认并在返回体里可见（由调用方给提示） */
function normalizeTrashSettings(input?: Partial<TrashSettings>): TrashSettings {
  const keepDays = TRASH_KEEP_DAYS.includes(input?.keepDays as TrashKeepDays)
    ? (input!.keepDays as TrashKeepDays)
    : DEFAULT_TRASH_SETTINGS.keepDays;
  const expireAction: TrashExpireAction = input?.expireAction === 'notify' ? 'notify' : 'purge';
  return { keepDays, expireAction };
}

/**
 * 预设档位校验：只允许 wiki / temp。
 *
 * `event` 不能做预设——它必须落到**具体事件**上，预设表达不了绑哪个事件；
 * 放行会写出一份无法应用的预设（`LifecyclePreset.kind` 本就不含该值）。
 */
export function validatePresetKind(kind: unknown): { ok: true; kind: 'wiki' | 'temp' } | { ok: false; message: string } {
  if (kind === 'wiki' || kind === 'temp') return { ok: true, kind };
  return {
    ok: false,
    message: `分类预设的档位只能是 wiki / temp，收到「${String(kind)}」（跟随事件请在文档行内绑定具体事件）`,
  };
}

export function validateTrashSettings(input: Partial<TrashSettings>): { ok: true; value: TrashSettings } | { ok: false; message: string } {
  if (input.keepDays !== undefined && !TRASH_KEEP_DAYS.includes(input.keepDays)) {
    return { ok: false, message: `保留天数只能是 ${TRASH_KEEP_DAYS.join(' / ')}，收到「${String(input.keepDays)}」` };
  }
  if (input.expireAction !== undefined && input.expireAction !== 'purge' && input.expireAction !== 'notify') {
    return { ok: false, message: `到期处理只能是 purge / notify，收到「${String(input.expireAction)}」` };
  }
  return { ok: true, value: normalizeTrashSettings(input) };
}

/**
 * 写回配置（调用方必须已持 scope 写锁）。
 *
 * `writeJson` 走 WAL 原子写，并会补 `updatedAt`；这里显式再写一次是为了让
 * 内存对象与磁盘值一致（writeJson 写的是 enriched 副本，不回写入参）。
 */
export function writeGovernance(scope: string, config: GovernanceConfig): GovernanceConfig {
  const now = new Date().toISOString();
  const next: GovernanceConfig = { ...config, version: 1, scope, updatedAt: now };
  writeJson(getGovernancePath(scope), next as unknown as Record<string, unknown>);
  return next;
}

/** group 默认分类（精确路径匹配；未配 → 无） */
export function getGroupDefault(config: GovernanceConfig, group: string): GroupDefaultLifecycle | null {
  return config.groupDefaults[group] ?? null;
}
