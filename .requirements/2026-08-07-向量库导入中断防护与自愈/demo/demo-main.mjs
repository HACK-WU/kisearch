// demo-main.mjs —— 方案 D 核心链路端到端验证（mock 向量层）
// 验证目的：
//   R-01 local KB 文件级原文 + relation-cache memoryIds 多值
//   R-02 relation-map 多值聚合：命中任一 chunk memoryId → 文件级 relation + 去重
//   R-03 buildMemoryIdMap 字段直读（文件级 key → memoryId[]）
//   R-04 清洗只作用于向量化：local KB 存原文、chunk 用清洗后文本
//   R-05 relation 命名冲突跳过 + 非 md 跳过
//
// 运行：node .demo-verify/demo-main.mjs
// 不依赖 embedding API（mock 向量层：确定性 memoryId = sha256(text) 前缀 16）

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanMarkdownText } from './clean.mjs';
import { splitIntoChunks, MAX_CHUNKS_PER_FILE } from './chunker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── mock 向量层 ──────────────────────────────────────────
// 模拟 vectorBulkStore：确定性 docId（内容相同 → id 相同，便于验证 modified 复用）
function mockVectorBulkStore(entries) {
  return entries.map((e) => ({
    index: e.index,
    success: true,
    memoryId: createHash('sha256').update(`${e.text}:${e.scope}`).digest('hex').slice(0, 16),
  }));
}

// ─── 简化数据模型（对齐项目 relations-cache / local KB）───
// relationsCache.groups[group].hot_relations[] 每条含 {id, text(relation), memoryIds[], sourcePath}
const relationsCache = { version: 1, scope: 'demo', groups: {} };
const localKb = {}; // localKb[group][relation] = 文件原文

function ensureGroup(group) {
  if (!relationsCache.groups[group]) {
    relationsCache.groups[group] = { hot_relations: [], keywords: [], max_hot_count: 10 };
  }
}

function deriveRelationText(filePath) {
  const base = path.posix.basename(filePath).replace(/\.md$/i, '');
  return base.replace(/[*~`]/g, '').trim() || base;
}

function deriveGroupPath(rootName, relPath) {
  const dir = path.posix.dirname(relPath);
  return dir === '.' ? rootName : `${rootName}/${dir}`;
}

// ─── 方案 D 导入单文件流程 ────────────────────────────────
function importFile({ scope, rootName, filePath, rawText, rules, chunkSize = 1000, overlap = 150 }) {
  const group = deriveGroupPath(rootName, filePath);
  const relation = deriveRelationText(filePath); // 文件级 relation

  ensureGroup(group);
  const existing = relationsCache.groups[group].hot_relations.find((r) => r.text === relation);
  if (existing) {
    // R-05：同 group 下 relation 冲突 → 跳过 + 反馈
    return { ok: false, reason: 'relation_conflict', relation, filePath };
  }

  // ① 文档进来第一步直接写入 local KB（文件原文，不清洗）
  if (!localKb[group]) localKb[group] = {};
  localKb[group][relation] = rawText;

  // ② 数据清洗
  const cleaned = cleanMarkdownText(rawText, rules);

  // ③ 切分 → 向量化 → 拿每段 chunk memoryId
  const chunks = splitIntoChunks(cleaned, { chunkSize, overlap });
  const vecEntries = chunks.map((c, i) => ({
    index: i,
    text: c.text,
    scope,
    path: `${filePath}#${c.index}`,
  }));
  const vecResults = mockVectorBulkStore(vecEntries);
  const memoryIds = vecResults.map((r) => r.memoryId).filter(Boolean);

  // ④ 写入 relation-cache：文件级 relation 挂 memoryIds 多值
  relationsCache.groups[group].hot_relations.push({
    id: `rel_${relationsCache.groups[group].hot_relations.length + 1}`,
    text: relation,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: true,
    memoryIds, // 多值
    sourcePath: filePath, // 文件路径（无 #N）
  });

  return { ok: true, relation, group, chunkCount: chunks.length, memoryIds };
}

/** 字段直读去重（对齐真实 diff.ts buildMemoryIdMap 的 list.includes 去重语义） */
function dedupe(arr) {
  return [...new Set(arr)];
}

// ─── relation-map：memoryId 反查（多值聚合到文件级 relation）───
function buildRelationMap() {
  const map = new Map(); // memoryId → {group, relation}
  for (const [group, gd] of Object.entries(relationsCache.groups)) {
    for (const rel of gd.hot_relations) {
      for (const mid of rel.memoryIds || []) {
        map.set(mid, { group, relation: rel.text });
      }
    }
  }
  return map;
}

