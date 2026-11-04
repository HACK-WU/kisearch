/**
 * user-store.test.ts —— Web 账号存储（REQ-20261103-001 · S-01）
 *
 * 运行：npx jiti test/user-store.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UserStoreError,
  createUser,
  deleteUser,
  findUserRecord,
  getUserStoreStatus,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  setUserRole,
  verifyCredentials,
  verifyPassword,
} from '../src/lib/user-store.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-users-'));
const usersPath = path.join(tempDir, 'users.json');
let seq = 0;

function uniqueName(prefix = 'user'): string {
  return `${prefix}${Date.now()}${seq++}`;
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof UserStoreError && err.code === code);
}

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('user-store', () => {
  it('create + list：不返回 passwordHash，文件 0600', () => {
    const name = uniqueName('admin');
    const created = createUser({ username: name, password: 'Passw0rd!', role: 'admin' }, usersPath);
    assert.equal(created.username, name);
    assert.equal(created.role, 'admin');
    assert.equal(created.disabled, false);

    const users = listUsers(usersPath);
    const found = users.find((u) => u.username === name);
    assert.ok(found);
    assert.equal('passwordHash' in found, false);
    assert.equal(findUserRecord(name, usersPath)?.passwordHash.startsWith('scrypt$'), true);

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(usersPath).mode & 0o777, 0o600);
    }
  });

  it('用户名大小写不敏感唯一', () => {
    const name = uniqueName('Case');
    createUser({ username: name, password: 'Passw0rd!', role: 'editor' }, usersPath);
    expectCode(
      () => createUser({ username: name.toLowerCase(), password: 'Passw0rd!', role: 'editor' }, usersPath),
      'USER_EXISTS',
    );
  });

  it('非法角色 / 用户名 / 密码被拒绝', () => {
    expectCode(
      () => createUser({ username: uniqueName('bad'), password: 'Passw0rd!', role: 'owner' }, usersPath),
      'USER_INVALID_ROLE',
    );
    expectCode(
      () => createUser({ username: 'bad name', password: 'Passw0rd!', role: 'editor' }, usersPath),
      'USER_INVALID_USERNAME',
    );
    expectCode(
      () => createUser({ username: uniqueName('weak'), password: '1234567', role: 'editor' }, usersPath),
      'USER_PASSWORD_TOO_WEAK',
    );
  });

  it('校验密码：正确 / 错误 / 禁用 / 不存在', () => {
    const name = uniqueName('verify');
    createUser({ username: name, password: 'Passw0rd!', role: 'editor' }, usersPath);
    assert.ok(verifyCredentials(name, 'Passw0rd!', usersPath));
    assert.equal(verifyCredentials(name, 'wrong-password', usersPath), null);
    assert.equal(verifyCredentials(uniqueName('nobody'), 'Passw0rd!', usersPath), null);

    setUserDisabled(name, true, usersPath);
    assert.equal(verifyCredentials(name, 'Passw0rd!', usersPath), null);
  });

  it('重置密码：旧密码失效，新密码生效', () => {
    const name = uniqueName('reset');
    createUser({ username: name, password: 'OldPassw0rd!', role: 'viewer' }, usersPath);
    const before = findUserRecord(name, usersPath)?.passwordUpdatedAt;
    const updated = resetUserPassword(name, 'NewPassw0rd!', usersPath);
    assert.ok(updated.passwordUpdatedAt >= (before ?? ''));
    assert.equal(verifyCredentials(name, 'OldPassw0rd!', usersPath), null);
    assert.ok(verifyCredentials(name, 'NewPassw0rd!', usersPath));
  });

  it('最后一个启用中的 admin 不能删除 / 降级 / 禁用', () => {
    const name = uniqueName('onlyadmin');
    createUser({ username: name, password: 'Passw0rd!', role: 'admin' }, usersPath);
    // 其他测试可能已创建 admin；先确保当前文件里只有本测试的 admin 不可能，
    // 故用独立文件验证“唯一 admin”语义。
    const soloPath = path.join(tempDir, `solo-${seq++}.json`);
    createUser({ username: 'solo-admin', password: 'Passw0rd!', role: 'admin' }, soloPath);
    expectCode(() => deleteUser('solo-admin', soloPath), 'USER_LAST_ADMIN');
    expectCode(() => setUserRole('solo-admin', 'editor', soloPath), 'USER_LAST_ADMIN');
    expectCode(() => setUserDisabled('solo-admin', true, soloPath), 'USER_LAST_ADMIN');

    createUser({ username: 'second-admin', password: 'Passw0rd!', role: 'admin' }, soloPath);
    const demoted = setUserRole('solo-admin', 'editor', soloPath);
    assert.equal(demoted.role, 'editor');
    expectCode(() => setUserDisabled('second-admin', true, soloPath), 'USER_LAST_ADMIN');
    assert.equal(deleteUser(name, usersPath).username, name);
  });

  it('禁用 / 启用 / 角色切换 / 删除', () => {
    const name = uniqueName('state');
    createUser({ username: name, password: 'Passw0rd!', role: 'editor' }, usersPath);
    assert.equal(setUserDisabled(name, true, usersPath).disabled, true);
    assert.equal(setUserDisabled(name, false, usersPath).disabled, false);
    assert.equal(setUserRole(name, 'viewer', usersPath).role, 'viewer');
    deleteUser(name, usersPath);
    assert.equal(findUserRecord(name, usersPath), undefined);
    expectCode(() => deleteUser(name, usersPath), 'USER_NOT_FOUND');
  });

  it('lastLoginAt 更新', () => {
    const name = uniqueName('login');
    createUser({ username: name, password: 'Passw0rd!', role: 'viewer' }, usersPath);
    const logged = verifyCredentials(name, 'Passw0rd!', usersPath);
    assert.ok(logged?.lastLoginAt);
  });

  it('损坏文件 fail-loud，不被静默覆盖', () => {
    const corruptPath = path.join(tempDir, `corrupt-${seq++}.json`);
    fs.writeFileSync(corruptPath, '{not-json', 'utf8');
    expectCode(() => listUsers(corruptPath), 'USER_STORE_CORRUPT');
    expectCode(
      () => createUser({ username: uniqueName('x'), password: 'Passw0rd!', role: 'viewer' }, corruptPath),
      'USER_STORE_CORRUPT',
    );
    assert.equal(getUserStoreStatus(corruptPath).corrupt, true);
    assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{not-json');
  });

  it('getUserStoreStatus 统计 enabled / admins', () => {
    const statusPath = path.join(tempDir, `status-${seq++}.json`);
    createUser({ username: 'a1', password: 'Passw0rd!', role: 'admin' }, statusPath);
    createUser({ username: 'e1', password: 'Passw0rd!', role: 'editor' }, statusPath);
    createUser({ username: 'v1', password: 'Passw0rd!', role: 'viewer' }, statusPath);
    setUserDisabled('v1', true, statusPath);
    const status = getUserStoreStatus(statusPath);
    assert.deepEqual(
      { total: status.total, enabled: status.enabled, admins: status.admins, enabledAdmins: status.enabledAdmins },
      { total: 3, enabled: 2, admins: 1, enabledAdmins: 1 },
    );
  });

  it('verifyPassword 对非法 hash 返回 false', () => {
    assert.equal(verifyPassword('x', 'not-a-hash'), false);
  });
});
