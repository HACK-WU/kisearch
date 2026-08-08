/**
 * clean.ts —— REQ-06/07 数据清洗：cleanMarkdownText 内置规则 + 外部 hook 管道（批次 1：内置规则；批次 5：hook）
 *
 * 设计要点（REQ-20260807-001 v9）：
 *   - 清洗只作用于向量化输入；local KB 存文件原文（方案 D，由 import.ts 保证）
 *   - 执行顺序约束（C-2/意见2）：代码块先剥离（keepShortSamples 保留 ≤15 行原样）→ 路径剥离仅代码块外
 *   - 路径剥离：先剥行号（#L490-L510 含 -L510 兜底）→ file:// / markdown 链接 / 裸路径（防残留）
 *   - 空 inline code / 孤儿标题（"本文引用的文件"类引用清单）清理
 *   - 异常兜底：normalize('NFC') try-catch 降级返回原文
 *   - cleanVersion：source 块记录，规则变更提示重建（防增量/全量不一致）
 */

// ─── CleanRules 类型 ───────────────────────────────────────────

export interface CleanRules {
  bom?: boolean;          // BOM 剥离
  frontmatter?: boolean;  // YAML frontmatter 剥离
  htmlComment?: boolean;  // HTML 注释剥离
  mermaid?: boolean;      // mermaid 块剥离
  codePath?: boolean;     // 文件路径剥离（模式识别）
  codeBlock?: boolean;    // 代码块剥离
  emptyChunk?: boolean;   // 空 chunk 过滤（切分后，不在本函数内）
  keepShortSamples?: boolean; // 保留 ≤15 行短代码示例（默认 true）
}

export const DEFAULT_CLEAN_RULES: Required<Omit<CleanRules, 'emptyChunk'>> = {
  bom: true,
  frontmatter: true,
  htmlComment: true,
  mermaid: true,
  codePath: true,
  codeBlock: true,
  keepShortSamples: true,
};

/** 清洗版本：规则变更时递增（source 块 cleanVersion 比较用） */
export const CLEAN_VERSION = '1';

/** 短示例保留：内容 ≤15 行（含开闭 fence 共 ≤17 行） */
const SHORT_SAMPLE_MAX_LINES = 17;

/**
 * 按规则清洗 Markdown 文本。
 * @param text 原始文本
 * @param rules 规则开关（缺省按 DEFAULT_CLEAN_RULES 全开）
 * @returns 清洗后文本；异常时降级返回原文（trim 后）
 */
