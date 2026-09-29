/**
 * HealthBanner.tsx —— 服务不可用横幅（对齐 demo ki-banner）
 * 前端不启动/关闭服务，仅检测 + 手动指引；指引文案按「不可达 / 检查异常」分叉。
 */

import { summarizeHealth, useHealth } from '@/lib/hooks';

export function HealthBanner(): JSX.Element | null {
  const { data, error, isPending, refetch } = useHealth();
  const s = summarizeHealth(data, error, isPending);

  // 只有「连不上」才该引导用户去启动服务；服务应答过的（检查超时 / 某项失败）
  // 再让他重启一个正常运行的 daemon 只会把事情弄得更糟。
  if (isPending || s.level === 'checking' || s.level === 'ok' || s.level === 'warn') return null;

  return (
    <div className="ki-banner">
      <div className="ki-banner__msg">
        <span>⚠</span>
        <span>
          {s.level === 'unreachable' ? (
            <>
              MCP HTTP 服务不可达，部分功能不可用。请执行 <code>ki mcp --http --web</code>{' '}
              启动服务后重试。
            </>
          ) : (
            <>
              {s.label}：{s.detail || '详见总览的健康状态卡片'}。
            </>
          )}
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
