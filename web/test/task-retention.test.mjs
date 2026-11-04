/**
 * 任务台账保留期文案单测（2026-11-02：保留期 1 小时 → 7 天）
 *
 * 背景：这次调整前，保留期以字面量散落在任务页副标题、详情错误态、「重试自」提示三处，
 * 后端改常量时前端三处全部变成谎话；而接口里的 `retainedForMs` 当时**零消费方**。
 * 本用例锁住「文案只来自接口」这条口径：
 *   1) `formatRetention` 的档位与非法值降级；
 *   2) `buildTaskDetail` 的「重试自」阈值跟随传入的 `retainedForMs`；
 *   3) 源码守卫：前端不得再写死「保留 1 小时 / 7 天」。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { formatRetention } = await vite.ssrLoadModule('/src/lib/taskRetention.ts');
const { buildTaskDetail } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');

after(async () => { await vite.close(); });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_790_000_000_000;

function retryTask() {
  return {
    id: 'abcdef1234567890',
    source: 'web',
    operation: 'import',
    scope: 'default',
    state: 'failed',
    createdAt: NOW,
    updatedAt: NOW,
    heartbeatAt: NOW,
    retryOf: '1234567890abcdef',
    params: { sourceKind: 'external' },
  };
}

function retryOfRow(view) {
  return view.params.find((row) => row.label === '重试自');
}

describe('formatRetention', () => {
  it('整单位走天 / 小时 / 分钟，当前口径 7 天', () => {
    assert.equal(formatRetention(7 * DAY), '7 天');
    assert.equal(formatRetention(DAY), '1 天');
    assert.equal(formatRetention(HOUR), '1 小时');
    assert.equal(formatRetention(6 * HOUR), '6 小时');
    assert.equal(formatRetention(90 * 60 * 1000), '90 分钟');
  });

  it('非法 / 缺失返回 null，让调用方省略数字而不是猜一个', () => {
    assert.equal(formatRetention(undefined), null);
    assert.equal(formatRetention(null), null);
    assert.equal(formatRetention(0), null);
    assert.equal(formatRetention(-1), null);
    assert.equal(formatRetention(Number.NaN), null);
    assert.equal(formatRetention(Number.POSITIVE_INFINITY), null);
  });

  it('不足一分钟不四舍五入成「0 分钟」', () => {
    assert.equal(formatRetention(30 * 1000), '不足 1 分钟');
  });
});

describe('重试自提示跟随接口口径', () => {
  it('传入 retainedForMs 时写明具体时长', () => {
    const row = retryOfRow(buildTaskDetail(retryTask(), 7 * DAY));
    assert.equal(row.hint, '原任务保留 7 天，可能已清理');
  });

  it('缺省时只说「可能已清理」，不落任何具体数字', () => {
    const row = retryOfRow(buildTaskDetail(retryTask()));
    assert.equal(row.hint, '原任务可能已清理');
    assert.doesNotMatch(row.hint, /\d/, '拿不到 authoritative 口径时不得编数字');
  });
});

describe('源码守卫', () => {
  it('任务页与详情模型不再硬编码保留期', () => {
    const files = [
      path.join(webRoot, 'src/pages/TasksPage.tsx'),
      path.join(webRoot, 'src/lib/taskDetailModel.ts'),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /保留 1 小时|保留 7 天/, `${path.basename(file)} 仍在硬编码保留期`);
    }
  });

  // CLI 帮助文本拿不到接口口径，只能写字面量；上面那条守卫查不到 bin/ki.mjs，
  // 所以用 TASK_TTL_MS 反算天数把它锁住，避免后端改常量后 `ki --help` 又变成谎话
  it('CLI help 的保留期与 TASK_TTL_MS 一致', () => {
    const registry = fs.readFileSync(path.join(webRoot, '../src/lib/task-registry.ts'), 'utf8');
    const ttl = registry.match(/export const TASK_TTL_MS\s*=\s*([^;]+);/);
    assert.ok(ttl, '未能从 task-registry.ts 解析出 TASK_TTL_MS');
    const days = Math.round(Function(`return (${ttl[1]});`)() / DAY);
    assert.ok(days > 0, `TASK_TTL_MS 反算天数异常：${days}`);

    const cli = fs.readFileSync(path.join(webRoot, '../bin/ki.mjs'), 'utf8');
    const logLine = cli.split('\n').find((line) => /\blog\s+任务运行诊断/.test(line));
    assert.ok(logLine, 'bin/ki.mjs 中未找到 log 命令的 help 行');
    const declared = logLine.match(/台账保留\s*(\d+)\s*天/);
    assert.ok(declared, `log help 未声明「台账保留 N 天」：${logLine.trim()}`);
    assert.equal(Number(declared[1]), days, `log help 写的是 ${declared[1]} 天，但 TASK_TTL_MS 是 ${days} 天`);
  });
});
