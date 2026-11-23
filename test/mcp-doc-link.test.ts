/**
 * mcp-doc-link.test.ts —— 文档链接取址与拼装（REQ-20261123-003 · S-01）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-doc-link.test.ts
 *
 * 覆盖：webEnabled 关闭 / Host 推导 / publicUrl 显式覆盖（含子路径）/ 回环才采信
 *       X-Forwarded-Host / 通配地址归一 / 协议与前缀 / 中文与特殊字符编码 /
 *       根目录 __root__ / 非法输入不抛错 / 全局快照置位与复位。
 *
 * 注意：`mcp-runtime` 是**进程级单例**，与其它测试文件并行跑会互相污染；
 * 本文件除最后一组外一律用 `runtime` 参数注入，不用全局。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { docUrl, resolveBase, withUrl, type DocLinkContext } from '../src/lib/mcp-tools/doc-link.js';
import {
  getWebRuntime,
  normalizePublicUrl,
  resetWebRuntime,
  setWebRuntime,
  type WebRuntime,
} from '../src/lib/mcp-runtime.js';

const WEB: WebRuntime = { webEnabled: true, publicUrl: null };
const OFF: WebRuntime = { webEnabled: false, publicUrl: null };

const TARGET = {
  scope: 'monitor-memory',
  group: '项目踩坑点',
  relation: 'APIResource把ReadTimeout转成BKAPIError导致超时判定失效',
};

function ctx(headers: Record<string, string>): DocLinkContext {
  return { requestInfo: { headers } };
}

/** 解析出的 URL（断言用；失败直接让测试挂掉而不是静默） */
function parseDoc(url: string | undefined): URL {
  assert.ok(url, '期望生成链接，实际 undefined');
  return new URL(url);
}

describe('docUrl：基础取址', () => {
  it('webEnabled=false 时不产生链接（纯 stdio / 未开 --web）', () => {
    assert.equal(docUrl(TARGET, ctx({ host: '127.0.0.1:7433' }), OFF), undefined);
    assert.equal(docUrl(TARGET, ctx({ host: '127.0.0.1:7433' })), undefined, '默认快照也不应给链接');
  });

  it('按 Host 推导，并完整带回三个参数', () => {
    const u = parseDoc(docUrl(TARGET, ctx({ host: '127.0.0.1:7433' }), WEB));
    assert.equal(u.origin, 'http://127.0.0.1:7433');
    assert.equal(u.pathname, '/browse');
    assert.equal(u.searchParams.get('scope'), TARGET.scope);
    assert.equal(u.searchParams.get('group'), TARGET.group);
    assert.equal(u.searchParams.get('relation'), TARGET.relation);
  });

  it('没有 requestInfo / 没有 Host 时不产生链接', () => {
    assert.equal(docUrl(TARGET, {}, WEB), undefined);
    assert.equal(docUrl(TARGET, ctx({}), WEB), undefined);
  });

  it('通配绑定地址归一为 127.0.0.1，端口保留', () => {
    const u = parseDoc(docUrl(TARGET, ctx({ host: '0.0.0.0:7423' }), WEB));
    assert.equal(u.origin, 'http://127.0.0.1:7423');
  });
});

describe('docUrl：publicUrl 显式覆盖', () => {
  it('带子路径时不丢前缀（评审 B1 回归）', () => {
    const u = parseDoc(docUrl(TARGET, ctx({ host: '127.0.0.1:7423' }), {
      webEnabled: true,
      publicUrl: 'https://ki.example.com/ki',
    }));
    assert.equal(u.origin, 'https://ki.example.com');
    assert.equal(u.pathname, '/ki/browse');
  });

  it('配置优先于请求头（含反代头）', () => {
    const u = parseDoc(docUrl(TARGET, ctx({
      host: '127.0.0.1:7423',
      'x-forwarded-host': 'evil.example.com',
      'x-forwarded-prefix': '/wrong',
    }), { webEnabled: true, publicUrl: 'https://ki.example.com' }));
    assert.equal(u.origin, 'https://ki.example.com');
    assert.equal(u.pathname, '/browse');
  });
});

