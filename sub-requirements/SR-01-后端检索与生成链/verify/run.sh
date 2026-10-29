#!/usr/bin/env bash
# SR-01 验收脚本（必备四项：契约测试 + 片级验收 + 越界检查 + 桩残留自检）
# 缺项则该片的"绿"不可信。
set -euo pipefail

SLICE="SR-01"
# ★ 两个基线不可混用：
#   CODE_BASE    = 从哪算改动 → 越界检查用它（单批 = 冻结点；分批 = 上批合入后）
#   CONTRACT_BASE = 本包实现的是哪版契约 → 仅记录，供拼接期门⑤ 比对
CODE_BASE="freeze/REQ-20260924-001"
CONTRACT_BASE="freeze/REQ-20260924-001"
OWNED_PATTERNS=(
  "src/lib/chat/"
  "src/lib/config.ts"
  "src/lib/config-schema.ts"
  "src/lib/mcp-http-api.ts"
  "test/chat/contract-sr01.test.ts"
  "test/chat/acceptance-sr01.test.ts"
  "test/chat/permissions-sr01.test.ts"
  # ★ 路由级端到端（2026-09-26 修复期新增）：编辑重发/重新生成的**落盘**正确性
  "test/chat/e2e-sr01-edit.test.ts"
)
# 桩标记来源与 premerge-check.sh 同源（.delivery/stub-pattern）
STUB_PATTERN="${STUB_PATTERN:-STUB:SR-01:}"

echo "① 编译（主干必须常绿）"
# ★ 必须用 tsconfig.json（include: src/**/*.ts），**不是** tsconfig.src.json：
#   后者的 include 只含 src/zvec-engine/**、rootDir=src/zvec-engine →
#   对 src/lib/chat/** 覆盖为 0（实测 --listFiles 匹配数 = 0），编译检查会【假绿】
npx tsc -p tsconfig.json --noEmit

echo "② 本砖头组契约测试（★ 只跑本组，不跑他组）"
npx jiti test/chat/contract-sr01.test.ts

echo "③ 片级验收测试（断言由上游给定，不可改）"
npx jiti test/chat/acceptance-sr01.test.ts

echo "④ 数据走向预演（全 mock，本窗口期应【绿】）"
npx jiti test/chat/data-flow.test.ts

echo "⑤ 契约对齐（共享，应保持绿）"
npx jiti test/chat/contract-parity.test.ts

echo "⑤b 路由级端到端：编辑重发/重新生成（★ 真实 HTTP + 真实落盘，抓「接线处」缺陷）"
# ★ 为什么单列：本片缺陷（edit 走 replaceLastAssistant 吃掉 user 消息）发生在
#   route 与两个 store 原语的**接线处** —— acceptance 的 store 级单测与形状断言都覆盖不到。
npx jiti test/chat/e2e-sr01-edit.test.ts

echo "⑥ 越界检查（只看【本分支独有】的提交，不是契约基线）"
# ★ 为什么不是 `diff ${CODE_BASE}..HEAD`：窗口为了拿包修补会 merge 主干，
#   而主干上的【流程修补】可能触及任意文件（例：修 chat-store.ts 的注释）→
#   直接 diff 会把它算进"本窗口的改动" → 【误报】。
#   正确口径 = 本分支独有、且【非合并】的提交所触及的文件。
MAIN_BRANCH="${MAIN_BRANCH:-feat/sidebar-ai-chat}"
if git rev-parse --verify "$MAIN_BRANCH" >/dev/null 2>&1; then
  OWN_FILES=$(git -c core.quotePath=false log --no-merges --name-only --format= "${MAIN_BRANCH}..HEAD" \
              | sed '/^$/d' | sort -u || true)
else
  echo "  ⚠️ 找不到主干分支 ${MAIN_BRANCH} → 退化为 diff ${CODE_BASE}..HEAD（可能含主干修补，留意误报）"
  OWN_FILES=$(git -c core.quotePath=false diff --name-only "${CODE_BASE}..HEAD")
fi
printf '%s\n' "$OWN_FILES" \
  | { grep -vE '^(sub-requirements/|\.delivery/)' || true; } \
  | while read -r f; do
  [[ -z "$f" ]] && continue
  ok=0
  for p in "${OWNED_PATTERNS[@]}"; do [[ "$f" == "$p"* ]] && ok=1; done
  [[ $ok -eq 1 ]] || { echo "❌ 越界：$f"; exit 1; }
done

echo "⑦ 桩残留自检（★ 必备：不依赖测试是否覆盖到）"
# ★ 用 grep 扫【工作区文件系统】而非 git grep：
#   git grep 只扫【已跟踪文件】，而实现期的桩正是【新建未提交】的 →
#   会漏扫 → 扫描恒为空 → 【假绿】（这条是实测发现的，比不扫更危险）
hits=$(grep -rn --include='*.ts' --include='*.tsx' -E "$STUB_PATTERN" src/ 2>/dev/null || true)
if [[ -n "$hits" ]]; then
  echo "❌ 桩残留（接口未实现）："; echo "$hits"; exit 1
fi

echo "⑧ 预检自跑（若已生成预检脚本）"
# ★ 用 if/else，不用 `cmd && ... || echo "跳过"`——后者会把【脚本执行失败】也渲染成"跳过"
if [[ -x .delivery/premerge-check.sh ]]; then
  .delivery/premerge-check.sh --slice "${SLICE}"
else
  echo "（无预检脚本：本步跳过；①–⑦ 已独立跑过，不依赖它）"
fi

echo "✅ 全部通过"
echo "ℹ️ 未跑：他组测试（SR-02 的 acceptance-sr02）——它在本人窗口期本就该红/不跑，不是你的职责"
