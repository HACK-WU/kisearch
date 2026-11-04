/**
 * auth-security.test.ts —— 浏览器写请求安全基线（REQ-20261103-001 · S-06）
 *
 * 运行：npx jiti test/auth-security.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { checkRequestSecurity } from '../src/lib/auth/request-security.js';

function req(
  headers: Record<string, string>,
  method = 'POST',
): http.IncomingMessage {
  return { method, headers } as unknown as http.IncomingMessage;
}

const JSON_HEADERS = {
  host: '127.0.0.1:7423',
  origin: 'http://127.0.0.1:7423',
  'content-type': 'application/json; charset=utf-8',
  'content-length': '12',
};

describe('request-security', () => {
  it('同源 JSON 写请求放行', () => {
    assert.equal(checkRequestSecurity(req(JSON_HEADERS)), null);
  });

  it('同源无 body POST 放行（logout）', () => {
    const { 'content-length': _len, 'content-type': _ct, ...headers } = JSON_HEADERS;
    assert.equal(checkRequestSecurity(req(headers)), null);
  });

  it('跨站 Origin 拒绝', () => {
    const err = checkRequestSecurity(req({ ...JSON_HEADERS, origin: 'http://evil.com' }));
    assert.equal(err?.status, 403);
    assert.equal(err?.code, 'CSRF_ORIGIN_REJECTED');
  });

  it('Origin: null 拒绝', () => {
    assert.equal(checkRequestSecurity(req({ ...JSON_HEADERS, origin: 'null' }))?.status, 403);
  });

  it('无 Origin + Sec-Fetch-Site: cross-site 拒绝', () => {
    const { origin: _origin, ...headers } = JSON_HEADERS;
    const err = checkRequestSecurity(req({ ...headers, 'sec-fetch-site': 'cross-site' }));
    assert.equal(err?.status, 403);
  });

  it('无 Origin、无 Sec-Fetch-Site 视为非浏览器客户端，放行', () => {
    const { origin: _origin, ...headers } = JSON_HEADERS;
    assert.equal(checkRequestSecurity(req(headers)), null);
  });

  it('同 host 不同 port 拒绝', () => {
    assert.equal(
      checkRequestSecurity(req({ ...JSON_HEADERS, origin: 'http://127.0.0.1:8080' }))?.status,
      403,
    );
    assert.equal(
      checkRequestSecurity(req({ ...JSON_HEADERS, host: '127.0.0.1:8080' }))?.status,
      403,
    );
  });

  it('TLS 代理：Origin https 而 Host 无端口时放行', () => {
    assert.equal(
      checkRequestSecurity(req({
        ...JSON_HEADERS,
        host: 'example.com',
        origin: 'https://example.com',
      })),
      null,
    );
  });

  it('IPv6 同源放行', () => {
    assert.equal(
      checkRequestSecurity(req({
        ...JSON_HEADERS,
        host: '[::1]:7423',
        origin: 'http://[::1]:7423',
      })),
      null,
    );
  });

  it('有 body 但非 JSON Content-Type → 415', () => {
    const err = checkRequestSecurity(req({
      ...JSON_HEADERS,
      'content-type': 'text/plain',
    }));
    assert.equal(err?.status, 415);
    assert.equal(err?.code, 'UNSUPPORTED_CONTENT_TYPE');
  });

  it('GET / HEAD / OPTIONS 不校验 Origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(
        checkRequestSecurity(req({ ...JSON_HEADERS, origin: 'http://evil.com' }, method)),
        null,
      );
    }
  });
});