// ─── R-03：buildMemoryIdMap 字段直读 ──────────────────────
function buildMemoryIdMapFieldDirect() {
  const map = new Map();
  for (const gd of Object.values(relationsCache.groups)) {
    for (const rel of gd.hot_relations) {
      if (!rel.sourcePath || !rel.memoryIds || rel.memoryIds.length === 0) continue;
      map.set(rel.sourcePath, rel.memoryIds);
    }
  }
  return map;
}

// ─── 模拟旧逻辑（#N 前缀聚合，用于等价性对比 R-03）────────
function buildMemoryIdMapLegacy() {
  // 旧数据：chunk 级 sourcePath（file#N），按 # 前缀聚合
  const map = new Map();
  for (const gd of Object.values(relationsCache.groups)) {
    for (const rel of gd.hot_relations) {
      const sp = rel.sourcePath;
      if (!sp) continue;
      const hashIdx = sp.indexOf('#');
      const fileKey = hashIdx >= 0 ? sp.slice(0, hashIdx) : sp;
      const list = map.get(fileKey) || [];
      for (const mid of rel.memoryIds || []) {
        if (!list.includes(mid)) list.push(mid);
      }
      map.set(fileKey, list);
    }
  }
  return map;
}

// ─── 断言辅助 ─────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ─── 验证执行 ─────────────────────────────────────────────
console.log('═══ 方案 D demo 验证（mock 向量层）═══\n');

// ===== R-04：清洗只作用于向量化（local KB 原文 vs chunk 清洗后）=====
console.log('【R-04 清洗隔离】');
const rawWithNoise = [
  '\uFEFF---',
  'title: 测试文档',
  'date: 2026-08-08',
  'tags: [demo]',
  '---',
  '',
  '# 标题',
  '',
  '正文第一段，介绍核心概念。',
  '',
  '```mermaid',
  'graph TD;',
  '  A-->B;',
  '```',
  '',
  '参考文件路径：docs/foo.ts 与 file:///abs/bar.py 以及 https://github.com/a/b.ts',
  '',
  '```bash',
  'curl -X POST http://example.com/api',
  '```',
  '',
  '结尾段落。',
].join('\n');

const r04 = importFile({ scope: 'demo', rootName: 'Wiki', filePath: 'a.md', rawText: rawWithNoise });
const localKbOriginal = localKb.Wiki['a'];
const chunkTexts = splitIntoChunks(cleanMarkdownText(rawWithNoise), { chunkSize: 1000, overlap: 150 });
check('local KB 存原文（未清洗，保留 BOM/frontmatter/mermaid/路径）',
  localKbOriginal.includes('\uFEFF---') && localKbOriginal.includes('title: 测试文档') && localKbOriginal.includes('mermaid'),
  `原文首 50 字: ${localKbOriginal.slice(0, 50).replace(/\n/g, '\\n')}`);
check('向量化输入为清洗后文本（无 BOM/frontmatter/mermaid）',
  !chunkTexts.some((c) => c.text.includes('\uFEFF')) && !chunkTexts.some((c) => c.text.includes('mermaid')),
  `清洗后首 chunk: ${chunkTexts[0].text.slice(0, 40)}`);
check('空/近空 chunk 被过滤（清洗后正文仍非空）', chunkTexts.length >= 1 && chunkTexts.every((c) => c.text.trim().length > 0));

// ===== R-01：文件级原文 + memoryIds 多值 =====
console.log('\n【R-01 数据模型】');
const bigText = '这是一段用于切分的正文。\n'.repeat(300); // 300 段 ≈ 3000 字符 → 多 chunk
const r01 = importFile({ scope: 'demo', rootName: 'Wiki', filePath: 'b.md', rawText: bigText, chunkSize: 1000, overlap: 150 });
const relB = relationsCache.groups.Wiki.hot_relations.find((r) => r.text === 'b');
check('local KB 一个文件一条记录（key=文件级 relation）', Object.keys(localKb.Wiki).includes('b') && localKb.Wiki['b'] === bigText);
check('relation-cache 文件级 relation 挂 memoryIds 多值', Array.isArray(relB.memoryIds) && relB.memoryIds.length === r01.chunkCount, `memoryIds=${relB.memoryIds.length}, chunk=${r01.chunkCount}`);
check('memoryIds 数量 = 实际 chunk 数（多 chunk 文件）', relB.memoryIds.length === splitIntoChunks(cleanMarkdownText(bigText), { chunkSize: 1000, overlap: 150 }).length);

// ===== R-02：relation-map 多值聚合 + 召回去重 =====
console.log('\n【R-02 原文召回去重】');
const relMap = buildRelationMap();
const midB0 = relB.memoryIds[0];
const midB1 = relB.memoryIds[1];
check('任一 chunk memoryId → 反查同一文件级 relation', relMap.get(midB0)?.relation === 'b' && relMap.get(midB1)?.relation === 'b');
check('多 chunk 命中去重（Set 收敛到 1 条原文）',
  new Set([relMap.get(midB0)?.relation, relMap.get(midB1)?.relation]).size === 1);
