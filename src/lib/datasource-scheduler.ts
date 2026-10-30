/**
 * 数据源定时调度器（S-02）。
 *
 * 按需存在：没有任何 enabled 计划时不建定时器；只 arm 最近到期的一个。
 * 运行在 daemon HTTP 进程内；stdio/CLI 不启动。进程级调度锁避免多 daemon 重复调度。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type KiConfig } from './config.js';
import { listRegisteredDataSourceRecords } from './datasource.js';
import { computeNextRun, type NextRunResult } from './datasource-schedule.js';
import { runScheduledSync, type ScheduledRunInput, type ScheduledRunResult } from './datasource-scheduled-run.js';
import type { DataSourceRecord } from './datasource-types.js';

const MAX_TIMER_MS = 2_147_000_000; // ~24.8 天，低于 Node setTimeout 上限
const SKIP_RETRY_MS = 5 * 60 * 1000;
const READ_FAIL_RETRY_MS = 60 * 1000;
const JITTER_FUTURE_MS = 60_000;
const JITTER_DUE_MS = 10_000;
const LOCK_NAME = '.datasource-scheduler.lock';

export interface DataSourceSchedulerState {
  started: boolean;
  disabled: boolean;
  enabledSources: number;
  armed: boolean;
  runningScope: string | null;
  nextScope: string | null;
  nextRunAt: number | null;
  lastSkip: { scope: string; reason: string; at: number } | null;
}

export interface DataSourceSchedulerDeps {
  now(): number;
  readRecords(): { scope: string; record: DataSourceRecord }[];
  runSync(input: ScheduledRunInput): Promise<ScheduledRunResult>;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  random(): number;
  disabled(): boolean;
  /** 生产环境提供进程级锁；测试可省略 */
  acquireLock?(): SchedulerLock | null;
}

export interface SchedulerLock {
  release(): void;
}

interface Candidate {
  scope: string;
  record: DataSourceRecord;
  next: NextRunResult;
}

function log(message: string): void {
  process.stderr.write(`[kisearch-scheduler] ${message}\n`);
}

