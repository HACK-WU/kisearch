/**
 * 「MCP 端口」显示口径单测（2026-10-28）
 *
 * 背景：侧栏页脚曾写死 `MCP 7423`，用户换到 7433 后仍显示 7423（指向不存在的地址）。
 * 本测试锁住动态口径：
 *   1) 端口归一化（数字 / 空格 / 非法值 / 越界）；
 *   2) 协议默认端口；
 *   3) 回环访问（dev :5173 代理 / preview :4173 预览 / 本机生产）以 /healthz 的 daemon 端口为准；
 *      其他设备与反向代理以地址栏为准；两者都失败时回落协议默认；
 *   4) 任何输入都不会凭空产生 `7423`，也永不返回 `undefined` / 空串。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
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
const { defaultPortFor, normalizePort, resolveMcpPort } = await vite.ssrLoadModule('/src/lib/daemonPort.ts');
after(async () => vite.close());

describe('normalizePort', () => {
  it('接受数字与数字字符串，统一成字符串', () => {
    assert.equal(normalizePort(7433), '7433');
    assert.equal(normalizePort('7433'), '7433');
    assert.equal(normalizePort('  7433  '), '7433');
    assert.equal(normalizePort(80), '80');
  });

  it('空值 / 非数字 / 越界一律 null（交给下一级证据回落）', () => {
    for (const bad of [null, undefined, '', '   ', 'abc', '74a3', '0', '65536', '-1', '7433.5', NaN]) {
      assert.equal(normalizePort(bad), null, String(bad));
    }
  });
});

describe('defaultPortFor', () => {
  it('https 缺省 443，其余 80', () => {
    assert.equal(defaultPortFor('https:'), '443');
    assert.equal(defaultPortFor('HTTPS:'), '443');
    assert.equal(defaultPortFor('http:'), '80');
    assert.equal(defaultPortFor(''), '80');
    assert.equal(defaultPortFor(null), '80');
  });
});

describe('resolveMcpPort · 回环（dev / preview / 本机生产）', () => {
  it('dev：页面端口 5173 不代表 daemon，取 /healthz 的真实端口', () => {
    assert.equal(resolveMcpPort({ locationPort: '5173', healthzPort: 7433, protocol: 'http:', isLoopback: true }), '7433');
    assert.equal(resolveMcpPort({ locationPort: '5173', healthzPort: 7499, protocol: 'http:', isLoopback: true }), '7499');
  });

  it('preview：生产构建 + :4173 预览 dist，同样以 daemon 端口为准（不是 4173）', () => {
    assert.equal(resolveMcpPort({ locationPort: '4173', healthzPort: 7423, protocol: 'http:', isLoopback: true }), '7423');
  });

  it('生产自服务：页面端口 = daemon 端口，两者一致', () => {
    assert.equal(resolveMcpPort({ locationPort: '7433', healthzPort: 7433, protocol: 'http:', isLoopback: true }), '7433');
  });

  it('/healthz 不可用时回落页面端口，再回落协议默认', () => {
    assert.equal(resolveMcpPort({ locationPort: '5173', healthzPort: undefined, protocol: 'http:', isLoopback: true }), '5173');
    assert.equal(resolveMcpPort({ locationPort: '', healthzPort: null, protocol: 'http:', isLoopback: true }), '80');
  });
});

describe('resolveMcpPort · 其他设备 / 反向代理（非回环）', () => {
  it('地址栏有端口时以地址栏为准（外部实际可达入口）', () => {
    assert.equal(resolveMcpPort({ locationPort: '7433', healthzPort: 7433, protocol: 'http:', isLoopback: false }), '7433');
    // 反向代理：外部 8080 → daemon 7423，用户应从 8080 连
    assert.equal(resolveMcpPort({ locationPort: '8080', healthzPort: 7423, protocol: 'http:', isLoopback: false }), '8080');
  });

  it('地址栏省略端口时回落 /healthz，再回落协议默认', () => {
    assert.equal(resolveMcpPort({ locationPort: '', healthzPort: 7423, protocol: 'http:', isLoopback: false }), '7423');
    assert.equal(resolveMcpPort({ locationPort: '', healthzPort: undefined, protocol: 'http:', isLoopback: false }), '80');
    assert.equal(resolveMcpPort({ locationPort: '', healthzPort: undefined, protocol: 'https:', isLoopback: false }), '443');
  });

  it('/healthz 失败（缺 port）时仍给出地址栏端口，不留空', () => {
    assert.equal(resolveMcpPort({ locationPort: '7433', healthzPort: undefined, protocol: 'http:', isLoopback: false }), '7433');
  });
});

describe('resolveMcpPort · 回归（不硬编码 7423）', () => {
  it('只有 /healthz 真是 7423 时才出现 7423', () => {
    const probes = [
      { locationPort: '7433', protocol: 'http:', isLoopback: false },
      { locationPort: '7433', protocol: 'http:', isLoopback: true },
      { locationPort: '', healthzPort: 8765, protocol: 'http:', isLoopback: false },
      { locationPort: '5173', healthzPort: 9000, protocol: 'http:', isLoopback: true },
      { locationPort: '4173', healthzPort: 7499, protocol: 'http:', isLoopback: true },
      { locationPort: '', protocol: 'https:', isLoopback: false },
    ];
    for (const probe of probes) {
      assert.notEqual(resolveMcpPort(probe), '7423', JSON.stringify(probe));
    }
    assert.equal(resolveMcpPort({ locationPort: '', healthzPort: 7423, protocol: 'http:', isLoopback: false }), '7423');
  });

  it('任何输入都返回非空端口字符串（不出现 undefined / NaN）', () => {
    const probes = [
      {},
      { locationPort: null, healthzPort: null },
      { locationPort: 'abc', healthzPort: 'x', protocol: 'file:' },
      { locationPort: '7433', healthzPort: 7433, protocol: 'https:', isLoopback: true },
    ];
    for (const probe of probes) {
      const port = resolveMcpPort(probe);
      assert.match(port, /^\d+$/, JSON.stringify(probe));
    }
  });
});
