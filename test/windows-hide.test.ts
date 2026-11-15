/**
 * 源码守卫：子进程调用必须带 `windowsHide: true`。
 *
 * 背景（2026-11-02）：Web 上「添加 Git 数据源 → 添加并开始首次同步」时，
 * Windows 用户看到桌面弹出 cmd 窗口并闪好几下。
 *
 * 根因：daemon 以 detached 方式常驻（`bin/ki.mjs` / `daemon-client.ts` / `mcp-server.ts`
 * 都是 `detached: true` + `stdio: 'ignore'`），在 Windows 上等于 DETACHED_PROCESS ——
 * daemon 自身没有控制台。此后它每 spawn 一个 console 程序（git.exe / tar.exe /
 * cmd.exe / node.exe），系统都会为该子进程新建一个控制台窗口，命令结束即关闭，
 * 表现为「闪一下」。一次添加数据源会调用 git 5+ 次（clone、probe、同步），于是闪好几下。
 *
 * Node 的 `windowsHide` 默认 false，必须在每个调用点显式打开；该选项在
 * Linux/macOS 上被忽略，开启无副作用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CP_IMPORT_RE, listFiles, stripComments, callSnippets } from './code-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 只扫产品代码：test / scripts 是开发期脚本，不参与用户侧窗口问题 */
const SCAN_DIRS = ['src', 'bin'];

test('windowsHide: 所有子进程调用都隐藏 Windows 控制台窗口', () => {
  const files = SCAN_DIRS
    .flatMap((rel) => listFiles(path.join(ROOT, rel)))
    .filter((file) => CP_IMPORT_RE.test(fs.readFileSync(file, 'utf8')));

  // 正则应命中 src+bin 下的全部子进程调用文件；数量骤降说明匹配失效，不能让测试空跑变绿
  assert.ok(files.length >= 8, `应扫描到 >=8 个引入 child_process 的文件，实际 ${files.length} 个`);

  const missing: string[] = [];
  let total = 0;
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    for (const call of callSnippets(stripComments(code))) {
      total += 1;
      if (call.text.includes('windowsHide')) continue;
      const line = code.slice(0, call.index).split('\n').length;
      missing.push(`${path.relative(ROOT, file)}:${line}`);
    }
  }

  assert.ok(total >= 10, `应扫描到 >=10 处子进程调用，实际 ${total}（CALL_RE 可能已失效）`);
  assert.deepEqual(
    missing,
    [],
    `以下子进程调用缺少 windowsHide: true —— Windows 下 daemon 无控制台，会为每条命令弹一个黑窗口：\n${missing.join('\n')}`,
  );
});

/**
 * 白名单兜底：上面的正则靠「字面量函数名」识别调用，遇到别名写法
 * （`import cp from 'node:child_process'; cp.spawn(...)`）会静默漏检。
 * 这里按文件粒度再兜一层，并在文件被重命名/移动时提醒同步清单。
 */
const REQUIRED_FILES = [
  'src/lib/datasource-git.ts',
  'src/lib/datasource-clone.ts',
  'src/lib/daemon-client.ts',
  'src/mcp-server.ts',
  'bin/ki.mjs',
  'src/lib/clean.ts',
  'src/lib/backup.ts',
  'src/lib/safe-tar.ts',
  'src/lib/tar-compat.ts',
  'src/restore.ts',
  'src/lib/restore-snapshot.ts',
];

test('windowsHide: 已知子进程文件清单全部带 windowsHide', () => {
  const missing = REQUIRED_FILES.filter((rel) => {
    const file = path.join(ROOT, rel);
    return !fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('windowsHide');
  });
  assert.deepEqual(
    missing,
    [],
    `以下文件缺失或已不带 windowsHide（若文件被重命名/迁移，请同步 REQUIRED_FILES）：\n${missing.join('\n')}`,
  );
});
