// worker.mjs — 被 run.mjs 派生的子进程，扮演 holder（持锁方）或 prober（探测方）
// 用法: node worker.mjs <holder|prober> <rw|ro> <dataDir>
import { ZVecOpen, ZVecCreateAndOpen, ZVecCollectionSchema, ZVecDataType } from "@zvec/zvec";

const role = process.argv[2];      // holder | prober
const mode = process.argv[3];      // rw | ro
const dataDir = process.argv[4];
const readOnly = mode === "ro";

// 直接打开已存在的集合（run.mjs 已建好），不回退到 create —— 否则路径已存在会掩盖真实错误
function open() {
  return ZVecOpen(dataDir, { readOnly });
}

if (role === "holder") {
  const col = open();
  if (!readOnly) {
    try { col.insertSync([{ id: "holder_" + process.pid, vectors: { emb: [0.1, 0.2, 0.3, 0.4] } }]); } catch {}
  }
  console.log("HOLDING " + process.pid + " mode=" + mode);
  // 常驻持锁，等父进程 kill；用长定时器防止进程提前退出
  setInterval(() => {}, 1 << 30);
} else {
  const t0 = Date.now();
  try {
    const col = open();
    const elapsed = Date.now() - t0;
    const q = col.querySync({ fieldName: "emb", vector: [0.1, 0.2, 0.3, 0.4], topk: 3 });
    console.log("PROBE_OK " + elapsed + "ms readDocs=" + q.length);
    try { col.closeSync(); } catch {}
    process.exit(0);
  } catch (e) {
    const elapsed = Date.now() - t0;
    const msg = e && e.message ? e.message : String(e);
    console.log("PROBE_FAIL " + elapsed + "ms err=" + msg);
    process.exit(0);
  }
}
