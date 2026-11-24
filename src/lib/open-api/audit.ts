/**
 * `/open/v1` 只读取件的访问留痕（REQ-20261124-002 · S-01）。
 *
 * 为什么只写 stderr、不落文件：
 * 落 JSONL 要新增目录、轮转与清理策略，收益不足以抵成本；运维排查「谁把库拉走了」
 * 时 grep 服务日志即可。**代价是日志轮转后不可追溯**，若将来需要按 token 出审计报表，
 * 再改落文件（设计 S01 §6 决策点已记重评触发条件）。
 *
 * 三条纪律：
 * 1. **绝不抛错**：留痕失败不得影响下载响应（与 `recordScopeUsage` 同一口径）。
 * 2. **token 脱敏**：只写前 8 位 + `…`，日志泄露不等于 token 泄露。
 * 3. **单行 JSON**：便于 grep / jq，不要写多行结构。
 */

export interface DownloadAuditEvent {
  /** token id（写入时自动脱敏为前 8 位） */
  tokenId?: string;
  scope: string;
  endpoint: 'asset' | 'doc';
  /** asset: `group/path`；doc: `group/relation` */
  path: string;
  /** 实际发出的字节数（doc 端点可缺省） */
  bytes?: number;
  status: number;
}

/** 脱敏：`tok_abc12345xyz` → `tok_abc1…`；无 id（本机免登录）写 `(local)` */
function maskToken(tokenId?: string): string {
  if (!tokenId) return '(local)';
  return tokenId.length <= 8 ? `${tokenId}…` : `${tokenId.slice(0, 8)}…`;
}

/**
 * 记一条下载留痕。**永不抛错**——调用方不需要 try/catch。
 */
export function logDownload(ev: DownloadAuditEvent): void {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      kind: 'open-api-download',
      token: maskToken(ev.tokenId),
      scope: ev.scope,
      endpoint: ev.endpoint,
      path: ev.path,
      ...(ev.bytes !== undefined ? { bytes: ev.bytes } : {}),
      status: ev.status,
    });
    process.stderr.write(`[open-api] ${line}\n`);
  } catch {
    // 留痕永不影响主链路
  }
}
