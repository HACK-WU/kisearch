/**
 * 配置读写与源解析的单元测试。
 *
 * 重点守三条容易静默出错的约束：
 *   1. 值必须带引号（否则 token 里的 `#` / `:` 会被 YAML 吃掉）
 *   2. 源名白名单排除 YAML 保留字（`on:` 会变成布尔键、源凭空消失）
 *   3. 多源必须显式指定（否则误把测试包传到生产）
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertValidRemoteName,
  emptyConfig,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from '../dist/config.js';
import { resolveRemote, tokenEnvName } from '../dist/remote.js';
import { ClientError } from '../dist/errors.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-client-test-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ClientError, `期望 ClientError，实际 ${err?.constructor?.name}`);
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`);
    return err;
  }
  assert.fail(`期望抛出 ${code}，实际没有抛`);
}

/** 环境变量隔离：每个用例前清掉与本工具相关的变量 */
const ENV_KEYS = ['KI_REMOTE', 'KI_URL', 'KI_TOKEN'];
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KI_TOKEN_')) delete process.env[key];
  }
});

describe('配置路径解析', () => {
  it('--config 优先于 KI_CLIENT_CONFIG', () => {
    process.env.KI_CLIENT_CONFIG = '/tmp/from-env.yaml';
    assert.equal(resolveConfigPath('/tmp/from-flag.yaml'), path.resolve('/tmp/from-flag.yaml'));
    assert.equal(resolveConfigPath(), path.resolve('/tmp/from-env.yaml'));
    delete process.env.KI_CLIENT_CONFIG;
  });

  it('都不给时落到 ~/.ki-client/config.yaml', () => {
    assert.ok(resolveConfigPath().endsWith(path.join('.ki-client', 'config.yaml')));
  });
});

describe('源名校验', () => {
  it('允许小写字母、数字、连字符、下划线', () => {
    for (const name of ['prod', 'test-1', 'a_b']) assert.doesNotThrow(() => assertValidRemoteName(name));
  });

  it('拒绝 YAML 保留字（否则键会被解析成布尔/空值）', () => {
    for (const name of ['on', 'off', 'yes', 'no', 'true', 'false', 'null']) {
      expectCode(() => assertValidRemoteName(name), 'USAGE');
    }
  });

  it('拒绝大写、空格、路径字符与空名', () => {
    for (const name of ['Prod', 'a b', 'a/b', '', '../x']) {
      expectCode(() => assertValidRemoteName(name), 'USAGE');
    }
  });
});

describe('配置读写', () => {
  it('文件不存在时返回空配置（不报错）', () => {
    const cfg = readConfig(path.join(tmpRoot, 'missing.yaml'));
    assert.deepEqual(cfg.remotes, {});
  });

  it('写入后权限为 0600，且字符串值带引号', () => {
    const file = path.join(tmpRoot, 'sub', 'config.yaml');
    const cfg = emptyConfig();
    cfg.remotes.prod = { url: 'http://127.0.0.1:7423', token: 'a#b:c' };
    writeConfig(file, cfg);

    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);

    const text = fs.readFileSync(file, 'utf-8');
    assert.match(text, /"a#b:c"/, 'token 必须带引号，否则 # 会被当注释截断');

    const back = readConfig(file);
    assert.equal(back.remotes.prod.token, 'a#b:c');
    assert.equal(back.remotes.prod.url, 'http://127.0.0.1:7423');
  });

  it('未知顶层键 fail-loud', () => {
    const file = path.join(tmpRoot, 'unknown.yaml');
    fs.writeFileSync(file, 'version: 1\ndefault: prod\nremotes: {}\n', 'utf-8');
    const err = expectCode(() => readConfig(file), 'CONFIG_INVALID');
    assert.match(err.message, /default/);
  });

  it('源缺 url / 顶层不是映射 / 非法 YAML 都报 CONFIG_INVALID', () => {
    const cases = [
      'version: 1\nremotes:\n  prod:\n    token: x\n',
      '- a\n- b\n',
      'version: [\n',
    ];
    for (const [index, text] of cases.entries()) {
      const file = path.join(tmpRoot, `bad-${index}.yaml`);
      fs.writeFileSync(file, text, 'utf-8');
      expectCode(() => readConfig(file), 'CONFIG_INVALID');
    }
  });

  it('URL 规范化：去尾斜杠、保留子路径、拒绝非 http(s)', () => {
    const file = path.join(tmpRoot, 'url.yaml');
    fs.writeFileSync(file, 'version: 1\nremotes:\n  a:\n    url: "https://h/ki/"\n', 'utf-8');
    assert.equal(readConfig(file).remotes.a.url, 'https://h/ki');

    const bad = path.join(tmpRoot, 'bad-url.yaml');
    fs.writeFileSync(bad, 'version: 1\nremotes:\n  a:\n    url: "ftp://h/x"\n', 'utf-8');
    expectCode(() => readConfig(bad), 'USAGE');
  });
});

describe('源解析优先级', () => {
  const cfg = emptyConfig();
  cfg.remotes.prod = { url: 'http://p:1', token: 'tp' };
  cfg.remotes.test = { url: 'http://t:2', token: 'tt' };

  it('单源自动选中', () => {
    const single = emptyConfig();
    single.remotes.only = { url: 'http://o:1', token: 'to' };
    const r = resolveRemote(single);
    assert.equal(r.name, 'only');
    assert.equal(r.token, 'to');
  });

  it('多源未指定 → NO_REMOTE_SPECIFIED 且列出可用源', () => {
    const err = expectCode(() => resolveRemote(cfg), 'NO_REMOTE_SPECIFIED');
    assert.match(err.hint, /prod, test/);
  });

  it('--remote 指定可用；未知源 → UNKNOWN_REMOTE', () => {
    assert.equal(resolveRemote(cfg, 'test').url, 'http://t:2');
    expectCode(() => resolveRemote(cfg, 'nope'), 'UNKNOWN_REMOTE');
  });

  it('KI_REMOTE 作为默认（低于 --remote）', () => {
    process.env.KI_REMOTE = 'test';
    assert.equal(resolveRemote(cfg).name, 'test');
    assert.equal(resolveRemote(cfg, 'prod').name, 'prod');
  });

  it('无任何源但有 KI_URL+KI_TOKEN → 隐式源', () => {
    process.env.KI_URL = 'http://env:9/';
    process.env.KI_TOKEN = 'tenv';
    const r = resolveRemote(emptyConfig());
    assert.equal(r.name, '(env)');
    assert.equal(r.url, 'http://env:9');
    assert.equal(r.source, 'env');
  });

  it('无任何源且无 KI_URL → NO_REMOTE_SPECIFIED', () => {
    expectCode(() => resolveRemote(emptyConfig()), 'NO_REMOTE_SPECIFIED');
  });

  it('KI_TOKEN_<源名> 覆盖配置里的 token', () => {
    process.env[tokenEnvName('prod')] = 'from-env';
    assert.equal(resolveRemote(cfg, 'prod').token, 'from-env');
  });

  it('源名含连字符时环境变量名转下划线', () => {
    assert.equal(tokenEnvName('my-prod'), 'KI_TOKEN_MY_PROD');
  });

  it('源没有 token 且无环境变量 → TOKEN_MISSING（带环境变量名提示）', () => {
    const bare = emptyConfig();
    bare.remotes.prod = { url: 'http://p:1' };
    const err = expectCode(() => resolveRemote(bare, 'prod'), 'TOKEN_MISSING');
    assert.match(err.hint, /KI_TOKEN_PROD/);
  });
});
