/**
 * mcp-token.test.ts —— 托管 Token 模块单元测试
 *
 * 覆盖：强随机生成、独占创建（已存在拒绝覆盖）、读取、重置轮换、
 * 元信息（不回显明文）、文件权限 0600。
 * 运行：node node_modules/jiti/lib/jiti-cli.mjs test/mcp-token.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  generateTokenValue,
  createManagedToken,
  resetManagedToken,
  readManagedToken,
  managedTokenInfo,
  getManagedTokenPath,
} from '../src/lib/mcp-token.js';

let tmpDir: string;
let tokenPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-mcp-token-'));
  tokenPath = path.join(tmpDir, 'mcp-token');
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

describe('createManagedToken', () => {
  it('首次创建：落盘内容与返回值一致，权限 0600', () => {
    const { token, path: p } = createManagedToken(tokenPath);
    assert.equal(p, tokenPath);
    assert.equal(fs.readFileSync(tokenPath, 'utf-8').trim(), token);
    const mode = fs.statSync(tokenPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('已存在时拒绝覆盖：抛 MCP_TOKEN_EXISTS 且文件内容不变', () => {
    const { token: first } = createManagedToken(tokenPath);
    assert.throws(
      () => createManagedToken(tokenPath),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'MCP_TOKEN_EXISTS');
        assert.match(err.message, /已存在/);
        assert.match(err.message, /token reset --yes/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(tokenPath, 'utf-8').trim(), first);
  });

  it('父目录不存在时自动创建', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'mcp-token');
    const { token } = createManagedToken(nested);
    assert.equal(fs.readFileSync(nested, 'utf-8').trim(), token);
  });
});

describe('readManagedToken', () => {
  it('读取已托管的 Token', () => {
    const { token } = createManagedToken(tokenPath);
    assert.equal(readManagedToken(tokenPath), token);
  });

  it('文件不存在返回 undefined', () => {
    assert.equal(readManagedToken(tokenPath), undefined);
  });

  it('空白内容返回 undefined（不当作有效凭据）', () => {
    fs.writeFileSync(tokenPath, '  \n');
    assert.equal(readManagedToken(tokenPath), undefined);
  });
});

describe('resetManagedToken', () => {
  it('轮换生成新值并覆盖旧值，权限保持 0600', () => {
    const { token: oldToken } = createManagedToken(tokenPath);
    const { token: newToken } = resetManagedToken(tokenPath);
    assert.notEqual(newToken, oldToken);
    assert.equal(fs.readFileSync(tokenPath, 'utf-8').trim(), newToken);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  });

  it('无既有文件时也可直接重置（等价于生成）', () => {
    const { token } = resetManagedToken(tokenPath);
    assert.equal(readManagedToken(tokenPath), token);
  });
});

describe('managedTokenInfo', () => {
  it('存在时报告 exists + createdAt，且不含明文', () => {
    const { token } = createManagedToken(tokenPath);
    const info = managedTokenInfo(tokenPath);
    assert.equal(info.exists, true);
    assert.equal(info.path, tokenPath);
    assert.ok(info.createdAt && !Number.isNaN(Date.parse(info.createdAt)));
    assert.ok(!JSON.stringify(info).includes(token));
  });

  it('不存在时报告 exists:false', () => {
    const info = managedTokenInfo(tokenPath);
    assert.equal(info.exists, false);
  });
});

describe('getManagedTokenPath', () => {
  it('默认路径位于 ~/.ki/mcp-token（与 lock 文件同目录）', () => {
    assert.equal(getManagedTokenPath(), path.join(os.homedir(), '.ki', 'mcp-token'));
  });
});