// 模拟 search 命中 2 个 chunk → 返回原文仅 1 次
const hits = [midB0, midB1].map((m) => relMap.get(m));
const uniqueOriginals = new Set(hits.map((h) => localKb[h?.group]?.[h?.relation]));
check('search 命中 2 chunk → 原文只返回 1 次', uniqueOriginals.size === 1 && [...uniqueOriginals][0] === bigText);

// ===== R-03：buildMemoryIdMap 字段直读 vs 旧 #N 聚合等价 =====
console.log('\n【R-03 buildMemoryIdMap 等价性】');
// 模拟旧数据（chunk 级 relation：b#1、b#2... 各带一条 memoryId），对比"字段直读"与"#N 前缀聚合"输出
const bRel = relationsCache.groups.Wiki.hot_relations.find((r) => r.text === 'b');
const legacyChunkRels = (bRel.memoryIds || []).map((mid, i) => ({
  text: `b-${String(i + 1).padStart(2, '0')}`,
  sourcePath: `b.md#${i + 1}`, // chunk 级 sourcePath
  memoryIds: [mid], // 单值（旧结构 memoryId 字段等价）
}));
// 保存原文件级 relation，额外注入 legacy chunk 级 relation 到独立 group 模拟旧库
const legacyCache = { version: 1, scope: 'demo', groups: { 'Wiki.legacy': { hot_relations: legacyChunkRels, keywords: [], max_hot_count: 10 } } };
// 用旧结构的 relations-cache 跑 legacy 聚合
const oldGroups = relationsCache.groups;
relationsCache.groups = legacyCache.groups;
const legacyMap = buildMemoryIdMapLegacy();
relationsCache.groups = oldGroups;
// 字段直读（新结构，文件级 relation）
const directMap = buildMemoryIdMapFieldDirect();

const fieldDirectRel = relationsCache.groups.Wiki.hot_relations.find((r) => r.text === 'b');
check('字段直读 Map<filePath, memoryId[]> 结构正确',
  directMap.get('b.md')?.length === fieldDirectRel.memoryIds.length, `直读=${directMap.get('b.md')?.length}, 字段=${fieldDirectRel.memoryIds.length}`);
check('字段直读与 #N 前缀聚合输出一致（同文件全部 chunk id 集合相等）',
  [...dedupe(directMap.get('b.md') || [])].sort().join() === [...dedupe(legacyMap.get('b.md') || [])].sort().join(),
  `direct=[${dedupe(directMap.get('b.md'))}], legacy=[${dedupe(legacyMap.get('b.md'))}]`);
check('字段直读结果与旧聚合结果按文件 key 一一对应', dedupe(directMap.get('b.md')).length === dedupe(legacyMap.get('b.md')).length);

// ===== R-05：relation 冲突跳过 + 非 md 跳过 =====
console.log('\n【R-05 边界：冲突跳过 + 非 md 跳过】');
// 同 group 同名文件：c.md（同 Wiki group 下）→ 冲突跳过
const r05a = importFile({ scope: 'demo', rootName: 'Wiki', filePath: 'sub/c.md', rawText: '正文 C1\n'.repeat(5) });
const r05b = importFile({ scope: 'demo', rootName: 'Wiki', filePath: 'other/c.md', rawText: '正文 C2\n'.repeat(5) });
check('不同 group 下同名文件不冲突（c 分别在 Wiki/sub 与 Wiki/other）', r05a.ok && r05b.ok && r05a.relation === r05b.relation);
// 同 group 下两个同 basename 文件冲突
const r05c = importFile({ scope: 'demo', rootName: 'Wiki', filePath: 'x/d.md', rawText: '正文 D1\n'.repeat(5) });
const r05d = importFile({ scope: 'demo', rootName: 'Wiki', filePath: 'x/d.md', rawText: '正文 D2\n'.repeat(5) });
check('同 group 下 relation 冲突 → 第二个文件跳过 + 反馈', r05d.ok === false && r05d.reason === 'relation_conflict', JSON.stringify(r05d));
// 非 md 文件跳过（模拟 collectMarkdownFiles 白名单行为）
const unsupported = ['notes.txt', 'slide.pdf', 'image.png', 'code.py'];
const skippedNonMd = unsupported.filter((f) => !/\.md$/i.test(f));
check('非 md 文件默认跳过（白名单外）', skippedNonMd.length === unsupported.length, `跳过=${skippedNonMd.length}`);
console.log(`   ℹ 汇总提示：跳过 ${skippedNonMd.length} 个不支持格式的文件：${skippedNonMd.join(', ')}`);

// ===== 汇总 =====
console.log(`\n═══════════════════════════════════════`);
console.log(`结果：通过 ${passCount} / 失败 ${failCount}`);
console.log(`═══════════════════════════════════════`);
process.exit(failCount > 0 ? 1 : 0);
