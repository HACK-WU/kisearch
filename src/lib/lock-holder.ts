/**
 * lock-holder.ts —— 「向量库被其他进程占用」时反查**到底是谁**持有 LOCK（Linux）。
 *
 * 背景（现场）：撞锁提示原先只说「被其他进程占用或存在崩溃残留」，用户要自己
 * `ps` / `lsof` 才能找到占用者（实际撞见过一个挂住的临时脚本持锁 40 分钟）。
 * 本模块在 Linux 上通过 `/proc/locks` 反查持锁 PID，再读 `/proc/<pid>/{comm,cmdline}`
 * 给出进程名与命令行摘要，直接写进提示。
 *
 * 约定：
 * - 只在撞锁（异常慢路径）调用，允许同步文件 I/O；
 * - 任何一步不可得（非 Linux / 权限不足 / 格式变化）一律返回 `null`，调用方降级为
 *   原文案 —— 绝不因为"查不到持锁者"改变错误类型或阻断报错；
 * - device 字段仅作可选校验（跨平台/容器下 dev_t 编码可能不同），失败回退 inode 匹配。
 */
import fs from 'node:fs';

export interface LockHolder {
  pid: number;
  /** 进程名（`/proc/<pid>/comm`）；读不到为 '?' */
  name: string;
  /** 命令行摘要（`/proc/<pid>/cmdline`，截断）；读不到为 '?' */
  cmd: string;
  /** 持锁者就是当前进程自己（提示需换措辞：不是"别的进程"，而是本进程的旧句柄/孤儿 worker） */
  self: boolean;
  /**
   * 进程启动时刻（epoch ms）；读不到为 undefined。
   *
   * 为什么要它：撞锁时最容易误判「持锁者还在写数据」。运行时长能把两种情形分开——
   * 刚启动几秒（大概真在干活） vs 静置几小时/几天（多半是干完不退的残留进程），
   * 后者才适合直接 kill（事件 #109，实测一个只读脚本持锁 9 分钟、另一个挂 3 天）。
   */
  startedAtMs?: number;
  /** 已运行毫秒数（`now - startedAtMs`，clamp 到 0）；读不到为 undefined */
  uptimeMs?: number;
}

/** 命令行摘要上限（避免把超长参数整段吐到提示里） */
const CMD_MAX = 160;

/**
 * 命令行里的敏感段遮蔽：提示会进服务端日志、HTTP 响应与前端页面（`task-registry`
 * 已有"不保存 provider 原始错误内容"的同类约定），`--api-key=xxx` / `--token xxx`
 * 这类参数必须遮蔽后再展示 —— 展示的目的是"让人认出是哪个进程"，不需要参数值。
 */
const REDACT_RE = /((?:api[-_]?key|token|secret|password|passwd|pwd)[=:\s]+)(\S+)/gi;
/**
 * `--authorization Bearer sk-xxx` 单独一条规则：值常带 scheme 前缀
 * （`Bearer` / `Basic` / `Token`），只吞一个 token 会把真值留在提示里。
 */
const REDACT_AUTH_RE = /((?:proxy-)?authorization[=:\s]+)(?:Bearer|Basic|Token)?\s*\S+/gi;

/** 遮蔽命令行中的敏感参数值（导出供测试：纯函数） */
export function redactCmdline(text: string): string {
  return text.replace(REDACT_RE, '$1***').replace(REDACT_AUTH_RE, '$1***');
}

/**
 * `/proc/locks` 的 device 字段是 `major:minor` 的十六进制表示；
 * 这里按 Linux glibc 的 dev_t 编码换算（与 stat.dev 对齐）。
 */
