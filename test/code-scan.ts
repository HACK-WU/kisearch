/**
 * code-scan.ts —— 静态扫描工具（无副作用，不带 .test 后缀，不会被 run-tests 当测试执行）
 *
 * 两处守卫共用同一套「抹注释 + 括号配平截取调用表达式」逻辑，避免各写一份正则导致口径漂移：
 *   - `windows-hide.test.ts`：src/bin 下的子进程调用必须带 `windowsHide: true`
 *   - `cli-timeout.test.ts`：test 下的子进程调用必须限时（REQ-20261115-002 R1/R6）
 */
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_EXT = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

/** 只检查真正引入 child_process 的文件：避免把 `proxy.spawn()` 这类业务方法误判 */
export const CP_IMPORT_RE = /from\s+['"](?:node:)?child_process['"]|(?:import|require)\(\s*['"](?:node:)?child_process['"]\s*\)/;

/**
 * 前置排除 `.` / 标识符字符：`proxy.spawn(`、`/re/.exec(` 不算模块调用。
 *
 * `execFileAsync`（`promisify(execFile)` 的产物）单列一支：它名字更长，
 * 不单列会被 `execFile` 分支的前缀匹配漏掉（`execFile` 后跟 `Async` 不满足 `\s*\(`）。
 */
const CALL_RE = /(?<![.\w$])(?:execFileSync|execFileAsync|execFile|execSync|spawnSync|spawn|exec)\s*\(/g;

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listFiles(full));
    } else if (SCRIPT_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 抹掉注释（等长空白、保留换行），避免把文件头注释里的 `execFile('git', args)` 示例
 * 当成真实调用。带字符串感知：`'https://…'` 里的 `//` 不会被误判为行注释。
 */
export function stripComments(code: string): string {
  type State = 'code' | 'single' | 'double' | 'template' | 'line' | 'block';
  let out = '';
  let state: State = 'code';
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const next = code[i + 1];
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 1; continue; }
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 1; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 1; continue; }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      continue;
    }
    // 字符串内：原样保留，转义对整体跳过
    if (ch === '\\') { out += ch + (next ?? ''); i += 1; continue; }
    if (state === 'single' && ch === "'") state = 'code';
    else if (state === 'double' && ch === '"') state = 'code';
    else if (state === 'template' && ch === '`') state = 'code';
    out += ch;
  }
  return out;
}

/** 从调用起点按括号配平截取完整调用表达式（含 options 实参） */
export function callSnippets(code: string): Array<{ index: number; text: string }> {
  const found: Array<{ index: number; text: string }> = [];
  // 复制一份正则：CALL_RE 带 /g，共享 lastIndex 会漏扫
  const re = new RegExp(CALL_RE.source, CALL_RE.flags);
  for (const match of code.matchAll(re)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = code.length;
    for (let i = open; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    found.push({ index: match.index ?? 0, text: code.slice(match.index ?? 0, end) });
  }
  return found;
}
