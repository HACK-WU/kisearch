import glob, os, json, random, sys

N = int(sys.argv[1]) if len(sys.argv) > 1 else 100
OUT = sys.argv[2] if len(sys.argv) > 2 else "zvec-probe/.bulk100.json"
random.seed(42)
ps = sorted(glob.glob('/root/bk-monitor/ai-docs/**/*.md', recursive=True))
ps = ps[:N]
docs = []
for i, p in enumerate(ps):
    t = open(p, encoding='utf-8', errors='ignore').read()[:6000]
    if len(t.strip()) < 30:
        continue
    did = f"d{i:03d}"
    docs.append({"text": f"[ZVECCMP][DOCID:{did}] " + t,
                 "tags": "zveccmp", "category": "fact"})
json.dump(docs, open(OUT, 'w'), ensure_ascii=False)
print(f"wrote {len(docs)} items -> {OUT}")
