/**
 * cli-args.ts —— 手写 argv 解析器的公共校验（NEG-01 / NEG-03 / NEG-04）
 *
 * 部分命令（backup/restore/export）使用手写 process.argv 解析，
 * 未知/拼写错误的参数会被静默忽略。本模块提供：
 *   - detectUnknownFlags: 检出未知 --flag 并给出最接近的正确参数建议
 *   - failJson: 统一 JSON 错误输出契约 { ok:false, error, code }
 */

/**
 * 统一错误输出并退出（契约：{ ok:false, error, code? }）。
 */
export function failJson(error: string, code?: string): never {
  const payload: Record<string, unknown> = { ok: false, error };
  if (code) payload.code = code;
  console.log(JSON.stringify(payload, null, 2));
  process.exit(1);
}

/**
 * 从任意抛出值提取统一错误负载（NEG-04）。
 * 若 Error 携带 code 字段（如 ScopeError / PreflightError）则一并回显。
 */
export function toErrorPayload(err: unknown): { ok: false; error: string; code?: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  const payload: { ok: false; error: string; code?: string } = { ok: false, error: message };
  if (typeof code === 'string') payload.code = code;
  return payload;
}

/**
 * Levenshtein 编辑距离（用于「您是否想输入」建议）。
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}

/** 从已知参数中找出与 unknown 最接近的一个（距离阈值内） */
function suggest(unknown: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = editDistance(unknown, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  // 仅在足够接近时给建议（<= 名称长度的一半，且至少 <=3）
  const threshold = Math.max(1, Math.min(3, Math.floor(unknown.length / 2)));
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

/**
 * 检出未知的 --flag 参数。发现即通过 failJson 报错（附近似建议）。
 *
 * @param args      process.argv.slice(2)
 * @param knownFlags 该命令认识的全部 --flag 名（含带值与布尔型）
 * @param valueFlags 需要消费下一个 token 作为值的 --flag（其值不应被当作未知参数）
 */
export function detectUnknownFlags(
  args: string[],
  knownFlags: string[],
  valueFlags: string[] = []
): void {
  const valueSet = new Set(valueFlags);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) continue;

    // 支持 --flag=value 形式
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;

    if (!knownFlags.includes(name)) {
      const tip = suggest(name, knownFlags);
      failJson(
        `未知参数 ${name}` + (tip ? `，您是否想输入 ${tip}？` : `\n可用参数：${knownFlags.join(', ')}`),
        'UNKNOWN_OPTION'
      );
    }

    // 若是带值参数且未用 = 形式，跳过其值 token（避免值被误判为未知参数）
    if (valueSet.has(name) && !token.includes('=')) {
      i++;
    }
  }
}

/**
 * 解析整数型 CLI 参数（NEG-02）：非法值回退默认值时显式警告（stderr）。
 *
 * @param raw        原始字符串值
 * @param fallback   非法时回退的默认值
 * @param flagName   参数名（用于警告文案）
 * @param opts.min   最小值（含），低于则回退
 * @param opts.max   最大值（含），高于则限幅并警告
 */
export function parseIntArg(
  raw: unknown,
  fallback: number,
  flagName: string,
  opts: { min?: number; max?: number } = {}
): number {
  const { min, max } = opts;
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
    console.warn(`警告：${flagName} 取值无效（${String(raw)}），已回退为默认 ${fallback}`);
    return fallback;
  }
  if (max !== undefined && parsed > max) {
    console.warn(`警告：${flagName} ${parsed} 超过最大值，已限制为 ${max}`);
    return max;
  }
  return parsed;
}

/**
 * 解析浮点型 CLI 参数（NEG-02）：非有限值时回退并警告（stderr）。
 * 返回 undefined 表示使用调用方的“不过滤/不限制”语义。
 */
export function parseFloatArg(
  raw: unknown,
  fallback: number | undefined,
  flagName: string
): number | undefined {
  const parsed = parseFloat(String(raw));
  if (!Number.isFinite(parsed)) {
    console.warn(`警告：${flagName} 取值无效（${String(raw)}），已回退为默认 ${fallback ?? '不过滤'}`);
    return fallback;
  }
  return parsed;
}
