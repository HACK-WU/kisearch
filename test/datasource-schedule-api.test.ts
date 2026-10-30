/**
 * S-01：POST /api/datasource/schedule + list/detail 下发。
 * 运行：npx jiti test/datasource-schedule-api.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { addDataSource, readDataSource } from '../src/lib/datasource.js';
import { closeFtsEngine } from '../src/lib/fts-client.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-sched-api-'));
process.env.HOME = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'config.json');
fs.writeFileSync(process.env.KI_CONFIG_PATH, JSON.stringify({
  scopeMode: 'default',
  embedding: { provider: 'mock', model: 'mock' },
}), 'utf8');
resetConfigCache();

const scope = 'sched-api';
let base = '';
let closeServer: (() => Promise<void>) | null = null;
let sourceDir = '';

function buildStubServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

async function call(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    buildServer: buildStubServer,
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  closeServer = async () => {
    await closeAllSessions();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  sourceDir = path.join(tmpHome, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'a.md'), '# a\n');
  const added = await addDataSource({ scope, dir: sourceDir, config: loadConfig() });
  assert.equal(added.ok, true);
});

after(async () => {
  await closeServer?.();
  try { await closeFtsEngine(); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('POST /api/datasource/schedule', () => {
  it('保存周期计划 → 200，list/detail 下发 schedule', async () => {
    const saved = await call('/api/datasource/schedule', {
      method: 'POST',
      body: JSON.stringify({
        scope,
        schedule: { enabled: true, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', at: null, repeat: null },
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.schedule.enabled, true);
    assert.equal(saved.body.schedule.revision, 1);
    assert.equal(typeof saved.body.nextRunAt, 'number');
    assert.equal(saved.body.schedulerDisabled, false);

    const list = await call('/api/datasource/list');
    assert.equal(list.status, 200);
    const row = list.body.sources.find((item: any) => item.scope === scope);
    assert.ok(row);
    assert.equal(row.schedule.enabled, true);
    assert.equal(typeof row.schedule.nextRunAt, 'number');

    const detail = await call(`/api/datasource/detail?scope=${scope}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.source.schedule.enabled, true);
  });

  it('非法间隔 → 400 且文件不变', async () => {
    const before = readDataSource(scope);
    assert.equal(before.ok, true);
    const res = await call('/api/datasource/schedule', {
      method: 'POST',
      body: JSON.stringify({
        scope,
        schedule: { enabled: true, mode: 'interval', intervalValue: 0, intervalUnit: 'minute', at: null, repeat: null },
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.details.field, 'interval');
    const afterRead = readDataSource(scope);
    assert.equal(afterRead.ok, true);
    if (!before.ok || !afterRead.ok) return;
    assert.equal(afterRead.record.schedule.revision, before.record.schedule.revision);
  });

  it('baseRevision 失配 → 409 SCHEDULE_STALE', async () => {
    const res = await call('/api/datasource/schedule', {
      method: 'POST',
      body: JSON.stringify({
        scope,
        schedule: {
          enabled: true, mode: 'interval', intervalValue: 60, intervalUnit: 'minute',
          at: null, repeat: null, baseRevision: 0,
        },
      }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SCHEDULE_STALE');
  });

  it('关闭保存 → enabled=false，值保留', async () => {
    const res = await call('/api/datasource/schedule', {
      method: 'POST',
      body: JSON.stringify({
        scope,
        schedule: {
          enabled: false, mode: 'interval', intervalValue: 30, intervalUnit: 'minute',
          at: null, repeat: null, baseRevision: 1,
        },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.enabled, false);
    assert.equal(res.body.schedule.intervalValue, 30);
    assert.equal(res.body.schedule.revision, 2);
    assert.equal(res.body.nextRunAt, null);
  });

  it('未登记 scope → 404', async () => {
    const res = await call('/api/datasource/schedule', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'not-registered',
        schedule: { enabled: false, mode: 'interval' },
      }),
    });
    assert.equal(res.status, 404);
  });
});
