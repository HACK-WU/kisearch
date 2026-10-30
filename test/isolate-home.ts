/**
 * 测试用「临时家目录」隔离（跨平台）。
 *
 * 为什么需要单独的模块：Node 的 `os.homedir()` 在 POSIX 读 `$HOME`，在 **Windows 读 `USERPROFILE`**。
 * 只设 `process.env.HOME` 的隔离在 Windows 上**完全失效** —— 测试里的默认数据路径
 * （`~/.ki/kb`、`~/.ki/datasources`、`~/.ki/import-uploads` …）会落进**真实用户目录**，
 * 测试收尾再删掉临时目录，就留下指向已删路径的幽灵记录（实测事故：Windows 上数据源页
 * 出现用户从未登记的 `sched-api 目录不可读`，见 `.debug/datasource-ghost-scope-win-20261030/`）。
 *
 * 用法（顺序重要：必须在读取 homedir 的模块被 import / 调用**之前**设置）：
 * ```ts
 * const home = useTempHome('ki-foo-');        // mkdtemp + 挂 HOME/USERPROFILE
 * const dir = home.home;
 * // ... 测试 ...
 * home.restore();                              // after() 里还原
 * ```
 * 已经自己建好目录（例如要落在别的临时根下）时用 `useTempHomeAt(dir)`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TempHome {
  /** 临时家目录绝对路径 */
  home: string;
  /** 还原 HOME / USERPROFILE 到设置前的值（undefined → 删除该变量） */
  restore(): void;
}

function bindHome(dir: string): TempHome {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    home: dir,
    restore() {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    },
  };
}

/** 建一个临时家目录并同时挂到 HOME / USERPROFILE 上 */
export function useTempHome(prefix: string): TempHome {
  return bindHome(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** 把**已存在**的目录挂成临时家目录（HOME / USERPROFILE 一起改） */
export function useTempHomeAt(dir: string): TempHome {
  return bindHome(dir);
}
