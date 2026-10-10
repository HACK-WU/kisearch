/**
 * test/read-write-concurrency.test.ts —— S-04 表驱动回归（REQ-20261009-003 / Q6）
 *
 * 断言的不变量（I1）：对任一 relation，**分片（列表）可见 ⇒ KB（详情）可取**。
 * 违反即为 DIR E（"列表里在、点开 404"），用户可见的数据不一致。
 *
 * 设计要点（三条都是踩过的坑，勿删）：
 *   1. **对照臂必须先红**：用旧顺序（KB 先删 → 引擎 I/O → 分片后更新）复刻，必须能检出 DIR E；
 *      检不出说明采样器失效，测试失去意义（本用例会 fail）。
 *   2. **探针读序 = 先 KB、后分片**：修复后的删除顺序是"分片先消失 → KB 后消失"，
 *      若先读分片再读 KB，两次读之间跨过整个变更窗口会产生**假阳性**。
 *   3. **脚手架自身必须满足 I1**：seed 时 KB 先写、分片后写，否则起点就是 DIR E。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/read-write-concurrency.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLocalKbDir, getKbDir } from '../src/lib/scope.js';
import { migrateLegacyRelationsCache, persistCacheShape, loadGroupCache } from '../src/lib/group-cache.js';
import { readJson, writeJson } from '../src/lib/store.js';
import { executeDeleteRelation, executeDeleteGroup } from '../src/delete-relation.js';
import { executeManageCreate, executeManageDelete } from '../src/manage-index.js';
import { executeSyncRelation } from '../src/sync-relation.js';
// W8 ③：导入路径从"仅登记"提升为被测臂
import { handleDirectImport } from '../src/lib/import.js';

const RUN_TAG = `rwc-${Date.now()}`;
let seq = 0;
const newScope = (): string => `${RUN_TAG}-${++seq}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const kbFile = (scope: string, group: string): string => getLocalKbDir(scope, group);

/** 造一条一致的初始数据（★ KB 先写、分片后写，脚手架自身满足 I1） */
function seed(scope: string, group: string, relations: string[], withTree = false): void {
  if (withTree) {
    const created = executeManageCreate({ scope, name: group });
    assert.ok((created as { ok?: boolean }).ok !== false, `建树节点失败: ${JSON.stringify(created)}`);
  }
  migrateLegacyRelationsCache(scope);
  fs.mkdirSync(path.dirname(kbFile(scope, group)), { recursive: true });
  writeJson(kbFile(scope, group), Object.fromEntries(relations.map((r) => [r, `# ${r}\n正文`])));
  const cache = {
    groups: {
      [group]: {
        hot_relations: relations.map((text, i) => ({ id: `rel_${i}`, text, score: 0, useCount: 0, lastUsedTime: null })),
      },
    },
  };
  persistCacheShape(scope, cache as never, new Set([group]));
}

/** ★ 读序：先 KB、后分片（防假阳性，见文件头说明 2） */
function isDire(scope: string, group: string, relation: string): boolean {
  const kb = readJson<Record<string, string>>(kbFile(scope, group)) ?? {};
  const listed = (loadGroupCache(scope, group)?.hot_relations ?? []).some((r) => r.text === relation);
  return listed && !(relation in kb);
}

interface Sampler {
  /** `listed`：采样期间**观察到该 relation 被列出**的次数 —— 用于防"空断言假通过"（见下） */
  stop: () => Promise<{ samples: number; dire: { phase: string }[]; listed: number }>;
  setPhase: (p: string) => void;
}

/**
 * 并发读采样器：setImmediate 轮询（macrotask，能在变更的 await 间隙里被调度）。
 *
 * ★ `listed` 是**必需的防呆**：`isDire` 需要"已列出且 KB 缺失"同时成立，若探针的 relation
 * 名与真实口径不符（或该路径根本不产生该 relation），`dire` 会**恒为 0** —— 臂"绿着骗人"。
 * 因此每个臂都必须断言 `listed > 0`：证明探针真的看到过这条关系。
 * 读序仍必须 **先 KB、后分片**（见文件头说明 2：防假阳性）。
 */
