/**
 * ScopeSelect.tsx —— 全局 scope 选择器（default 兜底，对齐 demo ki-form-select）
 */

import { useScope } from '@/lib/scopeContext';
import { useScopeList } from '@/lib/hooks';

export function ScopeSelect(): JSX.Element {
  const { scope, setScope } = useScope();
  const { data, isLoading } = useScopeList();
  const scopes = data?.scopes ?? [];

  return (
    <select
      className="ki-form-select"
      style={{ width: 'auto', minWidth: 140 }}
      value={scope}
      onChange={(e) => setScope(e.target.value)}
      disabled={isLoading}
      title="当前知识库（scope）"
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
