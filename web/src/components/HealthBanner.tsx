/**
 * HealthBanner.tsx —— 服务未就绪横幅（对齐 demo ki-banner）
 * 前端不启动/关闭服务，仅检测 + 手动指引。
 */

import { useHealth } from '@/lib/hooks';

export function HealthBanner(): JSX.Element | null {
  const { data, isError, isPending, refetch } = useHealth();

  if (isPending) return null;
  if (isError || !data?.ok) {
    return (
      <div className="ki-banner">
        <div className="ki-banner__msg">
          <span>⚠</span>
          <span>
            MCP HTTP 服务未就绪，部分功能不可用。请执行{' '}
            <code>ki mcp --http --web</code> 启动服务后重试。
          </span>
        </div>
        <div className="ki-banner__actions">
          <button className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => void refetch()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  return null;
}