export function deviceKeyOf(dev: number): string {
  const major = (dev >> 8) & 0xfff;
  const minor = (dev & 0xff) | ((dev >> 12) & 0xfff00);
  return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}`;
}

/**
 * 从 `/proc/locks` 内容里找出持有 `ino` 的进程 PID（找不到返回 null）。
 *
 * 行格式：`55: FLOCK ADVISORY WRITE 920577 08:30:5511234 0 EOF`
 * - 只认 `FLOCK|POSIX|OFDLCK|LEASE` 开头的**主行**；`1: -> POSIX ...` 是**等待者**，
 *   必须跳过 —— 否则会把正在排队等锁的进程误报成持有者；
 * - 传 `devKey` 时要求 device 一致（inode 跨设备撞车时排除）；不传则只按 inode 匹配。
 */
export function parseProcLocks(content: string, ino: string, devKey?: string): number | null {
  for (const line of content.split('\n')) {
    const matched = /^\s*\d+:\s+(?:FLOCK|POSIX|OFDLCK|LEASE)\s+\S+\s+\S+\s+(\d+)\s+(\S+):(\d+)\s/.exec(line);
    if (!matched) continue;
    const [, pidRaw, dev, inode] = matched;
    if (inode !== ino) continue;
    if (devKey !== undefined && dev !== devKey) continue;
    const pid = Number(pidRaw);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Linux USER_HZ：`/proc/<pid>/stat` 的 starttime 单位（jiffies）。
 * 常规 x86/arm 内核恒为 100（与 `getconf CLK_TCK` 一致）；容器内同样继承。
 * 取不到时宁可少报运行时长，也不要为它同步 spawn 一个 getconf（撞锁路径要快）。
 */
const USER_HZ = 100;

/**
 * 从 `/proc/<pid>/stat` 内容解析 starttime（第 22 字段，jiffies since boot）。
 *
 * 解析必须从**最后一个 `)`** 之后切分：第 2 字段 comm 可含空格与括号
 * （如 `(node /path/with space)`），按空格直接 split 会整体错位。
 */
export function parseProcStatStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // 切片后第 1 项 = 原第 3 项 state，故原第 22 项 starttime 落在索引 19
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const raw = fields[19];
  if (!raw) return null;
  const ticks = Number(raw);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
}

/** `/proc/stat` 的 `btime`（开机时刻，epoch 秒）；读不到为 null */
function readBootTimeMs(): number | null {
  try {
    const matched = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    if (!matched) return null;
    const sec = Number(matched[1]);
    return Number.isFinite(sec) ? sec * 1000 : null;
  } catch {
    return null;
  }
}

/** 进程启动时刻（epoch ms）；任一步不可得返回 null（调用方降级为不带时长） */
function readProcessStartMs(pid: number): number | null {
  try {
    const ticks = parseProcStatStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (ticks === null) return null;
    const bootMs = readBootTimeMs();
    if (bootMs === null) return null;
    return Math.round(bootMs + (ticks * 1000) / USER_HZ);
  } catch {
    return null;
  }
}

/**
 * 运行时长的人类可读形式：`48秒` / `15分22秒` / `3小时7分` / `3天16小时`。
 * 只用于判断"刚启动"还是"挂了两天"，不需要更细的秒级精度。
 */
export function formatUptime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分${sec % 60}秒`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时${min % 60}分`;
  return `${Math.floor(hour / 24)}天${hour % 24}小时`;
}

function readComm(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || '?';
  } catch {
    return '?';
  }
}

function readCmdline(pid: number): string {
  try {
    // cmdline 以 \0 分隔；内核线程为空串
    const joined = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').trim();
    if (!joined) return '?';
    const safe = redactCmdline(joined);
    return safe.length > CMD_MAX ? `${safe.slice(0, CMD_MAX)}…` : safe;
  } catch {
    return '?';
  }
}

/**
 * 定位 `lockFilePath` 的持锁进程；不可得时返回 `null`（调用方降级为静态文案）。
 * 非 Linux 直接返回 null —— `/proc` 是 Linux 专有接口。
 */
export function findLockHolder(lockFilePath: string): LockHolder | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.statSync(lockFilePath);
    const ino = String(stat.ino);
    const content = fs.readFileSync('/proc/locks', 'utf8');
    // 先按 device+inode 精确匹配；device 编码不一致时退回 inode-only（宁可少报设备也不漏报持锁者）
    const pid = parseProcLocks(content, ino, deviceKeyOf(stat.dev)) ?? parseProcLocks(content, ino);
    if (pid === null) return null;
    // 运行时长是"能不能直接 kill"的关键判据：读不到就省略，不让提示整体降级
    const startedAtMs = readProcessStartMs(pid);
    return {
      pid,
      name: readComm(pid),
      cmd: readCmdline(pid),
      self: pid === process.pid,
      ...(startedAtMs !== null
        ? { startedAtMs, uptimeMs: Math.max(0, Date.now() - startedAtMs) }
        : {}),
    };
  } catch {
    return null;
  }
}

/** 运行时长片段（读不到进程启动时刻时为空串，不改变原有措辞） */
function uptimeNote(holder: LockHolder): string {
  return holder.uptimeMs === undefined ? '' : `，已运行 ${formatUptime(holder.uptimeMs)}`;
}

/**
 * 渲染成提示里的一行（前缀「持锁进程」稳定，供上层按需提取）。
 * 注意区分"别的进程"与"本进程自己"——后者重启服务即可解，不必去找外部实例。
 */
export function formatLockHolder(holder: LockHolder): string {
  const label = `${holder.name}${holder.self ? '，本进程' : ''}`;
  const uptime = uptimeNote(holder);
  if (holder.self) {
    // 末尾不加标点：调用方可能在其后接换行（lockedHint）或 `；`（health-check 提取）
    return `  ● 持锁进程：PID ${holder.pid} (${label})${uptime} —— 锁被本进程自己持有（如 probe 孤儿 worker /`
      + ` 旧句柄未释放），重启本服务通常可解`;
  }
  const cmd = holder.cmd === '?' ? '' : ` — ${holder.cmd}`;
  return `  ● 持锁进程：PID ${holder.pid} (${label})${uptime}${cmd}`;
}

/**
 * 单行紧凑版（无前缀/换行），给撞锁重试日志用。
 *
 * 重试日志原来只给 PID 与进程名，看不出"它在干什么"；把命令行与运行时长一起带出来，
 * 才能在刷屏日志里直接判断是长任务还是干完不退的残留进程（事件 #109）。
 */
export function formatLockHolderBrief(holder: LockHolder): string {
  const label = `${holder.name}${holder.self ? '，本进程' : ''}`;
  const cmd = holder.cmd === '?' ? '' : ` — ${holder.cmd}`;
  return `PID ${holder.pid} (${label})${uptimeNote(holder)}${cmd}`;
}
