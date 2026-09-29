import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

describe('CLI 向量任务登记', () => {
  it('直连 CLI 的 FTS-only 成功与 embedding 故障都会落任务终态并正常退出', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vector-task-cli-'));
    try {
      const source = path.join(root, 'source');
      const dataDir = path.join(root, 'data');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'cli-check.md'), '# CLI task check\n\nTemporary isolated CLI verification.');
      const configPath = path.join(root, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        dataDir,
        vectorDir: path.join(root, 'vector'),
        backupDir: path.join(root, 'backup'),
        scopeMode: 'default',
        scopes: { default: {} },
        embedding: {
          provider: 'siliconflow',
          baseURL: 'http://127.0.0.1:1/v1',
          model: 'test-model',
          dimension: 3,
          apiKey: 'test-only',
          scheduler: { requestTimeoutMs: 1000 },
        },
      }));

      const env = { ...process.env, KI_CONFIG_PATH: configPath, KI_DAEMON_OWNER: '1', NODE_NO_WARNINGS: '1' };
      delete env.KI_DAEMON_CLIENT;
      delete env.NODE_OPTIONS;
      delete env.BASH_ENV;
      for (const key of Object.keys(env)) {
        if (key.startsWith('CODEBUDDY_SAFE_DELETE')) delete env[key];
      }
      const jitiCli = path.join(PROJECT_ROOT, 'node_modules/jiti/lib/jiti-cli.mjs');
      const runImport = (vector: boolean) => spawnSync(process.execPath, [
        jitiCli,
        'src/import.ts',
        '--source', source,
        '--scope', 'default',
        '--group', 'cli-check',
        '--no-assets',
        ...(!vector ? ['--no-vector'] : []),
      ], {
        cwd: PROJECT_ROOT,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      const noVector = runImport(false);
      assert.equal(noVector.status, 0, `--no-vector CLI should exit successfully: ${noVector.stderr}\n${noVector.stdout}`);
      const vectorFailure = runImport(true);
      assert.equal(vectorFailure.status, 1, `unreachable embedding service should fail: ${vectorFailure.stderr}\n${vectorFailure.stdout}`);

      const taskDir = path.join(dataDir, '.ki-tasks');
      const tasks = fs.readdirSync(taskDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8')) as {
          operation: string;
          source: string;
          scope: string;
          state: string;
          error?: string;
        });
      assert.ok(tasks.some((task) => task.operation === 'import' && task.source === 'cli' && task.scope === 'default' && task.state === 'succeeded'));
      const failedTask = tasks.find((task) => task.operation === 'import' && task.source === 'cli' && task.scope === 'default' && task.state === 'failed');
      assert.ok(failedTask, 'embedding failure must remain visible as a failed task');
      assert.doesNotMatch(failedTask.error ?? '', /test-only|api[_ -]?key|token/i, 'task summary must not expose credential values');

      const lockDir = path.join(dataDir, '.ki-scope-locks');
      fs.mkdirSync(lockDir, { recursive: true });
      const lockFile = path.join(lockDir, `${crypto.createHash('sha256').update('default').digest('hex')}.lock`);
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'test-owner' }));
      const blocked = runImport(false);
      assert.equal(blocked.status, 1, '另一个进程持有 scope 写锁时必须拒绝导入');
      assert.match(blocked.stdout + blocked.stderr, /SCOPE_OPERATION_BUSY|已有导入或还原任务/);
      const blockedRebuild = spawnSync(process.execPath, [jitiCli, 'src/restore.ts', 'default', '--rebuild-vector', '--yes'], {
        cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(blockedRebuild.status, 1, '同 scope 重建也必须遵守跨进程写锁');
      assert.match(blockedRebuild.stdout + blockedRebuild.stderr, /SCOPE_OPERATION_BUSY|已有导入或还原任务/);
      fs.unlinkSync(lockFile);
      const resumed = runImport(false);
      assert.equal(resumed.status, 0, '写锁释放后应允许导入');

      const missingSnapshot = spawnSync(process.execPath, [jitiCli, 'src/restore.ts', 'default', '--from-snapshot', '--rebuild-vector', '--yes'], {
        cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(missingSnapshot.status, 1);
      const afterRestore = fs.readdirSync(taskDir).filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8')) as { operation: string; state: string });
      assert.ok(afterRestore.some((task) => task.operation === 'restore-snapshot+rebuild-vector' && task.state === 'failed'),
        '快照预检失败也应登记失败终态');
      assert.equal(fs.existsSync(lockFile), false, '失败后应释放 scope 写锁');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
