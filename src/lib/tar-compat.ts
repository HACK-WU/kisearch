import { execFileSync } from 'node:child_process';

let isGnu: boolean | null = null;

function isGnuTar(): boolean {
  if (isGnu === null) {
    try {
      isGnu = /GNU tar/i.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }));
    } catch {
      // tar 不可用：交给调用方的可用性检查给出可读错误
      isGnu = false;
    }
  }
  return isGnu;
}

/**
 * Windows 下 GNU tar 会把 `-f C:\...` 的盘符当成远程主机（rsync 语法），
 * 报 `Cannot connect to C: resolve failed`；`--force-local` 关闭该解析。
 * Windows 10+ 内置的 bsdtar 不支持该参数，故只在确认是 GNU tar 时追加。
 */
export function tarPathArgs(): string[] {
  return process.platform === 'win32' && isGnuTar() ? ['--force-local'] : [];
}

/**
 * 创建归档统一使用 pax 格式。
 *
 * GNU tar 在 Windows 上默认写 gnu/ustar 格式，含中文名的条目会被 Windows 内置
 * bsdtar 拒绝（`Invalid empty pathname`）；pax 格式两种实现都能正确读取。
 */
export function tarFormatArgs(): string[] {
  return ['--format=pax'];
}

/** Windows 下交给 tar 的路径统一转正斜杠：MSYS GNU tar 对 `-C C:\...` 解析不稳定。 */
export function tarPath(input: string): string {
  return process.platform === 'win32' ? input.replace(/\\/g, '/') : input;
}
