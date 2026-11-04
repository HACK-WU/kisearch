/**
 * 用户管理 / 个人中心纯函数（REQ-20261104-001）
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
const {
  TOKEN_LIMIT_USER,
  accountStatus,
  accountActive,
  hasPendingAccountSecurityChanges,
  tokenAddState,
  tokenCountLabel,
  tokenCreatorLabel,
  tokenScopeLabel,
  tokenTightened,
  validityLabel,
  validateExpiry,
  validatePassword,
  validateTokenLabel,
  validateUsername,
  describeUserError,
} = await vite.ssrLoadModule('/src/lib/usersPageModel.ts');

after(async () => { await vite.close(); });

const past = '2020-01-01T00:00:00.000Z';
const future = '2099-12-31T23:59:00.000Z';

describe('accountStatus', () => {
  it('启用 / 禁用 / 过期', () => {
    assert.equal(accountStatus({ role: 'viewer', disabled: false, expiresAt: null }), 'active');
    assert.equal(accountStatus({ role: 'viewer', disabled: true, expiresAt: null }), 'disabled');
    assert.equal(accountStatus({ role: 'viewer', disabled: false, expiresAt: past }), 'expired');
    assert.equal(accountActive({ role: 'viewer', disabled: false, expiresAt: future }), true);
  });
});

describe('validityLabel', () => {
  it('永久 / 未来 / 过期', () => {
    assert.equal(validityLabel({ expiresAt: null }), '永久');
    assert.match(validityLabel({ expiresAt: future }), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(validityLabel({ expiresAt: past }), /（已过期）/);
  });
});

describe('tokenAddState', () => {
  const base = { role: 'editor', active: true, tokenCount: 0 };
  it('正常可创建', () => {
    assert.deepEqual(tokenAddState(base), { disabled: false, hint: '', title: '' });
  });
  it('密码面板优先于未保存变更', () => {
    const state = tokenAddState({ ...base, pendingAccountChanges: true, passwordPanelOpen: true });
    assert.equal(state.disabled, true);
    assert.match(state.hint, /重置密码/);
  });
  it('未保存变更禁用', () => {
    const state = tokenAddState({ ...base, pendingAccountChanges: true });
    assert.equal(state.disabled, true);
    assert.match(state.hint, /未保存修改/);
  });
  it('普通账号达到 10 个禁用，admin 不限', () => {
    assert.equal(tokenAddState({ ...base, tokenCount: TOKEN_LIMIT_USER }).disabled, true);
    assert.equal(tokenAddState({ role: 'admin', active: true, tokenCount: 999 }).disabled, false);
  });
  it('账号不可用禁用', () => {
    assert.equal(tokenAddState({ ...base, active: false }).disabled, true);
  });
});

describe('pending changes', () => {
  const original = { role: 'editor', disabled: false, expiresAt: null };
  it('角色 / 状态 / 有效期变化都算', () => {
    assert.equal(hasPendingAccountSecurityChanges(original, { role: 'viewer', disabled: false, expiresAt: null }), true);
    assert.equal(hasPendingAccountSecurityChanges(original, { role: 'editor', disabled: true, expiresAt: null }), true);
    assert.equal(hasPendingAccountSecurityChanges(original, { role: 'editor', disabled: false, expiresAt: future }), true);
  });
  it('只比较到分钟', () => {
    const withSeconds = { ...original, expiresAt: future };
    assert.equal(hasPendingAccountSecurityChanges(withSeconds, { ...original, expiresAt: `${future.slice(0, 16)}:00.000Z` }), false);
  });
});

describe('Token 展示', () => {
  it('数量 / 创建者 / 范围 / 收紧', () => {
    assert.equal(tokenCountLabel('admin', 3), '已创建 3 · 不限');
    assert.equal(tokenCountLabel('viewer', 3), '已创建 3 / 10');
    assert.equal(tokenCreatorLabel('self'), '本人');
    assert.equal(tokenCreatorLabel('admin'), '管理员');
    assert.equal(tokenCreatorLabel('cli'), 'CLI');
    assert.equal(tokenScopeLabel(['all']), '全部知识库');
    assert.equal(tokenScopeLabel(['a', 'b']), 'a、b');
    assert.equal(tokenTightened({ createdReadOnly: false }, 'viewer'), true);
    assert.equal(tokenTightened({ createdReadOnly: true }, 'viewer'), false);
    assert.equal(tokenTightened({ createdReadOnly: false }, 'editor'), false);
  });
});

describe('校验与错误文案', () => {
  it('用户名 / 密码 / Token 名 / 有效期', () => {
    assert.equal(validateUsername('alice'), null);
    assert.ok(validateUsername('bad name'));
    assert.equal(validatePassword('Passw0rd!'), null);
    assert.ok(validatePassword('short'));
    assert.equal(validateTokenLabel('运维脚本（CLI）'), null);
    assert.ok(validateTokenLabel(''));
    assert.equal(validateExpiry(future), null);
    assert.ok(validateExpiry(past));
  });
  it('错误码映射', () => {
    assert.match(describeUserError('USER_ADMIN_PROTECTED', 'x'), /管理员/);
    assert.match(describeUserError('TOKEN_LIMIT_REACHED', 'x'), /10/);
    assert.equal(describeUserError('UNKNOWN', '原始错误'), '原始错误');
  });
});
