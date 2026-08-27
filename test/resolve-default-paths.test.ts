/**
 * resolveDefaultDataPaths 单元测试（无存量继承语义）
 *
 * 决策（2026-08-27）：不做存量路径兼容——旧默认 {项目根}/kb、~/.ki-data、
 * {项目根}/ki-backup 一律不再自动沿用（此前"有数据才继承"会把测试残留/
 * 旧安装目录误判为用户数据，导致 config init 永远指回仓库路径）。
 *
 * 覆盖面：
 *   A. 恒定默认：~/.ki/kb 与 ~/.ki/backup，不受任何旧路径存在性影响
 *   B. KI_DATA_DIR 仅 init 模板（includeEnv=true）显式覆盖；运行时忽略；空白串视为未设置
 *
 * 实现说明：os.homedir() 在 POSIX 下优先读 $HOME 环境变量，
 * 测试通过临时 HOME 隔离真实用户目录。
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
let savedHome: string | undefined;
const savedKiDataDir: string | undefined = process.env.KI_DATA_DIR;

/** mkdir -p 并写入一个文件（构成"有数据的旧默认路径"） */
function seed(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy-data'), 'x');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rdp-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedKiDataDir === undefined) delete process.env.KI_DATA_DIR;
  else process.env.KI_DATA_DIR = savedKiDataDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveDefaultDataPaths', () => {
  describe('恒定默认：~/.ki/kb 与 ~/.ki/backup，不做存量继承', () => {
    it('干净环境返回 ~/.ki/kb 与 ~/.ki/backup', () => {
      const r = resolveDefaultDataPaths();
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });

    it('旧默认 {任意}/kb 有数据 → 仍走新默认（不继承）', () => {
      seed(path.join(tmpHome, 'legacy-repo', 'kb'));
      const r = resolveDefaultDataPaths();
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
    });

    it('~/.ki-data 有数据 → 仍走新默认（不继承）', () => {
      seed(path.join(tmpHome, '.ki-data'));
      const r = resolveDefaultDataPaths();
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
    });

    it('backupDir：{任意}/ki-backup 有数据 → 仍走 ~/.ki/backup（不继承）', () => {
      seed(path.join(tmpHome, 'legacy-repo', 'ki-backup'));
      const r = resolveDefaultDataPaths();
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });
  });

  describe('includeEnv 分支（KI_DATA_DIR 仅 init 模板显式覆盖）', () => {
    it('includeEnv=true 且 KI_DATA_DIR 非空 → dataDir 被覆盖，backupDir 不受影响', () => {
      process.env.KI_DATA_DIR = '/opt/ki-data-from-env';
      const r = resolveDefaultDataPaths(true);
      assert.equal(r.dataDir, path.resolve('/opt/ki-data-from-env'));
      assert.equal(r.backupDir, path.join(tmpHome, '.ki', 'backup'));
    });

    it('includeEnv=false（运行时）→ 忽略 KI_DATA_DIR，恒为新默认', () => {
      process.env.KI_DATA_DIR = '/opt/ki-data-from-env';
      const r = resolveDefaultDataPaths(false);
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
    });

    it('KI_DATA_DIR 为空白串 → 视为未设置', () => {
      process.env.KI_DATA_DIR = '   ';
      const r = resolveDefaultDataPaths(true);
      assert.equal(r.dataDir, path.join(tmpHome, '.ki', 'kb'));
    });
  });
});