function acquireSchedulerLock(dataDir: string): SchedulerLock | null {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    return null;
  }
  const file = path.join(dataDir, LOCK_NAME);
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        release: () => {
          try {
            const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string };
            if (owner.token === token) fs.unlinkSync(file);
          } catch { /* 其他进程不得删除当前持有者的锁 */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
        if (!Number.isInteger(owner.pid) || !owner.pid || owner.pid < 1) return null;
        try {
          process.kill(owner.pid, 0);
          return null; // 活进程持有
        } catch (killErr) {
          if ((killErr as NodeJS.ErrnoException).code !== 'ESRCH') return null;
        }
        const latest = fs.lstatSync(file);
        if (latest.ino !== stat.ino || latest.dev !== stat.dev) return null;
        fs.unlinkSync(file);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export class DataSourceScheduler {
  private readonly deps: DataSourceSchedulerDeps;
  private started = false;
  private disabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firing = false;
  private runningScope: string | null = null;
  private abortController: AbortController | null = null;
  private lock: SchedulerLock | null = null;
  private enabledSources = 0;
  private nextScope: string | null = null;
  private nextRunAt: number | null = null;
  private lastSkip: { scope: string; reason: string; at: number } | null = null;

  constructor(deps: DataSourceSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    if (this.deps.disabled()) {
      this.disabled = true;
      log('已通过 KI_DISABLE_DATASOURCE_SCHEDULER=1 关闭');
      return;
    }
    if (this.deps.acquireLock) {
      this.lock = this.deps.acquireLock();
      if (!this.lock) {
        log('未获取到调度锁（可能已有 daemon 在调度），本进程不启动调度');
        return;
      }
    }
    this.started = true;
    log('启动');
    this.refresh();
  }

  stop(): void {
    if (!this.started && !this.lock) return;
    this.started = false;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.runningScope = null;
    this.lock?.release();
    this.lock = null;
    log('停止');
  }

  refresh(): void {
    if (!this.started) return;
    if (this.runningScope !== null) return; // 运行结束后由 fire 的 finally 再 refresh
    this.clearTimer();
    let records: { scope: string; record: DataSourceRecord }[];
    try {
      records = this.deps.readRecords();
    } catch (err) {
      log(`读取计划失败，${READ_FAIL_RETRY_MS}ms 后重试：${(err as Error).message}`);
      this.arm(READ_FAIL_RETRY_MS, null, null);
      return;
    }
    const now = this.deps.now();
    const candidates: Candidate[] = [];
    for (const { scope, record } of records) {
      const schedule = record.schedule;
      if (!schedule?.enabled) continue;
      const next = computeNextRun({ schedule, lastSyncAt: record.lastSync?.at ?? null, now });
      if (next.nextRunAt === null) continue;
      candidates.push({ scope, record, next });
    }
    this.enabledSources = records.filter(({ record }) => record.schedule?.enabled).length;
    if (candidates.length === 0) {
      this.nextScope = null;
      this.nextRunAt = null;
      return;
    }
    candidates.sort((a, b) => (a.next.nextRunAt ?? 0) - (b.next.nextRunAt ?? 0));
    const first = candidates[0];
    this.nextScope = first.scope;
    this.nextRunAt = first.next.nextRunAt;
    this.armCandidate(first);
  }

  getState(): DataSourceSchedulerState {
    return {
      started: this.started,
      disabled: this.disabled,
      enabledSources: this.enabledSources,
      armed: this.timer !== null,
      runningScope: this.runningScope,
      nextScope: this.nextScope,
      nextRunAt: this.nextRunAt,
      lastSkip: this.lastSkip,
    };
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private arm(ms: number, scope: string | null, nextRunAt: number | null): void {
    this.clearTimer();
    this.nextScope = scope;
    this.nextRunAt = nextRunAt;
    const timer = this.deps.setTimer(() => { void this.fire(); }, Math.max(0, ms));
    timer.unref?.();
    this.timer = timer;
  }

  private armCandidate(candidate: Candidate): void {
    const now = this.deps.now();
    const target = candidate.next.nextRunAt ?? now;
    const base = Math.max(0, Math.min(target - now, MAX_TIMER_MS));
    const jitter = this.deps.random() * (candidate.next.due ? JITTER_DUE_MS : JITTER_FUTURE_MS);
    this.arm(base + Math.round(jitter), candidate.scope, target);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (!this.started || this.firing) return;
    if (this.runningScope !== null) {
      this.arm(SKIP_RETRY_MS, this.nextScope, this.nextRunAt);
      return;
    }
    this.firing = true;
    try {
      let records: { scope: string; record: DataSourceRecord }[];
      try {
        records = this.deps.readRecords();
      } catch (err) {
        log(`到期读取计划失败：${(err as Error).message}`);
        this.arm(READ_FAIL_RETRY_MS, this.nextScope, this.nextRunAt);
        return;
      }
      const now = this.deps.now();
      const due: Candidate[] = [];
      for (const { scope, record } of records) {
        if (scope === this.runningScope) continue;
        if (!record.schedule?.enabled) continue;
        const next = computeNextRun({ schedule: record.schedule, lastSyncAt: record.lastSync?.at ?? null, now });
        if (next.nextRunAt !== null && next.due) due.push({ scope, record, next });
      }
      if (due.length === 0) {
        this.refresh();
        return;
      }
      due.sort((a, b) => (a.next.nextRunAt ?? 0) - (b.next.nextRunAt ?? 0));
      const target = due[0];
      this.runningScope = target.scope;
      this.abortController = new AbortController();
      const config = loadConfig();
      const result = await this.deps.runSync({
        scope: target.scope,
        slot: target.next.occurrence,
        record: target.record,
        config,
        abortSignal: this.abortController.signal,
      });
      if (result.outcome === 'skipped') {
        this.lastSkip = { scope: target.scope, reason: result.reason ?? 'skipped', at: Date.now() };
        log(`跳过 ${target.scope}：${result.reason ?? 'skipped'}`);
      } else {
        log(`${target.scope} 完成：${result.outcome}（${result.durationMs ?? 0}ms）`);
      }
    } catch (err) {
      log(`执行失败：${(err as Error).message}`);
    } finally {
      this.firing = false;
      this.runningScope = null;
      this.abortController = null;
      this.refresh();
    }
  }

  /** 测试用：强制重置内部状态（不释放锁） */
  __resetForTest(): void {
    this.clearTimer();
    this.started = false;
    this.disabled = false;
    this.firing = false;
    this.runningScope = null;
    this.abortController = null;
    this.enabledSources = 0;
    this.nextScope = null;
    this.nextRunAt = null;
    this.lastSkip = null;
  }
}

const productionDeps: DataSourceSchedulerDeps = {
  now: () => Date.now(),
  readRecords: () => listRegisteredDataSourceRecords(loadConfig()),
  runSync: (input) => runScheduledSync(input),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  random: () => Math.random(),
  disabled: () => process.env.KI_DISABLE_DATASOURCE_SCHEDULER === '1',
  acquireLock: () => acquireSchedulerLock(loadConfig().dataDir),
};

let singleton: DataSourceScheduler | null = null;

function getSingleton(): DataSourceScheduler {
  if (!singleton) singleton = new DataSourceScheduler(productionDeps);
  return singleton;
}

/** 仅 HTTP daemon 调用；幂等 */
export function startDataSourceScheduler(): void {
  getSingleton().start();
}

export function stopDataSourceScheduler(): void {
  singleton?.stop();
}

/** 配置/同步完成后重算；未启动时无操作 */
export function refreshDataSourceScheduler(): void {
  singleton?.refresh();
}

export function getDataSourceSchedulerState(): DataSourceSchedulerState {
  return singleton?.getState() ?? {
    started: false,
    disabled: process.env.KI_DISABLE_DATASOURCE_SCHEDULER === '1',
    enabledSources: 0,
    armed: false,
    runningScope: null,
    nextScope: null,
    nextRunAt: null,
    lastSkip: null,
  };
}

export function isDataSourceSchedulerDisabled(): boolean {
  return process.env.KI_DISABLE_DATASOURCE_SCHEDULER === '1';
}

/** 测试辅助：替换单例并返回新实例 */
export function __createSchedulerForTest(deps: DataSourceSchedulerDeps): DataSourceScheduler {
  return new DataSourceScheduler(deps);
}
