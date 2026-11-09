/**
 * 第三方上传 API 开关 —— 配置层与优先级解析单元测试（REQ-20261105-001 / W1 + W2）
 *
 * 为什么这几条非测不可：
 *  A. `mcp.http.localAdmin` 的历史坑——schema 有定义、类型有字段、消费端有读取，
 *     唯独 `config.ts` 的解析块从未赋值，于是「写进 YAML 静默无效」而文档声称可关。
 *     本组用例就是那条坑的回归闸门：配置写进去必须真的到达 `KiConfig`。
 *  B. 开关取值分散在启动 / restart / status 三处，优先级分叉的表现是「关掉后重启又开了」
 *     这种安全回退，肉眼极难在评审里看出来 —— 用一个纯函数 + 矩阵用例钉死。
 *
 * 运行：npx jiti test/open-upload-api-config.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadConfig, resetConfigCache, type KiConfig } from '../src/lib/config.js';
import { resolveUploadApi } from '../src/lib/upload-api-flag.js';
import { DEFAULT_UPLOAD_MAX_BYTES, MAX_UPLOAD_MAX_BYTES } from '../src/lib/open-api/constants.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-uploadapi-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写临时 YAML 配置并加载（每次清缓存，避免进程内单例串扰） */
function writeAndLoad(content: string): KiConfig {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'cfg-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  resetConfigCache();
  return loadConfig(file);
}

describe('配置解析：mcp.http 的开关类字段必须真的生效', () => {
  it('uploadApi: false 能被解析出来（不是 undefined）', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    uploadApi: false', ''].join('\n'));
    assert.equal(cfg.mcp?.http?.uploadApi, false);
  });

  it('uploadApi: true 能被解析出来（不被当作未配置）', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    uploadApi: true', ''].join('\n'));
    assert.equal(cfg.mcp?.http?.uploadApi, true);
  });

  it('uploadMaxBytes 按字节原样解析', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    uploadMaxBytes: 20971520', ''].join('\n'));
    assert.equal(cfg.mcp?.http?.uploadMaxBytes, 20971520);
  });

  it('localAdmin: false 能被解析出来（既有静默失效缺陷的回归闸门）', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    localAdmin: false', ''].join('\n'));
    assert.equal(cfg.mcp?.http?.localAdmin, false);
  });

  it('未配置时三者都是 undefined（交给解析器兜底，而不是解析块伪造默认值）', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    port: 7423', ''].join('\n'));
    assert.equal(cfg.mcp?.http?.uploadApi, undefined);
    assert.equal(cfg.mcp?.http?.uploadMaxBytes, undefined);
    assert.equal(cfg.mcp?.http?.localAdmin, undefined);
  });

  it('uploadMaxBytes 越界 fail-loud：0 / 非整数 / 超过 4GiB 都不静默回落默认值', () => {
    for (const bad of ['0', '1.5', String(MAX_UPLOAD_MAX_BYTES + 1)]) {
      assert.throws(
        () => writeAndLoad(['mcp:', '  http:', `    uploadMaxBytes: ${bad}`, ''].join('\n')),
        /CONFIG_FIELD_INVALID[\s\S]*uploadMaxBytes/,
        `uploadMaxBytes=${bad} 应被拒绝`,
      );
    }
  });

  it('uploadApi 类型错误（字符串 "false"）被 schema 拦下，不做宽松转换', () => {
    assert.throws(
      () => writeAndLoad(['mcp:', '  http:', '    uploadApi: "false"', ''].join('\n')),
      /CONFIG_FIELD_INVALID/,
    );
  });
});

describe('resolveUploadApi：CLI > 配置 > lock > 默认', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveUploadApi>[0];
    uploadApi: boolean;
    source: string;
  }> = [
    { name: '全空 → 默认开启', input: {}, uploadApi: true, source: 'default' },
    { name: '仅配置 false', input: { configValue: false }, uploadApi: false, source: 'config' },
    { name: '配置 true 覆盖 lock false', input: { configValue: true, lockValue: false }, uploadApi: true, source: 'config' },
    { name: '配置未设 → 沿用 lock false', input: { lockValue: false }, uploadApi: false, source: 'lock' },
    { name: 'CLI --no-upload-api 压过配置 true', input: { cliArgs: ['--no-upload-api'], configValue: true }, uploadApi: false, source: 'cli' },
    { name: 'CLI --upload-api 压过配置 false', input: { cliArgs: ['--upload-api'], configValue: false }, uploadApi: true, source: 'cli' },
    { name: 'CLI --upload-api 压过 lock false', input: { cliArgs: ['--upload-api'], lockValue: false }, uploadApi: true, source: 'cli' },
    {
      name: '两个 flag 同时给出时 --no-upload-api 胜（与 --no-web 体例一致）',
      input: { cliArgs: ['--upload-api', '--no-upload-api'] },
      uploadApi: false,
      source: 'cli',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      assert.deepEqual(resolveUploadApi(c.input), { uploadApi: c.uploadApi, source: c.source });
    });
  }
});

describe('配置与 CLI 的端到端衔接（restart 场景：不显式给 flag 时沿用上次 lock）', () => {
  it('配置 false + 无 CLI → 关闭；再带 --upload-api → 开启', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    uploadApi: false', ''].join('\n'));
    const configValue = cfg.mcp?.http?.uploadApi;
    assert.equal(resolveUploadApi({ configValue }).uploadApi, false);
    assert.equal(resolveUploadApi({ cliArgs: ['--upload-api'], configValue }).uploadApi, true);
  });

  it('配置未设 + lock=false（上次关过）→ 裸 restart 不会自己开回来', () => {
    const cfg = writeAndLoad(['mcp:', '  http:', '    port: 7423', ''].join('\n'));
    const configValue = cfg.mcp?.http?.uploadApi;
    assert.equal(resolveUploadApi({ configValue, lockValue: false }).uploadApi, false);
  });

  it('默认上限常量是 512MB，且不超过配置上界 4GiB', () => {
    assert.equal(DEFAULT_UPLOAD_MAX_BYTES, 512 * 1024 * 1024);
    assert.ok(DEFAULT_UPLOAD_MAX_BYTES <= MAX_UPLOAD_MAX_BYTES);
  });
});