export function cleanMarkdownText(text: string, rules?: CleanRules): string {
  const cfg: Required<Omit<CleanRules, 'emptyChunk'>> = { ...DEFAULT_CLEAN_RULES, ...rules };

  try {
    let t = text;

    // ① BOM
    if (cfg.bom) t = t.replace(/^\uFEFF/, '');

    // ② 控制字符/替换符/零宽字符 + Unicode NFC 规范化
    t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u200B-\u200F]/g, '');
    t = t.normalize('NFC');

    // ③ frontmatter 整块删除（含闭合边界校验：`---` 后须紧跟 \n 或 EOF）
    if (cfg.frontmatter && t.startsWith('---')) {
      const end = t.indexOf('\n---', 3);
      if (end !== -1 && /^[A-Za-z_-]+:\s*\S/m.test(t.slice(3, end))) {
        const after = t.slice(end + 4);
        if (after === '' || /^[\r\n]/.test(after)) {
          t = after;
        }
      }
    }

    // ③ HTML 注释
    if (cfg.htmlComment) t = t.replace(/<!--[\s\S]*?-->/g, '');

    // ③ mermaid 块
    if (cfg.mermaid) t = t.replace(/```mermaid[\s\S]*?```/g, '');

    // ④ 代码块剥离（先于路径剥离：保留的短示例整体原样，不被路径正则破坏）
    if (cfg.codeBlock) {
      const CODE_FENCE = /```[a-zA-Z0-9_-]*\n[\s\S]*?```/g;
      t = cfg.keepShortSamples
        ? t.replace(CODE_FENCE, (m) => (m.split('\n').length <= SHORT_SAMPLE_MAX_LINES ? m : ''))
        : t.replace(CODE_FENCE, '');
      // 清理剥离后残留的孤立语言标记（```python 剥成 `python` 或 python 单独成行）
      t = t.replace(
        /^\s*`?(?:python|bash|sh|ts|js|json|yaml|yml|go|java|rust|sql|text|markdown|shell|c|cpp|html|css|dockerfile)\s*`?\s*$/gm,
        ''
      );
    }

    // ⑤ 文件路径剥离（仅代码块外文本）
    if (cfg.codePath) {
      // 先整块剥 markdown 链接目标，保留文字
      t = t.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1');
      // file:// URL
      t = t.replace(/file:\/\/[^\s\)\]>]+/g, '');
      // 行号引用（#L490、#L490-L510、:490 范围；-L510 后缀兜底）
      t = t.replace(/(?:#L\d+(?:-\d+|-L\d+)?|:\d+(?:-\d+)?|#L\d+)/g, '');
      t = t.replace(/-L\d+/g, '');
      // 裸代码文件路径（含目录层级 /；不得跨 # 与 -L；排除 URL）
      t = t.replace(/\b[\w./]+\/[\w./-]+\.(?:py|ts|js|tsx|go|java|rs|sh|md|json|yaml|yml)(?![\w-])/g, '');
      // 空 inline code 清理
      t = t.replace(/`\s*`/g, '');
      // 剥离后整行仅剩符号（含反引号、-、*、| 表格残壳）→ 删行；正常空行保留（留空行折叠统一处理）
      t = t
        .split('\n')
        .filter((l) => !(l.trim().length > 0 && /^[\s\-*•·>|`]+$/.test(l)))
        .join('\n');
      // 孤儿标题清理（"本文引用的文件"类引用清单：标题后无内容则删）
      const lines = t.split('\n');
      const kept: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^\*\*[^*]+\*\*[:：]?$/.test(line) && /引用|参考|文件/.test(line)) {
          const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
          if (next === '' || /^(#|\*\*)/.test(next)) continue; // 孤儿标题删除
        }
        kept.push(lines[i]);
      }
      t = kept.join('\n');
    }

    // ⑥ 折叠 3+ 连续空行为 2 个（保留段落边界供切分）
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  } catch {
    // 异常兜底（normalize 极端输入等理论场景）：降级返回原文
    return text.trim();
  }
}

/**
 * 从 `--clean-rules bom,frontmatter` 字符串解析规则开关（CLI 覆盖 config）。
 * 未列出的规则保持默认（全开）。
 */
export function parseCleanRules(cliRules?: string): Partial<CleanRules> | undefined {
  if (!cliRules || !cliRules.trim()) return undefined;
  const parts = cliRules.split(',').map((s) => s.trim()).filter(Boolean);
  const rules: Partial<CleanRules> = {};
  for (const p of parts) {
    switch (p) {
      case 'bom': rules.bom = true; break;
      case 'frontmatter': rules.frontmatter = true; break;
      case 'htmlComment': rules.htmlComment = true; break;
      case 'mermaid': rules.mermaid = true; break;
      case 'codePath': rules.codePath = true; break;
      case 'codeBlock': rules.codeBlock = true; break;
      case 'emptyChunk': rules.emptyChunk = true; break;
      default: // 未知规则名忽略
    }
  }
  return rules;
}

// ─── 外部 hook 管道（REQ-07）────────────────────────────────────

export type CleanHook = string; // 命令字符串，如 "node scripts/clean.js"

/** hook 超时（默认 10s，REQ-07 超时保护） */
export const HOOK_TIMEOUT_MS = 10_000;

export interface RunHookResult {
  ok: boolean;
  text: string;      // 清洗后内容（ok=true）；失败时为空串
  failedHooks: string[]; // 失败的 hook 命令
}

/**
 * 顺序执行外部清洗钩子（stdin→stdout 管道，一次一个文件）。
 * - 每个 hook 用 `sh -c` 执行；输入经 stdin，输出取 stdout
 * - 超时（默认 10s）→ SIGKILL 终止（N5：防孤儿进程）
 * - hook 失败（非零退出/超时）→ 跳过该 hook + 记入 failedHooks（不阻断后续）
 * @param text 待清洗内容（文件原文，local KB 已先行写入）
 * @param hooks 外部 hook 命令列表
 * @returns ok=所有 hook 成功；text=最终输出；failedHooks=失败清单
 */
export async function runCleanHooks(text: string, hooks: string[]): Promise<RunHookResult> {
  if (!hooks || hooks.length === 0) {
    return { ok: true, text, failedHooks: [] };
  }
  const { spawn } = await import('node:child_process');
  const failedHooks: string[] = [];
  let current = text;

  for (const hook of hooks) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn('sh', ['-c', hook], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            // 超时：SIGKILL 终止子进程（N5：防孤儿进程残留）
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            reject(new Error(`hook 超时（${HOOK_TIMEOUT_MS}ms）：${hook}`));
          }
        }, HOOK_TIMEOUT_MS);
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`hook 退出码 ${code}：${hook}${stderr ? `（${stderr.trim().slice(0, 100)}）` : ''}`));
          }
        });
        child.stdin.write(text);
        child.stdin.end();
      });
      current = output;
    } catch {
      failedHooks.push(hook); // 失败跳过该 hook + 告警（不阻断后续 hook）
    }
  }

  return { ok: failedHooks.length === 0, text: current, failedHooks };
}
