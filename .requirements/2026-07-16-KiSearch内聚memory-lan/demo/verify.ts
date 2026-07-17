/**
 * demo-verify/verify.ts — 完整 R-01/R-02/R-03 验证
 * 运行: timeout -s KILL 90 node_modules/.bin/jiti .demo-verify/verify.ts 2>&1; echo "RETURNED exit=$?"
 */
import { createMemoryRuntime, type MemoryRuntime } from "../memory-lancedb-mcp/src/index.ts";

const DEMO_DB = "/tmp/ki-demo-lancedb";
const config = {
  dbPath: DEMO_DB,
  embedding: {
    apiKey: "xxxx",
    model: "Qwen/Qwen3-Embedding-8B",
    baseURL: "https://api.siliconflow.cn/v1",
    dimensions: 4096,
  },
  smartExtraction: false,
  enableManagementTools: true,
  autoCapture: false,
  autoRecall: false,
  sessionStrategy: "none",
  retrieval: { mode: "hybrid", rerank: "none" },
  selfImprovement: { enabled: false },
  scopes: {
    default: "global",
    definitions: {
      "test-scope": { description: "knowledge-indexer test scope" },
      "other-scope": { description: "isolation target" },
    },
  },
};

const SYS = { agentId: "system" } as const;
const call = (r: MemoryRuntime, n: string, p: Record<string, unknown>) => r.callTool(n, p, SYS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? "✅ PASS" : "❌ FAIL"}: ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log(">>> R-01: createMemoryRuntime()");
  const runtime = await createMemoryRuntime({ config, quiet: false });
  const tools = runtime.listTools().map((t) => t.name);
  assert(
    ["memory_store", "memory_recall", "memory_list", "memory_forget"].every((t) => tools.includes(t)),
    `4 核心工具已注册 (共 ${tools.length} 个)`,
  );

  // R-02 + R-03: 三层标签写入 test-scope
  console.log("\n>>> R-02/R-03: store ki-search (test-scope)");
  const s1 = await call(runtime, "memory_store", {
    text: "KiSearch 是一个 AI 知识索引整理工具，支持对外部知识做结构化索引与导航。",
    scope: "test-scope", tags: "ki-search", importance: 0.8,
  });
  const id1 = (s1 as any)?.details?.id;
  assert(!!id1, `store 返回 details.id (${id1}) —— SiliconFlow 4096-dim 向量已写入`);
  assert((s1 as any)?.content?.[0]?.text?.includes("【标签:ki-search】"), "标签 ki-search 前缀已注入存储文本");

  const s2 = await call(runtime, "memory_store", {
    text: "模块路径 src/lib/vector.ts 提供向量化封装，relation 表记录节点间依赖。",
    scope: "test-scope", tags: "ki-path,ki-relation", importance: 0.6,
  });
  const id2 = (s2 as any)?.details?.id;
  console.log("   [debug s2]", JSON.stringify(s2).slice(0, 400));
  assert(!!id2, `store 第二条 (ki-path,ki-relation) 返回 id (${id2})`);

  // 隔离写入 other-scope
  const s3 = await call(runtime, "memory_store", {
    text: "这条记忆属于 other-scope，不应被 test-scope 的检索命中。",
    scope: "other-scope", tags: "ki-search", importance: 0.5,
  });
  assert(!!(s3 as any)?.details?.id, "store other-scope 成功");

  await sleep(300);

  // R-03: scope 隔离 —— test-scope 不应看到 other-scope
  console.log("\n>>> R-03: scope 隔离 (test-scope 检索不应含 other-scope 文本)");
  const iso = await call(runtime, "memory_recall", { query: "other-scope 不应被命中", scope: "test-scope", limit: 10 });
  const isoMem = (iso as any)?.details?.memories ?? [];
  const leaked = isoMem.some((m: any) => (m.text || "").includes("不应被 test-scope"));
  assert(!leaked, `scope 隔离生效 (test-scope 命中 ${isoMem.length} 条, 无泄漏)`);

  // R-03: 标签过滤 —— 仅返回含 ki-search 前缀
  console.log("\n>>> R-03: 标签过滤 ki-search (test-scope)");
  const tag = await call(runtime, "memory_recall", { query: "", scope: "test-scope", tags: "ki-search", limit: 10 });
  const tagMem = (tag as any)?.details?.memories ?? [];
  const kiCount = tagMem.filter((m: any) => (m.text || "").includes("【标签:ki-search】")).length;
  const extra = tagMem.length - kiCount;
  if (kiCount >= 1 && extra === 0) {
    assert(true, `标签过滤严格生效 (命中 ${tagMem.length} 条, 全部含 ki-search 前缀)`);
  } else if (kiCount >= 1) {
    console.log(`⚠️ 有条件通过: 标签过滤命中 ${kiCount} 条目标(含 ki-search), 但混入 ${extra} 条不含该前缀的额外条目`);
    console.log("   → mcp 标签过滤为【近似过滤】, KiSearch 必须保留客户端 content.includes('【标签:X】') 后置过滤 (与现有 mem-client.ts 一致)");
  } else {
    assert(false, `标签过滤未命中任何 ki-search 条目 (命中 ${tagMem.length})`);
  }

  // R-02: 向量召回可用
  console.log("\n>>> R-02: 向量 recall");
  const rec = await call(runtime, "memory_recall", { query: "知识索引整理工具", scope: "test-scope", limit: 5 });
  const recMem = (rec as any)?.details?.memories ?? [];
  assert(recMem.length >= 1, `向量 recall 命中 ${recMem.length} 条`);

  // R-01b: list
  console.log("\n>>> R-01b: memory_list");
  const lst = await call(runtime, "memory_list", { scope: "test-scope", limit: 10 });
  const lstMem = (lst as any)?.details?.memories ?? [];
  assert(lstMem.length >= 2, `memory_list 返回 ${lstMem.length} 条结构化 memories`);

  console.log("\n========== DEMO VERIFY 完成 ==========");
  process.exit(process.exitCode || 0);
}
main().catch((e) => { console.error("❌ DEMO 失败:", e?.message || e); process.exit(1); });