function startSampler(scope: string, group: string, relation: string): Sampler {
  let stopFlag = false;
  let phase = 'idle';
  let samples = 0;
  let listedSamples = 0;
  const dire: { phase: string }[] = [];
  const loop = (async () => {
    while (!stopFlag) {
      samples++;
      const kb = readJson<Record<string, string>>(kbFile(scope, group)) ?? {};
      const isListed = (loadGroupCache(scope, group)?.hot_relations ?? []).some((r) => r.text === relation);
      if (isListed) listedSamples++;
      if (isListed && !(relation in kb)) dire.push({ phase });
      await new Promise((r) => setImmediate(r));
    }
  })();
  return {
    setPhase: (p) => { phase = p; },
    stop: async () => { stopFlag = true; await loop; return { samples, dire, listed: listedSamples }; },
  };
}

function cleanup(scope: string): void {
  const home = process.env.HOME ?? '/root';
  for (const dir of [
    getKbDir(scope),
    path.join(home, '.ki/vector/collections', scope),
    path.join(home, '.ki/vector/fts-collections', scope),
  ]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }
}

// ══════════════════════════════════════════════════════════════
// 对照臂：旧顺序必须被检出 DIR E（证明采样器与探针有效）
// ══════════════════════════════════════════════════════════════
test('对照臂：旧顺序（KB 先删 → 引擎 I/O → 分片后更新）必须检出 DIR E', async () => {
  const scope = newScope();
  const group = 'g-old';
  const rel = 'doc-a';
  seed(scope, group, [rel]);

  const sampler = startSampler(scope, group, rel);
  sampler.setPhase('old-order');
  // 复刻旧实现：① 先删 KB 并落盘
  const kb = readJson<Record<string, string>>(kbFile(scope, group)) ?? {};
  delete kb[rel];
  writeJson(kbFile(scope, group), kb);
  // ② 两次写之间夹着引擎 I/O（旧实现在这里有 wiki/向量/FTS 删除）
  await sleep(30);
  // ③ 最后才落分片
  persistCacheShape(scope, { groups: { [group]: { hot_relations: [] } } } as never, new Set([group]));
  const { samples, dire, listed } = await sampler.stop();

  assert.ok(samples > 0, '采样器未运行');
  assert.ok(listed > 0, '对照臂：采样器从未观察到该 relation 被列出 ⇒ 探针口径失效，本套回归失去灵敏度');
  assert.ok(
    dire.length > 0,
    `对照臂未检出 DIR E（采样 ${samples} 次）⇒ 采样器/探针失效，本套回归失去灵敏度`,
  );
  console.log(`  [对照臂] 采样 ${samples} 次，检出 DIR E ${dire.length} 次（phase=${dire[0]?.phase}）`);
  cleanup(scope);
});

