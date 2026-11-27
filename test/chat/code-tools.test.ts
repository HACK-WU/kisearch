/**
 * test/chat/code-tools.test.ts —— 对话侧源码只读工具（REQ-20261127-001 · S-01）
 *
 * 覆盖：根解析（单库 / 默认目录 / 无）、预算公式、提示块、读写沙箱与越界。
 * 通道隔离（ask 不装配、构造式调用被拒）由 tool-loop 的集成用例覆盖。
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyFsReadWindow,
  CODE_READ_BLOCK_HEADER,
  CODE_TOOL_NAMES,
  createChatCodeToolEntries,
  describeChatCodeRoots,
  isCodeTool,
  renderCodeReadBlock,
  resolveByScopeOnly,
  resolveChatCodeRoots,
} from '../../src/lib/chat/code-tools.js';
import type { ChatCodeRoot } from '../../src/lib/chat/code-tools-types.js';
import type { KiConfig } from '../../src/lib/config.js';
import type { Capability } from '../../src/lib/auth/capabilities.js';
import { FS_READ_MAX_FILE_BYTES } from '../../src/lib/events/analysis-fs-tools.js';
import { selectToolEntries } from '../../src/lib/chat/retrieval/tool-loop.js';
import { CHAT_MCP_TOOLS } from '../../src/lib/chat/mcp-tool-registry.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-code-tools-'));
const demoDir = path.join(tmpRoot, 'repo');
const otherDir = path.join(tmpRoot, 'repo2');
fs.mkdirSync(path.join(demoDir, 'src'), { recursive: true });
fs.mkdirSync(otherDir, { recursive: true });
fs.writeFileSync(path.join(demoDir, 'a.txt'), 'hello\nworld\n', 'utf8');
fs.writeFileSync(path.join(demoDir, 'src', 'b.ts'), 'export const answer = 42;\n', 'utf8');
fs.writeFileSync(path.join(otherDir, 'c.txt'), 'other\n', 'utf8');

const viewsPath = path.join(tmpRoot, 'views.json');
function writeViews(views: Record<string, { members: string[] }>): void {
  fs.writeFileSync(viewsPath, JSON.stringify({ version: 2, views }), 'utf8');
}
fs.writeFileSync(path.join(demoDir, '.env'), 'REAL_SECRET_abc123\n', 'utf8');
fs.writeFileSync(path.join(demoDir, '.env.example'), 'SECRET_TOKEN=\n', 'utf8');
fs.mkdirSync(path.join(demoDir, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(demoDir, '.ssh', 'id_rsa'), 'PRIVATE_KEY\n', 'utf8');

function makeConfig(): KiConfig {
  // 只提供 resolveScopeTargets 需要的字段；views.json 不存在 → 按「无视图」处理
  return {
    _configPath: path.join(tmpRoot, 'config.yaml'),
    scopes: { demo: {} },
    scopeMode: 'permissive',
  } as unknown as KiConfig;
}

const demoRoot: ChatCodeRoot = { label: 'demo', realRoot: demoDir, aliases: [] };

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('S-01 · 根解析', () => {
  it('单库 byScope 命中 → 1 个根，标签 = 库名', () => {
    const r = resolveChatCodeRoots('demo', makeConfig(), { byScope: { demo: demoDir }, defaultDir: undefined });
    assert.equal(r.roots.length, 1);
    assert.equal(r.roots[0]!.label, 'demo');
    assert.equal(r.roots[0]!.realRoot, fs.realpathSync(demoDir));
    assert.deepEqual(r.skipped, []);
  });

  it('单库无映射但存在 defaultDir → 1 个根', () => {
    const r = resolveChatCodeRoots('other', makeConfig(), { byScope: {}, defaultDir: demoDir });
    assert.equal(r.roots.length, 1);
    assert.equal(r.roots[0]!.label, 'other');
  });

  it('单库都无 → 0 个根', () => {
    const r = resolveChatCodeRoots('demo', makeConfig(), { byScope: {}, defaultDir: undefined });
    assert.deepEqual(r.roots, []);
  });

  it('目录不可读 → skipped.unreadable', () => {
    const r = resolveChatCodeRoots('demo', makeConfig(), {
      byScope: { demo: path.join(tmpRoot, 'not-exist') },
      defaultDir: undefined,
    });
    assert.deepEqual(r.roots, []);
    assert.equal(r.skipped[0]!.reason, 'unreadable');
  });

  it('resolveByScopeOnly 不回落 defaultDir', () => {
    assert.equal(resolveByScopeOnly({ byScope: {}, defaultDir: demoDir }, 'demo'), null);
    assert.equal(resolveByScopeOnly({ byScope: { demo: demoDir }, defaultDir: otherDir }, 'demo'), demoDir);
  });

  it('视图会话：成员各自 byScope → 多根；defaultDir 不参与', () => {
    writeViews({ demoView: { members: ['demo', 'other'] } });
    const r = resolveChatCodeRoots('demoView', makeConfig(), {
      byScope: { demo: demoDir, other: otherDir },
      defaultDir: path.join(tmpRoot, 'should-not-be-used'),
    });
    assert.equal(r.roots.length, 2);
    assert.deepEqual(r.roots.map((x) => x.label).sort(), ['demo', 'other']);
    assert.deepEqual(r.skipped, []);
  });

  it('视图成员未映射 → skipped.unmapped，其余成员照常', () => {
    writeViews({ demoView: { members: ['demo', 'ghost'] } });
    const r = resolveChatCodeRoots('demoView', makeConfig(), {
      byScope: { demo: demoDir },
      defaultDir: demoDir,
    });
    assert.equal(r.roots.length, 1);
    assert.deepEqual(r.skipped, [{ label: 'ghost', reason: 'unmapped' }]);
  });

  it('同一 realRoot 映射给两成员 → 1 个根 + aliases', () => {
    writeViews({ sameView: { members: ['demo', 'demoAlias'] } });
    const r = resolveChatCodeRoots('sameView', makeConfig(), {
      byScope: { demo: demoDir, demoAlias: demoDir },
      defaultDir: undefined,
    });
    assert.equal(r.roots.length, 1);
    assert.equal(r.roots[0]!.label, 'demo');
    assert.deepEqual(r.roots[0]!.aliases, ['demoAlias']);
  });

  it('空视图 → skipped.view-empty', () => {
    writeViews({ emptyView: { members: [] } });
    const r = resolveChatCodeRoots('emptyView', makeConfig(), { byScope: { demo: demoDir }, defaultDir: undefined });
    assert.deepEqual(r.roots, []);
    assert.equal(r.skipped[0]!.reason, 'view-empty');
  });

  it('strict 模式未注册成员 → skipped.strict-skipped', () => {
    writeViews({ strictView: { members: ['demo', 'ghost'] } });
    const cfg = { ...makeConfig(), scopeMode: 'strict' } as unknown as KiConfig;
    const r = resolveChatCodeRoots('strictView', cfg, { byScope: { demo: demoDir, ghost: otherDir }, defaultDir: undefined });
    assert.equal(r.roots.length, 1);
    assert.deepEqual(r.skipped, [{ label: 'ghost', reason: 'strict-skipped' }]);
  });

  it('视图文件损坏 → skipped.view-error（不静默当空视图）', () => {
    const brokenDir = path.join(tmpRoot, 'broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'views.json'), '{not json', 'utf8');
    const cfg = { ...makeConfig(), _configPath: path.join(brokenDir, 'config.yaml') } as unknown as KiConfig;
    const r = resolveChatCodeRoots('demoView', cfg, { byScope: { demo: demoDir }, defaultDir: undefined });
    assert.deepEqual(r.roots, []);
    assert.equal(r.skipped[0]!.reason, 'view-error');
  });

  it('视图文件损坏但 scope 是单库 → 仍按 byScope 精确映射，且不回落 defaultDir', () => {
    const brokenDir = path.join(tmpRoot, 'broken2');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'views.json'), '{not json', 'utf8');
    const cfg = { ...makeConfig(), _configPath: path.join(brokenDir, 'config.yaml') } as unknown as KiConfig;
    const hit = resolveChatCodeRoots('demo', cfg, { byScope: { demo: demoDir }, defaultDir: otherDir });
    assert.equal(hit.roots.length, 1);
    assert.equal(hit.roots[0]!.label, 'demo');
    assert.equal(hit.roots[0]!.realRoot, fs.realpathSync(demoDir));

    const miss = resolveChatCodeRoots('another', cfg, { byScope: {}, defaultDir: otherDir });
    assert.deepEqual(miss.roots, []);
    assert.equal(miss.skipped[0]!.reason, 'view-error');
  });

  it('describeChatCodeRoots 与工具面解析同源', () => {
    writeViews({ demoView: { members: ['demo'] } });
    const dirs = { byScope: { demo: demoDir }, defaultDir: undefined };
    assert.deepEqual(describeChatCodeRoots('demoView', makeConfig(), dirs), resolveChatCodeRoots('demoView', makeConfig(), dirs));
  });
});

describe('S-01 · 预算与提示块', () => {
  it('applyFsReadWindow 默认窗口 → 97 行', () => {
    assert.equal(applyFsReadWindow('fs_read', {}, 10_000).limit, 97);
  });

  it('小窗口不被抬到 40 行', () => {
    assert.equal(applyFsReadWindow('fs_read', {}, 2_000).limit, 19);
  });

  it('显式 limit 不被覆盖；非 fs_read 原样返回', () => {
    assert.equal(applyFsReadWindow('fs_read', { limit: 200 }, 10_000).limit, 200);
    assert.deepEqual(applyFsReadWindow('fs_grep', { pattern: 'x' }, 10_000), { pattern: 'x' });
  });

  it('renderCodeReadBlock 含根清单与硬性规则补充说明', () => {
    const block = renderCodeReadBlock([demoRoot]);
    assert.ok(block.startsWith(CODE_READ_BLOCK_HEADER));
    assert.ok(block.includes('demo → '));
    assert.ok(block.includes('硬性规则第 1 条'));
  });

  it('renderCodeReadBlock 不列 aliases（避免模型用别名调 root）', () => {
    const block = renderCodeReadBlock([{ ...demoRoot, aliases: ['demoAlias'] }]);
    assert.ok(!block.includes('demoAlias'));
  });
});

describe('S-01 · 工具条目', () => {
  const entries = createChatCodeToolEntries();

  it('4 个条目且 isCodeTool 判定一致', () => {
    assert.deepEqual(entries.map((e) => e.name).sort(), [...CODE_TOOL_NAMES].sort());
    for (const name of CODE_TOOL_NAMES) assert.equal(isCodeTool(name), true);
    assert.equal(isCodeTool('ki_search'), false);
  });

  it('fs_read：读文件加根标签', async () => {
    const entry = entries.find((e) => e.name === 'fs_read')!;
    const args = entry.parse(JSON.stringify({ path: 'a.txt' }));
    const result = await entry.run('demo', args, { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.root, 'demo');
    assert.equal(result.path, 'demo:a.txt');
    assert.match(String(result.content), /1\|hello/);
  });

  it('fs_read：缺必填参数在 parse 阶段报错', () => {
    const entry = entries.find((e) => e.name === 'fs_read')!;
    assert.throws(() => entry.parse('{}'), /缺少必填参数 path/);
  });

  it('返回的 label:path 可直接回传（自动剥前缀并推断 root）', async () => {
    const entry = entries.find((e) => e.name === 'fs_read')!;
    const args = entry.parse(JSON.stringify({ path: 'demo:a.txt' }));
    const result = await entry.run('demo', args, { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.path, 'demo:a.txt');
  });

  it('越界路径 → OUT_OF_ROOT', async () => {
    const entry = entries.find((e) => e.name === 'fs_read')!;
    const args = entry.parse(JSON.stringify({ path: '../secret.txt' }));
    const result = await entry.run('demo', args, { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OUT_OF_ROOT');
  });

  it('无根 → NO_ROOT', async () => {
    const entry = entries.find((e) => e.name === 'fs_read')!;
    const args = entry.parse(JSON.stringify({ path: 'a.txt' }));
    const result = await entry.run('demo', args, { codeRoots: [] }) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ROOT');
  });

  it('fs_grep / fs_find / fs_ls 均可用', async () => {
    const grep = entries.find((e) => e.name === 'fs_grep')!;
    const grepResult = await grep.run('demo', grep.parse(JSON.stringify({ pattern: 'answer' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(grepResult.ok, true);
    assert.equal(grepResult.count, 1);
    assert.equal((grepResult.hits as Array<{ file: string }>)[0]!.file, 'demo:src/b.ts');

    const find = entries.find((e) => e.name === 'fs_find')!;
    const findResult = await find.run('demo', find.parse(JSON.stringify({ name: 'b.ts' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(findResult.ok, true);
    assert.ok((findResult.paths as string[]).includes('demo:src/b.ts'));

    const ls = entries.find((e) => e.name === 'fs_ls')!;
    const lsResult = await ls.run('demo', ls.parse('{}'), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(lsResult.ok, true);
    assert.ok((lsResult.entries as Array<{ name: string }>).some((e) => e.name === 'src'));
  });

  it('视图多根：按 root 路由到各自仓库', async () => {
    writeViews({ demoView: { members: ['demo', 'other'] } });
    const roots = resolveChatCodeRoots('demoView', makeConfig(), {
      byScope: { demo: demoDir, other: otherDir },
      defaultDir: undefined,
    });
    const entry = entries.find((e) => e.name === 'fs_read')!;
    const args = entry.parse(JSON.stringify({ root: 'other', path: 'c.txt' }));
    const result = await entry.run('demoView', args, { codeRoots: roots.roots }) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.path, 'other:c.txt');
    assert.match(String(result.content), /other/);

    const aliasArgs = entry.parse(JSON.stringify({ root: 'demoAlias', path: 'a.txt' }));
    writeViews({ sameView: { members: ['demo', 'demoAlias'] } });
    const sameRoots = resolveChatCodeRoots('sameView', makeConfig(), {
      byScope: { demo: demoDir, demoAlias: demoDir },
      defaultDir: undefined,
    });
    const aliasResult = await entry.run('sameView', aliasArgs, { codeRoots: sameRoots.roots }) as Record<string, unknown>;
    assert.equal(aliasResult.ok, false);
    assert.equal(aliasResult.code, 'UNKNOWN_ROOT');
  });

  it('多根缺 root → ROOT_REQUIRED', async () => {
    const entry = entries.find((e) => e.name === 'fs_read')!;
    const args = entry.parse(JSON.stringify({ path: 'a.txt' }));
    const twoRoots = [demoRoot, { ...demoRoot, label: 'other' }];
    const result = await entry.run('demo', args, { codeRoots: twoRoots }) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ROOT_REQUIRED');
  });

  it('超大文件 → INVALID_ARG（避免整文件读入内存）', async () => {
    const big = path.join(demoDir, 'big.log');
    fs.writeFileSync(big, Buffer.alloc(FS_READ_MAX_FILE_BYTES + 1));
    const read = entries.find((e) => e.name === 'fs_read')!;
    const result = await read.run('demo', read.parse(JSON.stringify({ path: 'big.log' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARG');
    assert.match(String(result.error), /文件过大/);
  });

  it('敏感文件不读 / 不搜 / 不列；模板与公钥放行', async () => {
    const read = entries.find((e) => e.name === 'fs_read')!;
    const envResult = await read.run('demo', read.parse(JSON.stringify({ path: '.env' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(envResult.ok, false);
    assert.equal(envResult.code, 'FORBIDDEN_PATH');

    const keyResult = await read.run('demo', read.parse(JSON.stringify({ path: '.ssh/id_rsa' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(keyResult.code, 'FORBIDDEN_PATH');

    const exampleResult = await read.run('demo', read.parse(JSON.stringify({ path: '.env.example' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(exampleResult.ok, true);

    const grep = entries.find((e) => e.name === 'fs_grep')!;
    const grepResult = await grep.run('demo', grep.parse(JSON.stringify({ pattern: 'REAL_SECRET_abc123' })), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    assert.equal(grepResult.count, 0);

    const ls = entries.find((e) => e.name === 'fs_ls')!;
    const lsResult = await ls.run('demo', ls.parse('{}'), { codeRoots: [demoRoot] }) as Record<string, unknown>;
    const names = (lsResult.entries as Array<{ name: string }>).map((e) => e.name);
    assert.ok(!names.includes('.env'));
    assert.ok(!names.includes('.ssh'));
    assert.ok(names.includes('.env.example'));
  });
});

describe('S-01 · 通道隔离（工具面选择）', () => {
  const roots = { roots: [demoRoot], skipped: [] };
  const names = (opts: Parameters<typeof selectToolEntries>[1]): string[] => (
    selectToolEntries(CHAT_MCP_TOOLS, opts).map((e) => e.name)
  );

  it('页面对话 + 有根 → 18 个（含 4 个 fs）', () => {
    const selected = names({ toolFace: 'chat', codeRoots: roots });
    assert.equal(selected.length, 18);
    for (const name of CODE_TOOL_NAMES) assert.ok(selected.includes(name));
  });

  it('页面对话 + 无根 → 14 个，无 fs_*', () => {
    const selected = names({ toolFace: 'chat', codeRoots: { roots: [], skipped: [] } });
    assert.equal(selected.length, 14);
    for (const name of CODE_TOOL_NAMES) assert.ok(!selected.includes(name));
  });

  it('ki_ask 通道即使有根也不装配 fs_*', () => {
    const selected = names({ toolFace: 'ask', codeRoots: roots });
    assert.equal(selected.length, 14);
    for (const name of CODE_TOOL_NAMES) assert.ok(!selected.includes(name));
  });

  it('无 knowledge.read 能力 → 读工具全部被过滤', () => {
    const selected = names({
      toolFace: 'chat',
      codeRoots: roots,
      capabilities: new Set<Capability>(['chat.use']),
    });
    assert.deepEqual(selected, []);
  });
});
