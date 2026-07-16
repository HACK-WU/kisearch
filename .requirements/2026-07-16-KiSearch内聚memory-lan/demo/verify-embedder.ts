/**
 * verify-embedder.ts — 直接测插件 embedder (绕开 lancedb)
 * 运行: timeout -s KILL 60 node_modules/.bin/jiti .demo-verify/verify-embedder.ts
 */
import { createEmbedder } from "memory-lancedb-pro/src/embedder.ts";

const config = {
  provider: "openai-compatible" as const,
  apiKey: "sk-nhucdyuoykanymnkptpnbllswqqivhqaqmlefnxzyfjnjehg",
  model: "Qwen/Qwen3-Embedding-8B",
  baseURL: "https://api.siliconflow.cn/v1",
  dimensions: 4096,
};

async function main() {
  console.log("[1] createEmbedder start");
  const emb = createEmbedder(config);
  console.log("[2] embedder created, dims=", emb.dimensions, "model=", emb.model);

  console.log("[3] embedPassage('test') start");
  const v = await emb.embedPassage("test");
  console.log("[4] embedPassage OK len=", v.length);

  console.log("[5] embedQuery('知识索引') start");
  const q = await emb.embedQuery("知识索引整理工具");
  console.log("[6] embedQuery OK len=", q.length);

  console.log("[7] test() start");
  const t = await emb.test();
  console.log("[8] test()=", JSON.stringify(t));

  console.log("[9] DONE");
  process.exit(0);
}
main().catch((e) => { console.error("[ERR]", e?.message || e); process.exit(1); });