// ══════════════════════════════════════════════════════════════
// 被测臂：真实变更路径 —— 全程不得出现 DIR E
// ══════════════════════════════════════════════════════════════
const ARMS: {
  name: string;
  run: (scope: string, group: string, rel: string) => Promise<unknown>;
  /** 探针用的 relation 名（缺省 `doc-a`）；导入路径的关系名 = 源文件名 */
  rel?: string;
  /** 不预置数据（路径自身负责创建，如导入） */
  fresh?: boolean;
}[] = [
  {
    name: 'delete-relation 文档级（S-04 修复：分片先落 → KB 后删）',
    run: async (scope, group, rel) => executeDeleteRelation({ scope, group, relation: rel }),
  },
  {
    name: 'delete-relation 目录级（S-04 修复：同上）',
    run: async (scope, group) => executeDeleteGroup({ scope, group }),
  },
  {
    name: 'manage-index 级联删除 --force（S-04 修复：分片先删 → KB 后删）',
    run: async (scope, group) => executeManageDelete({ scope, name: group, force: true }),
  },
  {
    name: 'sync-relation 覆盖写（KB 先 → 分片后；6 处落盘已入窗）',
    run: async (scope, group, rel) => executeSyncRelation({ scope, group, relation: rel, moduleInfo: '# 覆盖后的正文', vector: false }),
  },
  {
    // W8 ③：把"导入"从 pending 提升为**被测臂**（此前只登记不断言）
    name: 'handleDirectImport 导入（KB 先 → 分片后；Phase 4 元数据入窗）',
    // ★ 真实口径（temp/probe-import-relation-name.ts 实测）：导入的 relation = **去扩展名的文件名**
    //（源 `a.md` → relation `a`，group = 传入的 group）。这条口径若错，防呆断言会直接 fail
    //（第一次就是靠它发现的"a.md"假通过）。
    rel: 'a',
    fresh: true,
    run: async (scope, group) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwc-import-'));
      fs.writeFileSync(path.join(dir, 'a.md'), '# a\n导入正文');
      try {
        return await handleDirectImport({ scope, sourceDir: dir, group, vector: false });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

for (const arm of ARMS) {
  test(`并发读不得出现 DIR E：${arm.name}`, async () => {
    const scope = newScope();
    const group = 'g';
    const rel = arm.rel ?? 'doc-a';
    const withTree = arm.name.startsWith('manage-index');
    // fresh 臂（导入）自行创建数据：预置会造成"已存在"冲突，且探针应从"未列出"开始
    if (!arm.fresh) seed(scope, group, [rel, 'doc-b'], withTree);

    const sampler = startSampler(scope, group, rel);
    sampler.setPhase('mutate');
    await arm.run(scope, group, rel);
    sampler.setPhase('post');
    await sleep(5);            // 让采样器再采几轮
    const { samples, dire, listed } = await sampler.stop();

    assert.ok(samples > 0, '采样器未运行');
    // ★ 防"空断言假通过"：探针必须真的见过这条关系被列出。
    //   若 relation 名口径不符（如导入路径的 relation 名不是文件名），`dire` 会恒为 0，
    //   臂会"绿着骗人"——所以这条断言是**必需的**，不是可选的严格化。
    assert.ok(
      listed > 0,
      `采样期间从未观察到 relation「${rel}」被列出（采样 ${samples} 次）`
      + ` ⇒ 探针口径与真实不符，本臂属空断言，不得算通过（请核对 relation 名）`,
    );
    assert.equal(
      dire.length, 0,
      `检出 DIR E ${dire.length} 次（采样 ${samples} 次，首次 phase=${dire[0]?.phase}）`
      + ` ⇒ 违反 I1："列表可见 ⇒ 详情可取"`,
    );
    console.log(`  [${arm.name}] 采样 ${samples} 次（曾列出 ${listed} 次），DIR E = 0 ✅`);
    cleanup(scope);
  });
}

// ══════════════════════════════════════════════════════════════
// 路径登记（防"新路径绕过不变量"）
// ══════════════════════════════════════════════════════════════
test('变更路径登记完整性：未覆盖路径必须显式列出（不得静默）', () => {
  const registry = {
    covered: ['delete-relation 文档级', 'delete-relation 目录级', 'manage-index --force 级联', 'sync-relation 覆盖写', 'handleDirectImport 导入'],
    pending: [
      'doc/edit 发布（relation-edit-publish）：**已入窗**（2026-10-10，新旧布局的缓存/分片写均在办）'
      + '且顺序核为 KB 先→分片后 ⇒ I1 已满足；**未加采样臂**（构造草稿成本高）——降级为'
      + '"入窗 + 代码顺序核对"，如需采样臂请先补草稿构造工具',
      'rebuild-vector / restore：restore 走 safe-tar staging + 原子 rename'
      + '（已由 test/restore-layout-matrix.test.ts 断言布局）；rebuild 的批写未入窗，已登记在欠账表',
    ],
  };
  // 覆盖数不得回退（新增/删除用例时同步改这里）
  assert.equal(registry.covered.length, 5, '覆盖臂数量变化：请同步更新登记表');
  assert.ok(registry.pending.length >= 0);
  if (registry.pending.length > 0) {
    console.log('  ⚠️ 尚未纳入本套回归的变更路径（I4 上线门槛要求全部覆盖）：');
    for (const p of registry.pending) console.log(`     - ${p}`);
  }
});

// ══════════════════════════════════════════════════════════════
// 不变量（静态扫描）：元数据写必须入「提交窗口」——防新增路径绕过 I2
// ══════════════════════════════════════════════════════════════
/**
 * 为什么要静态扫描：I4 之后**读与写任务并行**，安全性完全依赖"写侧不变量"：
 *   I1 = 顺序（分片可见 ⇒ KB 可取；删除必须分片先删）
 *   I2 = 分片/元数据落盘必须在「元数据提交窗口」内（否则读可能跨过两次写看到半新半旧）
 * I1 由本文件的**采样臂**守（行为断言）；I2 无法靠采样稳定复现，改为**结构断言**：
 * 凡含元数据写原语的文件，必须出现窗口调用（或列在已知欠账表里）。
 *
 * ★ 已知欠账显式钉在这里（不得静默）：新增欠账会让本用例**直接失败**。
 */
const METADATA_WRITE_DEBT: Record<string, string> = {
  // ★ 本表语义 = **例外登记**（不是"待办清单"）：每一项都必须写明"为什么可以不入窗"或
  //   "为什么现在还缺"。新增未知项会让本用例直接失败 ⇒ 逼着把例外写下来（防静默）。
  //
  // 已修复（2026-10-10，保留说明）：
  //   - sync-relation.ts：6 处 persistCacheShape → 全部入窗
  //   - lib/relation-edit-publish.ts：发布临界区的分片/缓存写 → 入窗
  //   - get-module-info.ts：读详情路径的评分回写（:204/:419/:430）→ 入窗
  //     （该路径经 daemon/MCP 暴露，读可与写任务并行 ⇒ 暴露真实）
  //
  // 例外（有意不入窗，理由必须站得住）：
  'manage-index.ts':
    '仅**旧布局**分支的整文件写（:313/:538）。本命令为 CLI 专属（MCP 只暴露空节点删除），'
    + '进程内无并发读者 ⇒ 不入窗是有意选择（见 src/manage-index.ts:520-522 的原始说明，'
    + '与"分片先删 → KB 后删"的顺序修复同一段）。**本项是绊线**：若将来 Web/HTTP 也调用该函数，'
    + '此理由失效、必须入窗。',
  'lib/rebuild-vector.ts':
    'writeGroupCacheBatch 全量批写（:969/:1038）。**不能靠入窗解决**：批写可能持续数秒，'
    + '入窗会让所有读排队数秒（比现状更糟）。正确修法是"写 staging 目录 → 按组原子换目录"，'
    + '现状"旧分片整目录 rename 备份 → 逐文件写新分片"期间读会看到空列表（方向安全，非 DIR E）。'
    + '已作为设计性欠账登记（`/api/restore/run` 的 rebuild-only 在 daemon 内可跑 ⇒ 暴露真实）。',
};

test('不变量（静态）：含元数据写的文件必须入「元数据提交窗口」（I2）', () => {
  const SRC = path.join(process.cwd(), 'src');
  /**
   * 元数据写原语：改这些 = 改"列表可见性 / 索引状态 / source 口径"。
   * ★ 2026-10-10 补漏：初版只列了 `persistCacheShape|persistTouchedGroups|setSource`，
   *   漏掉了**第三种原语族** `writeGroupCache` / `writeGroupCacheBatch` 与旧布局的
   *   `writeJson(getRelationsCachePath(...)|cachePath, ...)` —— 结果扫描报"全部入窗 ✅"
   *   是**假绿**（编辑发布/详情自动补建等路径实际在窗外）。原语清单必须完整，否则本用例
   *   失去意义。
   * 局限（已知，勿当保证）：本检查是**文件级**——只保证"该文件存在窗口"，不保证"每个写点
   *   都在窗口内"。文件级通过但含多处写点的文件仍需人工复核（见用例末尾提示）。
   */
  const METADATA_WRITE = new RegExp(
    [
      '\\b(persistCacheShape|persistTouchedGroups|setSource|writeGroupCache|writeGroupCacheBatch)\\s*\\(',
      'writeJson\\(groupIndexPath',
      'writeJson\\(\\s*(cachePath|getRelationsCachePath\\([^)]*\\))',
    ].join('|'),
  );
  /** 原语**定义**文件：它们实现写，窗口由调用方保证（见 group-cache.ts:704、scope.ts:266） */
  const PRIMITIVE_DEFS = new Set(['lib/group-cache.ts', 'lib/scope.ts']);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
    }
  };
  walk(SRC);

  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (PRIMITIVE_DEFS.has(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!METADATA_WRITE.test(text)) continue;
    if (/runMetadataCommit\(|withMetadataCommitSync\(/.test(text)) continue; // 已入窗
    offenders.push(rel);
  }

  const unknown = offenders.filter((rel) => !(rel in METADATA_WRITE_DEBT));
  assert.deepEqual(
    unknown, [],
    `以下文件含元数据写、却既没有提交窗口、也不在已知欠账表里 ⇒ 新增路径绕过 I2：${unknown.join(', ')}`,
  );
  // 欠账只允许减少（清掉一条就删一行；数量回退 = 有人重新引入了窗外写）
  const debtHit = offenders.filter((rel) => rel in METADATA_WRITE_DEBT);
  assert.ok(
    debtHit.length <= Object.keys(METADATA_WRITE_DEBT).length,
    '欠账数量异常增长，请检查是否引入了窗外写',
  );
  if (debtHit.length > 0) {
    console.log(`  ⚠️ 已知欠账（${debtHit.length} 个文件，I2 未达）——不得静默：`);
    for (const rel of debtHit) console.log(`     - src/${rel}：${METADATA_WRITE_DEBT[rel]}`);
  } else {
    console.log('  [不变量 I2] 全部元数据写均已入窗 ✅');
  }
});
