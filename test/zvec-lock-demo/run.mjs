// run.mjs — 编排器：先建库，再按 4 种组合派生 holder+prober，判定跨进程锁行为
import { spawn } from "node:child_process";
import { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecDataType } from "@zvec/zvec";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data");

// 1) 先建好集合（含一条种子数据），保证后续 open 路径确定
const schema = new ZVecCollectionSchema({
  name: "locktest",
  vectors: [{ name: "emb", dataType: ZVecDataType.VECTOR_FP32, dimension: 4 }],
});
const seed = ZVecCreateAndOpen(DATA, schema);
seed.insertSync([{ id: "seed", vectors: { emb: [0.1, 0.2, 0.3, 0.4] } }]);
seed.closeSync();
console.log("[orchestrator] seeded collection at " + DATA + "\n");

const PROBE_TIMEOUT = 15000;

function spawnWorker(role, mode) {
  const p = spawn("node", [path.join(__dirname, "worker.mjs"), role, mode, DATA], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const buf = { out: "", err: "" };
  p.stdout.on("data", (d) => (buf.out += d.toString()));
  p.stderr.on("data", (d) => (buf.err += d.toString()));
  return { p, buf };
}

function waitForMarker(worker, marker, limitMs = 8000) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (worker.buf.out.includes(marker)) { clearInterval(t); resolve(true); }
    }, 50);
    setTimeout(() => { clearInterval(t); resolve(worker.buf.out.includes(marker)); }, limitMs);
  });
}

function waitProbeResult(worker, timeout) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const o = worker.buf.out;
      if (o.includes("PROBE_OK") || o.includes("PROBE_FAIL")) {
        clearInterval(t);
        const line = o.split("\n").find((l) => l.startsWith("PROBE_")) || o.trim();
        const err = worker.buf.err.trim();
        resolve(err ? line + " | stderr: " + err : line);
      }
    }, 50);
    setTimeout(() => {
      clearInterval(t);
      resolve("PROBE_BLOCKED (no PROBE_ line within " + timeout + "ms — 进程仍存活，大概率在等锁释放)");
    }, timeout);
  });
}

async function scenario(name, holderMode, proberMode) {
  console.log("=== " + name + "  [holder=" + holderMode + ", prober=" + proberMode + "] ===");
  const holder = spawnWorker("holder", holderMode);
  await waitForMarker(holder, "HOLDING");

  const prober = spawnWorker("prober", proberMode);
  const result = await waitProbeResult(prober, PROBE_TIMEOUT);

  try { prober.p.kill("SIGKILL"); } catch {}
  try { holder.p.kill("SIGKILL"); } catch {}
  console.log("  结果: " + result + "\n");
}

await scenario("A: 常驻写者(rw) 持锁，CLI 读探(ro)", "rw", "ro");
await scenario("B: 常驻写者(rw) 持锁，CLI 写探(rw)", "rw", "rw");
await scenario("C: 常驻读者(ro) 持锁，CLI 读探(ro)", "ro", "ro");
await scenario("D: 常驻读者(ro) 持锁，CLI 写探(rw)", "ro", "rw");

console.log("[orchestrator] 全部场景结束");
