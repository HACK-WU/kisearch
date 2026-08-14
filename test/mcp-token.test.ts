/**
 * mcp-token.test.ts —— 多 Token 存储 + scope 授权模块单元测试
 *
 * 覆盖：强随机生成、短 ID、scope 参数解析、Token 的增/删/改/查、
 * 按明文查授权 scope（常量时间比较）、文件权限 0600。
 * 运行：node node_modules/jiti/lib/jiti-cli.mjs test/mcp-token.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  generateTokenValue,
  generateShortId,
  resolveScopesArg,
  createToken,
  listTokens,
  listTokensStrict,
  updateTokenScopes,
  deleteToken,
  findTokenScopes,
  tokenCount,
  getTokensPath,
  isScopeAuthorized,
  ALL_SCOPES,
} from '../src/lib/mcp-token.js';

let tmpDir: string;
let tokensPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-mcp-tokens-'));
  tokensPath = path.join(tmpDir, 'mcp-tokens.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateTokenValue', () => {
  it('生成 base64url 强随机值（32 字节熵，约 43 字符）', () => {
    const t = generateTokenValue();
    assert.match(t, /^[A-Za-z0-9_-]{40,}$/);
  });

  it('多次生成互不相同', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateTokenValue()));
    assert.equal(seen.size, 20);
  });
});

describe('generateShortId', () => {
  it('生成 8 位短 ID（不含易混淆字符）', () => {
    const id = generateShortId();
    assert.match(id, /^[a-zA-Z0-9]{8}$/);
    assert.ok(!/[0O1lI]/.test(id));
  });

  it('多次生成基本不重复', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateShortId()));
    assert.equal(seen.size, 50);
  });
});

describe('resolveScopesArg', () => {
  it('单个 scope', () => {
    assert.deepEqual(resolveScopesArg('team-a'), ['team-a']);
  });

  it('多个逗号分隔', () => {
    assert.deepEqual(resolveScopesArg('team-a, team-b'), ['team-a', 'team-b']);
  });

  it("'all' 归一化为 ['all']", () => {
    assert.deepEqual(resolveScopesArg('all'), [ALL_SCOPES]);
  });

  it("含 'all' 时忽略其余冗余值", () => {
    assert.deepEqual(resolveScopesArg('all,team-a'), [ALL_SCOPES]);
  });

  it('空字符串抛错', () => {
    assert.throws(() => resolveScopesArg('  '), /必须指定 scope/);
  });

  it('非法字符抛错', () => {
    assert.throws(() => resolveScopesArg('team/a'), /不合法/);
  });
});

describe('createToken / listTokens', () => {
  it('创建返回 id + token 明文 + scopes，并落盘（权限 0600）', () => {
    const r = createToken(['team-a'], tokensPath);
    assert.match(r.id, /^[a-zA-Z0-9]{8}$/);
    assert.match(r.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(r.scopes, ['team-a']);
    assert.ok(r.createdAt && !Number.isNaN(Date.parse(r.createdAt)));

    const mode = fs.statSync(tokensPath).mode & 0o777;
    assert.equal(mode, 0o600);

    const records = listTokens(tokensPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, r.id);
  });

  it('多条记录 id 互不相同', () => {
    const a = createToken(['a'], tokensPath);
    const b = createToken(['b'], tokensPath);
    assert.notEqual(a.id, b.id);
    assert.equal(listTokens(tokensPath).length, 2);
  });

  it('文件不存在时 listTokens 返回 []', () => {
    assert.deepEqual(listTokens(tokensPath), []);
  });
});

describe('updateTokenScopes', () => {
  it('按 id 更新 scope 并落盘', () => {
    const r = createToken(['a'], tokensPath);
    const updated = updateTokenScopes(r.id, ['a', 'b'], tokensPath);
    assert.deepEqual(updated.scopes, ['a', 'b']);
    assert.equal(listTokens(tokensPath)[0].scopes[1], 'b');
  });

  it('不存在的 id 抛 TOKEN_NOT_FOUND', () => {
    assert.throws(
      () => updateTokenScopes('nope1234', ['a'], tokensPath),
      (err: Error & { code?: string }) => err.code === 'TOKEN_NOT_FOUND',
    );
  });
});

describe('deleteToken', () => {
  it('按 id 删除', () => {
    const r = createToken(['a'], tokensPath);
    deleteToken(r.id, tokensPath);
    assert.equal(listTokens(tokensPath).length, 0);
  });

  it('不存在的 id 抛 TOKEN_NOT_FOUND', () => {
    assert.throws(
      () => deleteToken('nope1234', tokensPath),
      (err: Error & { code?: string }) => err.code === 'TOKEN_NOT_FOUND',
    );
  });
});

describe('原子写（无 .tmp 残留）', () => {
  it('createToken 后目录无 .tmp 临时文件残留', () => {
    createToken(['a'], tokensPath);
    createToken(['b'], tokensPath);
    const files = fs.readdirSync(path.dirname(tokensPath));
    const leftovers = files.filter((f) => f.includes('.mcp-tokens.') && f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '原子写后不应残留 .tmp 临时文件');
  });

  it('update/delete 后同样无残留', () => {
    const r = createToken(['a'], tokensPath);
    updateTokenScopes(r.id, ['a', 'b'], tokensPath);
    deleteToken(r.id, tokensPath);
    const files = fs.readdirSync(path.dirname(tokensPath));
    const leftovers = files.filter((f) => f.includes('.mcp-tokens.') && f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('写入后文件内容完整（非半写损坏）', () => {
    const r = createToken(['a'], tokensPath);
    const raw = fs.readFileSync(tokensPath, 'utf-8');
    assert.ok(raw.trim().endsWith(']'), '文件应为完整 JSON（以 ] 结尾）');
    assert.ok(JSON.parse(raw).length === 1);
    assert.equal(JSON.parse(raw)[0].id, r.id);
  });
});

describe('findTokenScopes', () => {
  it('命中返回 scopes，未命中返回 undefined', () => {
    const r = createToken(['team-a', 'team-b'], tokensPath);
    assert.deepEqual(findTokenScopes(r.token, tokensPath), ['team-a', 'team-b']);
    assert.equal(findTokenScopes('wrong-token', tokensPath), undefined);
  });

  it("'all' scope 正确返回", () => {
    const r = createToken([ALL_SCOPES], tokensPath);
    assert.deepEqual(findTokenScopes(r.token, tokensPath), [ALL_SCOPES]);
  });
});

describe('tokenCount', () => {
  it('统计记录数量', () => {
    assert.equal(tokenCount(tokensPath), 0);
    createToken(['a'], tokensPath);
    createToken(['b'], tokensPath);
    assert.equal(tokenCount(tokensPath), 2);
  });
});

describe('isScopeAuthorized', () => {
  it('null = 免鉴权，全部放行', () => {
    assert.equal(isScopeAuthorized(null, 'any-scope'), true);
  });

  it("'all' 通配全部 scope", () => {
    assert.equal(isScopeAuthorized([ALL_SCOPES], 'anything'), true);
  });

  it('授权集合内放行，集合外拒绝', () => {
    assert.equal(isScopeAuthorized(['team-a'], 'team-a'), true);
    assert.equal(isScopeAuthorized(['team-a'], 'team-b'), false);
  });

  it('多 scope 授权', () => {
    assert.equal(isScopeAuthorized(['team-a', 'team-b'], 'team-b'), true);
    assert.equal(isScopeAuthorized(['team-a', 'team-b'], 'team-c'), false);
  });
});

describe('listTokensStrict（文件损坏保护）', () => {
  it('损坏文件抛 MCP_TOKEN_CORRUPT', () => {
    fs.writeFileSync(tokensPath, '{broken json', 'utf-8');
    assert.throws(
      () => listTokensStrict(tokensPath),
      (err: Error & { code?: string }) => err.code === 'MCP_TOKEN_CORRUPT',
    );
  });

  it('损坏文件时 createToken 拒绝覆盖（抛错且原文件内容不变）', () => {
    const original = '{broken json';
    fs.writeFileSync(tokensPath, original, 'utf-8');
    assert.throws(
      () => createToken(['a'], tokensPath),
      (err: Error & { code?: string }) => err.code === 'MCP_TOKEN_CORRUPT',
    );
    // 原文件内容未被覆盖（防数据丢失）
    assert.equal(fs.readFileSync(tokensPath, 'utf-8'), original);
  });

  it('损坏文件时 update/delete 也拒绝写回', () => {
    fs.writeFileSync(tokensPath, '{broken json', 'utf-8');
    assert.throws(
      () => updateTokenScopes('id123456', ['a'], tokensPath),
      (err: Error & { code?: string }) => err.code === 'MCP_TOKEN_CORRUPT',
    );
    assert.throws(
      () => deleteToken('id123456', tokensPath),
      (err: Error & { code?: string }) => err.code === 'MCP_TOKEN_CORRUPT',
    );
  });

  it('宽松 listTokens 损坏时返回 []（鉴权 fail-closed，不崩溃）', () => {
    fs.writeFileSync(tokensPath, '{broken json', 'utf-8');
    assert.deepEqual(listTokens(tokensPath), []);
  });

  it('正常文件 listTokensStrict 返回记录（不误报损坏）', () => {
    createToken(['a'], tokensPath);
    assert.equal(listTokensStrict(tokensPath).length, 1);
  });
});

describe('getTokensPath', () => {
  it('默认路径位于 ~/.ki/mcp-tokens.json（与 lock 文件同目录）', () => {
    assert.equal(getTokensPath(), path.join(os.homedir(), '.ki', 'mcp-tokens.json'));
  });
});
