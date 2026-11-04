/**
 * DatasourceMappingsEditor.tsx —— 「仓库子目录 → 落点 Group」映射表（REQ-20261104-002）
 *
 * 添加弹窗与编辑弹窗共用一个组件：两处若各写一份，增删规则（至少 1 条 / 最多 20 条）
 * 与校验文案必然漂移。
 *
 * 语义：
 *  - 子目录留空 = 仓库根；Group 留空 = 按该子目录内的顶层目录自动命名；
 *  - 至少 1 条：只剩 1 条时删除按钮禁用（不是隐藏 —— 隐藏会让人以为功能没做）；
 *  - 校验错误由父组件算好传入（`validateMappingRows`），这里只负责高亮对应行。
 */
import { GroupPathSelect } from '@/components/GroupPathSelect';
import {
  MAX_MAPPINGS,
  emptyRow,
  subdirLabel,
  type MappingRow,
  type MappingValidationError,
} from '@/lib/datasourceMappings';

export interface DatasourceMappingsEditorProps {
  /** 目标 scope（Group 下拉的数据来源）；未确认 scope 时传空串 → 下拉禁用 */
  scope: string;
  rows: MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  disabled?: boolean;
  error?: MappingValidationError | null;
  /** 校验通过时的补充说明（如「保存后下次同步生效」） */
  hint?: string;
  /** 元素 id 前缀，避免两个弹窗同屏时 id 冲突 */
  idPrefix: string;
}

const GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
  gap: 8,
  alignItems: 'start',
};

export function DatasourceMappingsEditor({
  scope,
  rows,
  onChange,
  disabled = false,
  error,
  hint,
  idPrefix,
}: DatasourceMappingsEditorProps): JSX.Element {
  const canRemove = rows.length > 1 && !disabled;
  const canAdd = rows.length < MAX_MAPPINGS && !disabled;

  const patchRow = (index: number, next: Partial<MappingRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  };
  const removeRow = (index: number): void => {
    if (!canRemove) return;
    onChange(rows.filter((_, i) => i !== index));
  };
  const addRow = (): void => {
    if (!canAdd) return;
    onChange([...rows, emptyRow()]);
  };

  const badRow = error?.index;
  const badPeer = error?.conflictIndex;

  return (
    <div className="ki-ds-map" data-ki-mappings={rows.length}>
      <div style={{ ...GRID, marginBottom: 6 }}>
        <span className="ki-form-label">仓库子目录</span>
        <span className="ki-form-label">落点 Group</span>
        <span aria-hidden="true" />
      </div>

      {rows.map((row, index) => {
        const offending = badRow === index || badPeer === index;
        return (
          <div key={`${idPrefix}-map-${index}`} style={{ ...GRID, marginBottom: 8 }}>
            <input
              id={`${idPrefix}-subdir-${index}`}
              className={`ki-form-input${offending ? ' ki-form-input--error' : ''}`}
              type="text"
              aria-label={`第 ${index + 1} 条映射的仓库子目录`}
              placeholder="如 docs/guide（留空 = 仓库根）"
              value={row.subdir}
              disabled={disabled}
              aria-invalid={badRow === index ? true : undefined}
              onChange={(event) => patchRow(index, { subdir: event.target.value })}
            />
            <GroupPathSelect
              scope={scope}
              value={row.group}
              onChange={(value) => patchRow(index, { group: value })}
              placeholder="搜索或输入新 Group"
              disabled={disabled || !scope}
            />
            <button
              type="button"
              className="ki-btn ki-btn--secondary ki-btn--small"
              title={rows.length === 1 ? '至少保留 1 条映射' : `删除第 ${index + 1} 条映射`}
              aria-label={rows.length === 1 ? '至少保留 1 条映射' : `删除第 ${index + 1} 条映射`}
              disabled={!canRemove}
              onClick={() => removeRow(index)}
            >✕</button>
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="ki-btn ki-btn--secondary ki-btn--small"
          disabled={!canAdd}
          title={canAdd ? '再加一条子目录映射' : `最多 ${MAX_MAPPINGS} 条映射`}
          onClick={addRow}
        >{rows.length >= MAX_MAPPINGS ? `已达上限 ${MAX_MAPPINGS} 条` : '+ 添加映射'}</button>
        <span className="ki-cell-sub">
          {rows.length} 条 · 至少 1 条，最多 {MAX_MAPPINGS} 条
        </span>
      </div>

      {error ? (
        <p className="ki-form-error" role="alert">{error.message}</p>
      ) : (
        <p className="ki-form-hint">
          子目录留空 = 仓库根；Group 留空 = 按该子目录内顶层目录自动命名。
          {rows.length > 1 ? `本次将只导入这 ${rows.length} 个子目录。` : ''}
          {hint ? ` ${hint}` : ''}
        </p>
      )}
      {!error && rows.length === 1 && !rows[0].subdir.trim() ? (
        <p className="ki-form-hint">{subdirLabel('')}：本次会扫描整个仓库（大仓库建议填子目录）</p>
      ) : null}
    </div>
  );
}
