/**
 * ScopeSelect.tsx —— 全局 scope 选择器（default 兜底，对齐 demo ki-form-select）
 */

import { useScope } from '@/lib/scopeContext';
import { useScopeList } from '@/lib/hooks';

export function ScopeSelect(): JSX.Element {
  const { scope, setScope } = useScope();
  const { data, isLoading } = useScopeList();
  const scopes = data?.scopes ?? [];
  // 降级提示：vectorAvailable=false 表示向量层不可用（如被导入进程持锁），
  // 列表已降级为仅 KB 层枚举，不因锁挂掉；悬停可见原因
  const degraded = data != null && data.vectorAvailable === false;

  return (
    <select
      className="ki-form-select"
      style={{ width: 'auto', minWidth: 140 }}
      value={scope}
      onChange={(e) => setScope(e.target.value)}
      disabled={isLoading}
      title={degraded
        ? `向量层暂不可用，仅显示 KB 层 scope${data?.vectorReason ? `：${data.vectorReason}` : ''}`
        : '当前知识库（scope）'}
    >
      {(scopes.length ? scopes : [{ scope: 'default', kb: false, vector: false, registered: false, wikiCount: 0 }]).map(
        (s) => (
          <option key={s.scope} value={s.scope}>
            {s.scope}
          </option>
        ),
      )}
    </select>
  );
}
