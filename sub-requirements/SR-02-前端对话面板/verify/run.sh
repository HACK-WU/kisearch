#!/usr/bin/env bash
# SR-02 验收脚本（必备四项：契约对齐 + 片级验收 + 越界检查 + 桩残留自检）
set -euo pipefail

SLICE="SR-02"
CODE_BASE="freeze/REQ-20260924-001"
CONTRACT_BASE="freeze/REQ-20260924-001"
OWNED_PATTERNS=(
  "web/src/chat/"
  "web/src/api/chatApi.ts"
  "web/src/api/chatContract.ts"
  "web/src/layouts/AppShell.tsx"
  "test/chat/acceptance-sr02.test.ts"
)
STUB_PATTERN="${STUB_PATTERN:-STUB:SR-02:}"

echo "① 前端编译（tsc）"
(cd web && npx tsc --noEmit)

echo "② 契约对齐（共享，必须保持绿）"
npx jiti test/chat/contract-parity.test.ts

echo "③ 片级验收测试（断言由上游给定，不可改）"
npx jiti test/chat/acceptance-sr02.test.ts

echo "④ 数据走向预演（用 mock SSE 驱动）"
# ★ 该文件【跨砖头】：它同时驱动前端 store 与后端 tool-loop。
#   单窗口期必然有部分用例红 —— 那些是【他片（SR-01）未完成】的预期红，不是本片缺陷。
#   处理：红时【不要改 src/**】，而是逐条确认失败项归属；属他片的记入报告、等拼接期重跑。
#   （`set -e` 会在此中止，故 ⑤⑥⑦ 需人工独立跑一遍——这是预期行为，不是脚本坏了。）
npx jiti test/chat/data-flow.test.ts

echo "⑤ 越界检查（从 CODE_BASE 算起）"
# ★ 排除【流程产物】：砖头包 / 脚手架不属于任何砖头的独占写，
#   它们常因流程修补而在冻结点之后被改动 → 不排除会把正常的流程提交误判成越界
git diff --name-only "${CODE_BASE}..HEAD" \
  | { grep -vE '^(sub-requirements/|\.delivery/)' || true; } \
  | while read -r f; do
  [[ -z "$f" ]] && continue
  ok=0
  for p in "${OWNED_PATTERNS[@]}"; do [[ "$f" == "$p"* ]] && ok=1; done
  [[ $ok -eq 1 ]] || { echo "❌ 越界：$f"; exit 1; }
done

echo "⑥ 桩残留自检（★ 必备：不依赖测试是否覆盖到）"
# ★ 用 grep 扫【工作区文件系统】而非 git grep：
#   git grep 只扫【已跟踪文件】，而实现期的桩正是【新建未提交】的 →
#   会漏扫 → 扫描恒为空 → 【假绿】（这条是实测发现的，比不扫更危险）
hits=$(grep -rn --include='*.ts' --include='*.tsx' -E "$STUB_PATTERN" web/src/ 2>/dev/null || true)
if [[ -n "$hits" ]]; then
  echo "❌ 桩残留（未实现）："; echo "$hits"; exit 1
fi

echo "⑦ 预检自跑（若已生成预检脚本）"
if [[ -x .delivery/premerge-check.sh ]]; then
  .delivery/premerge-check.sh --slice "${SLICE}"
else
  echo "（无预检脚本：本步跳过；①–⑥ 已独立跑过，不依赖它）"
fi

echo "✅ 全部通过"
echo "ℹ️ 未跑：他组测试（SR-01 的 contract-sr01 / acceptance-sr01）——不是你的职责"
echo "ℹ️ 需人工验收：D15 面板显隐不丢内容 / 来源引用点击回原文（见 slice.md §3 第 5/6 项）"