describe('docUrl：X-Forwarded-* 采信条件', () => {
  it('Host 是回环（同机反代）→ 采信 X-Forwarded-Host 与前缀', () => {
    const u = parseDoc(docUrl(TARGET, ctx({
      host: '127.0.0.1:7423',
      'x-forwarded-host': 'ki.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-prefix': '/ki',
    }), WEB));
    assert.equal(u.origin, 'https://ki.example.com');
    assert.equal(u.pathname, '/ki/browse');
  });

  it('Host 非回环 → 一律以 Host 为准（防止客户端自带转发头伪造域名）', () => {
    const u = parseDoc(docUrl(TARGET, ctx({
      host: '10.1.2.3:7433',
      'x-forwarded-host': 'evil.example.com',
    }), WEB));
    assert.equal(u.origin, 'http://10.1.2.3:7433');
  });

  it('只有 X-Forwarded-Host 时兜底使用它；非法前缀忽略', () => {
    const u = parseDoc(docUrl(TARGET, ctx({
      'x-forwarded-host': 'ki.example.com',
      'x-forwarded-prefix': 'ki',
    }), WEB));
    assert.equal(u.origin, 'http://ki.example.com');
    assert.equal(u.pathname, '/browse');
  });
});

describe('docUrl：编码与边界', () => {
  it('中文 / # / & / 空格 都能原样取回（URLSearchParams 编码）', () => {
    const tricky = { scope: 's1', group: 'a/b c', relation: 'Q#1 & 空格+plus' };
    const u = parseDoc(docUrl(tricky, ctx({ host: '127.0.0.1:7433' }), WEB));
    assert.equal(u.searchParams.get('group'), 'a/b c');
    assert.equal(u.searchParams.get('relation'), 'Q#1 & 空格+plus');
    // 分隔符没被关系名里的 & 破坏：仍然只有三个参数
    assert.deepEqual([...u.searchParams.keys()], ['scope', 'group', 'relation']);
  });

  it('根目录保留键 __root__ 原样输出', () => {
    const u = parseDoc(docUrl({ ...TARGET, group: '__root__' }, ctx({ host: '127.0.0.1:7433' }), WEB));
    assert.equal(u.searchParams.get('group'), '__root__');
  });

  it('目标字段缺失 / 非法 Host 时返回 undefined，不抛错', () => {
    assert.equal(docUrl({ scope: '', group: 'g', relation: 'r' }, ctx({ host: 'h:1' }), WEB), undefined);
    assert.equal(docUrl({ scope: 's', group: '', relation: 'r' }, ctx({ host: 'h:1' }), WEB), undefined);
    assert.equal(docUrl(TARGET, ctx({ host: 'not a host' }), WEB), undefined);
  });

  it('IPv6 回环加方括号后仍可解析', () => {
    const u = parseDoc(docUrl(TARGET, ctx({ host: '[::1]:7433' }), WEB));
    assert.equal(u.hostname, '[::1]');
    assert.equal(u.port, '7433');
  });
});

describe('withUrl / resolveBase', () => {
  it('url 为 undefined 时不新增字段', () => {
    const merged = withUrl({ ok: true, group: 'g' }, undefined);
    assert.deepEqual(merged, { ok: true, group: 'g' });
    assert.equal('url' in merged, false);
  });

  it('url 存在时原样附加，不覆盖既有字段', () => {
    const merged = withUrl({ ok: true }, 'http://h:1/browse');
    assert.deepEqual(merged, { ok: true, url: 'http://h:1/browse' });
  });

  it('resolveBase 拆出 base 与 basePath（base 恒无路径）', () => {
    assert.deepEqual(resolveBase(ctx({ host: '127.0.0.1:7433' }), WEB), {
      base: 'http://127.0.0.1:7433',
      basePath: '',
    });
    assert.deepEqual(resolveBase(ctx({}), { webEnabled: true, publicUrl: 'https://h/ki/' }), {
      base: 'https://h',
      basePath: '/ki',
    });
  });
});

describe('normalizePublicUrl', () => {
  it('去尾斜杠、保留子路径、丢弃 query 与 hash', () => {
    assert.equal(normalizePublicUrl('https://ki.example.com/ki/'), 'https://ki.example.com/ki');
    assert.equal(normalizePublicUrl('http://127.0.0.1:7433'), 'http://127.0.0.1:7433');
    assert.equal(normalizePublicUrl('https://h/ki/?a=1#x'), 'https://h/ki');
  });

  it('空值 / 非 http(s) / 非法串一律 null', () => {
    assert.equal(normalizePublicUrl(undefined), null);
    assert.equal(normalizePublicUrl('   '), null);
    assert.equal(normalizePublicUrl('ftp://h'), null);
    assert.equal(normalizePublicUrl('not a url'), null);
  });
});

describe('全局快照', () => {
  after(() => { resetWebRuntime(); });

  it('setWebRuntime 后 getWebRuntime 生效，reset 后回到默认', () => {
    setWebRuntime({ webEnabled: true, publicUrl: 'https://ki.example.com' });
    assert.deepEqual(getWebRuntime(), { webEnabled: true, publicUrl: 'https://ki.example.com' });
    resetWebRuntime();
    assert.deepEqual(getWebRuntime(), OFF);
  });
});
