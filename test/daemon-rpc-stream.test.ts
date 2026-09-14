import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

interface RpcFrame {
  ok?: boolean;
  type?: string;
  final?: boolean;
  jobId?: string;
  eventSeq?: number;
  result?: unknown;
  job?: { state: string; jobId: string };
  state?: string;
  error?: { code?: string; message?: string };
}

function rpc(socketPath: string, request: object): Promise<RpcFrame[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const frames: RpcFrame[] = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const frame = JSON.parse(buffer.slice(0, index)) as RpcFrame;
        buffer = buffer.slice(index + 1);
        frames.push(frame);
        if (frame.final || frame.job !== undefined || frame.state !== undefined || (frame.ok !== undefined && frame.type === undefined)) {
          socket.end();
          resolve(frames);
          return;
        }
      }
    });
    socket.on('error', reject);
  });
}

test('daemon RPC streaming progress/status and pre-execute cancel tombstone', async () => {
  const originalHome = process.env.HOME;
  const originalConfig = process.env.KI_CONFIG_PATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-daemon-rpc-'));
  const configPath = path.join(home, 'config.yaml');
  fs.writeFileSync(configPath, [
    `dataDir: ${path.join(home, 'kb')}`,
    `vectorDir: ${path.join(home, 'vector')}`,
    `backupDir: ${path.join(home, 'backup')}`,
    'scopes:',
    '  default: {}',
  ].join('\n'));
  process.env.HOME = home;
  process.env.KI_CONFIG_PATH = configPath;

  try {
    const { startDaemonRpcServer } = await import('../src/lib/daemon-rpc.js');
    const { getDaemonSocketPath } = await import('../src/lib/daemon-protocol.js');
    const server = await startDaemonRpcServer();
    try {
      const jobId = `rpc-stream-${Date.now()}`;
      const frames = await rpc(getDaemonSocketPath(), {
        id: 'execute-1',
        method: 'execute',
        operation: 'scope-list',
        params: {},
        jobId,
        streamProgress: true,
      });
      const final = frames.at(-1)!;
      assert.equal(final.ok, true);
      assert.equal(final.final, true);
      assert.equal(final.jobId, jobId);
      const status = (await rpc(getDaemonSocketPath(), { id: 'status-1', method: 'status', jobId }))[0];
      assert.equal(status.ok, true);
      assert.equal(status.job?.state, 'succeeded');

      const cancelledId = `rpc-cancel-before-${Date.now()}`;
      const cancel = (await rpc(getDaemonSocketPath(), { id: 'cancel-1', method: 'cancel', jobId: cancelledId }))[0];
      assert.equal(cancel.ok, true);
      assert.equal(cancel.state, 'pending');
      const cancelled = (await rpc(getDaemonSocketPath(), {
        id: 'execute-2', method: 'execute', operation: 'scope-list', params: {},
        jobId: cancelledId, streamProgress: true,
      })).at(-1)!;
      assert.equal(cancelled.ok, true);
      assert.deepEqual(cancelled.result, {
        cancelled: true,
        jobId: cancelledId,
        reason: 'cancel requested before execute registration',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfig === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = originalConfig;
  }
});
