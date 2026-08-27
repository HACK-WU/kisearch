/**
 * resolveDefaultDataPaths 单元测试（默认路径整改 20f61e5）
 *
 * 覆盖面：
 *   A. 无存量 → 新默认 ~/.ki/kb、~/.ki/backup
 *   B. 存量继承：{kiRoot}/kb 有数据才继承；空目录不算存量
 *      ~/.ki-data 存量继承；两候选同时非空的优先级（{kiRoot}/kb 先）
 *   C. backupDir 独立探测：{kiRoot}/ki-backup 有数据才继承
 *   D. includeEnv 分支：KI_DATA_DIR 仅模板探测（includeEnv=true）生效，
 *      覆盖优先于存量继承；运行时（false）忽略；空白串忽略
 *
 * 实现说明：os.homedir() 在 POSIX 下优先读 $HOME 环境变量，
 * 测试通过临时 HOME + 临时 kiRoot 隔离真实用户目录。
 *
 * 运行：npx jiti test/resolve-default-paths.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDefaultDataPaths } from '../src/lib/config.js';

let tmpHome: string;
let tmpRoot: string;
let savedHome: string | undefined;
const savedKiDataDir: string | undefined = process.env.KI_DATA_DIR;

/** mkdir -p 并写入一个文件（使其成为"非空目录"） */
function seed(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'some-scope'), 'x');
}

/** 只创建目录不写内容（空目录，不应视为存量） */
function mkdirOnly(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rdp-home-'));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rdp-root-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedKiDataDir === undefined) delete process.env.KI_DATA_DIR;
  else process.env.KI_DATA_DIR = savedKiDataDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveDefaultDataPaths', () => {
  describe('无存量 → 新默认（方案 A：统一 ~/.ki 用户数据根）', () => {
    it('干净环境返回 ~/.ki/kb 与 ~/.ki/backup', () => {
      const r = resolveDefaultDataPaths(tmpRoot);
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });

    it('空目录不算存量（{kiRoot}/kb 存在但为空仍走新默认）', () => {
      mkdirOnly(path.join(tmpRoot, 'kb'));
      mkdirOnly(path.join(tmpRoot, 'ki-backup'));
      const r = resolveDefaultDataPaths(tmpRoot);
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });
  });

  describe('存量继承（避免存量数据静默丢失）', () => {
    it('{kiRoot}/kb 非空 → 继承为 dataDir，backupDir 不受牵连', () => {
      seed(path.join(tmpRoot, 'kb'));
      const r = resolveDefaultDataPaths(tmpRoot);
      assert.equal(r.dataDir, path.join(tmpRoot, 'kb'));
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });

    it('~/.ki-data 非空 → 继承为 dataDir', () => {
      seed(path.join(tmpHome, '.ki-data'));
      const r = resolveDefaultDataPaths(tmpRoot);
      assert.equal(r.dataDir, path.join(tmpHome, '.ki-data'));
    });

    it('两个候选同时非空 → 优先 {kiRoot}/kb（历史默认在前）', () => {
      seed(path.join(tmpRoot, 'kb'));
      seed(path.join(tmpHome, '.ki-data'));
      const r = resolveDefaultDataPaths(tmpRoot);
      assert.equal(r.dataDir, path.join(tmpRoot, 'kb'));
    });

    it('{kiRoot}/ki-backup 非空 → 继承为 backupDir（与 dataDir 探测独立）', () => {
      seed(path.join(tmpRoot, 'ki-backup'));
      const r = resolveDefaultDataPaths(tmpRoot);
      assert.equal(r.backupDir, path.join(tmpRoot, 'ki-backup'));
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
    });
  });

  describe('includeEnv 分支（KI_DATA_DIR 仅模板探测生效）', () => {
    it('includeEnv=true 且 KI_DATA_DIR 非空 → 覆盖（优先于存量继承）', () => {
      seed(path.join(tmpRoot, 'kb'));
      process.env.KI_DATA_DIR = '/opt/ki-data-from-env';
      const r = resolveDefaultDataPaths(tmpRoot, true);
      assert.equal(r.dataDir, path.resolve('/opt/ki-data-from-env'));
      // env 只作用于 dataDir，backupDir 仍按存量/新默认解析
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });

    it('includeEnv=false（运行时）→ 忽略 KI_DATA_DIR，走存量探测', () => {
      seed(path.join(tmpRoot, 'kb'));
      process.env.KI_DATA_DIR = '/opt/ki-data-from-env';
      const r = resolveDefaultDataPaths(tmpRoot, false);
      assert.equal(r.dataDir, path.join(tmpRoot, 'kb'));
    });

    it('KI_DATA_DIR 为空白串 → 视为未设置', () => {
      process.env.KI_DATA_DIR = '   ';
      const r = resolveDefaultDataPaths(tmpRoot, true);
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
    });
  });
});
