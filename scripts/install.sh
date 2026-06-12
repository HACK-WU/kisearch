#!/usr/bin/env bash
# ============================================================
# Knowledge-Indexer 安装器 — 下载 Skills / Rules / Docs
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install.sh | bash -s -- /path/to/target --skills
#   curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install.sh | bash -s -- /path/to/target --rules
#   curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install.sh | bash -s -- /path/to/target --docs
#   curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install.sh | bash -s -- /path/to/target --all
#
#   或:
#   curl -fsSL ... -o ki-install.sh
#   bash ki-install.sh /path/to/target --skills
# ============================================================
set -euo pipefail

GITHUB_REPO="HACK-WU/knowledge-indexer"
GITHUB_BRANCH="master"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}"

TARGET_DIR=""
MODES=()

for arg in "$@"; do
    case "$arg" in
        --skills) MODES+=("skills") ;;
        --rules)  MODES+=("rules")  ;;
        --docs)   MODES+=("docs")   ;;
        --all)     MODES=("skills" "rules" "docs") ;;
        -*)        echo "未知选项: $arg"; exit 1 ;;
        *)         TARGET_DIR="$arg" ;;
    esac
done

if [ -z "$TARGET_DIR" ] || [ ${#MODES[@]} -eq 0 ]; then
    echo "用法: bash install.sh <目标项目路径> --skills|--rules|--docs|--all"
    echo ""
    echo "  目标项目路径    安装到的项目根目录"
    echo "  --skills        安装 AI Agent Skills（skills/）"
    echo "  --rules         安装加载引导规则（rules/）"
    echo "  --docs          安装操作指南与设计文档（docs/）"
    echo "  --all           安装全部（skills + rules + docs）"
    echo ""
    echo "  可组合使用：--skills --rules"
    echo ""
    echo "示例:"
    echo "  bash install.sh ~/projects/my-app --skills"
    echo "  bash install.sh ~/projects/my-app --skills --rules"
    echo "  bash install.sh ~/projects/my-app --all"
    echo ""
    echo "一键安装 Skills:"
    echo "  curl -fsSL ${RAW_BASE}/scripts/install.sh | bash -s -- ~/projects/my-app --skills"
    exit 1
fi

if [ ! -d "$TARGET_DIR" ]; then
    echo "创建目标目录: $TARGET_DIR"
    mkdir -p "$TARGET_DIR"
fi

download() {
    local url="$1" dest="$2"
    mkdir -p "$(dirname "$dest")"
    if curl -fsSL "$url" -o "$dest" 2>/dev/null; then
        return 0
    else
        rm -f "$dest" 2>/dev/null
        return 1
    fi
}

NORMALIZED_DIR="${TARGET_DIR%/}"

install_skills() {
    if [ "${NORMALIZED_DIR##*/}" = "skills" ]; then
        DEST="$NORMALIZED_DIR"
    else
        DEST="$NORMALIZED_DIR/skills"
    fi
    mkdir -p "$DEST"

    FILES=(
        "ki-foundation/SKILL.md"
        "codekb-skill/SKILL.md"
        "memory-skill/SKILL.md"
    )

    echo "🧠 安装 AI Skills → ${DEST}"
    echo ""

    count=0
    for f in "${FILES[@]}"; do
        url="${RAW_BASE}/skills/${f}"
        dest="${DEST}/${f}"
        if download "$url" "$dest"; then
            echo "  [OK] ${f}"
            count=$((count + 1))
        else
            echo "  [FAIL] ${f}"
        fi
    done
    echo ""
    echo "已安装: ${count}/${#FILES[@]}"
}

install_rules() {
    if [ "${NORMALIZED_DIR##*/}" = "rules" ]; then
        DEST="$NORMALIZED_DIR"
    else
        DEST="$NORMALIZED_DIR/rules"
    fi
    mkdir -p "$DEST"

    FILES=(
        "skill-load-guide.md"
    )

    echo "📋 安装 Rules → ${DEST}"
    echo ""

    count=0
    for f in "${FILES[@]}"; do
        url="${RAW_BASE}/rules/${f}"
        dest="${DEST}/${f}"
        if download "$url" "$dest"; then
            echo "  [OK] ${f}"
            count=$((count + 1))
        else
            echo "  [FAIL] ${f}"
        fi
    done
    echo ""
    echo "已安装: ${count}/${#FILES[@]}"
}

install_docs() {
    if [ "${NORMALIZED_DIR##*/}" = "docs" ]; then
        DEST="$NORMALIZED_DIR"
    else
        DEST="$NORMALIZED_DIR/docs"
    fi
    mkdir -p "$DEST"

    FILES=(
        "architecture.md"
        "backup-restore.md"
        "build-kb.md"
        "cli.md"
        "codekb-agent-guide.md"
        "error-handling.md"
        "import-kb.md"
        "ki-command-guide.md"
        "manage-index.md"
        "memory-agent-guide.md"
        "memory-system-dataflow.md"
        "memory-system-requirements.md"
        "query-kb.md"
        "restore-data.md"
        "scan-kb.md"
        "update-kb.md"
        "verify-index.md"
        "workflows.md"
    )

    echo "📖 安装 Docs → ${DEST}"
    echo ""

    count=0
    for f in "${FILES[@]}"; do
        url="${RAW_BASE}/docs/${f}"
        dest="${DEST}/${f}"
        if download "$url" "$dest"; then
            echo "  [OK] ${f}"
            count=$((count + 1))
        else
            echo "  [FAIL] ${f}"
        fi
    done
    echo ""
    echo "已安装: ${count}/${#FILES[@]}"
}

# ============================================================
# 按模式执行
# ============================================================
for mode in "${MODES[@]}"; do
    case "$mode" in
        skills) install_skills ;;
        rules)  install_rules  ;;
        docs)   install_docs   ;;
    esac
    echo ""
done

echo "✅ 完成: ${TARGET_DIR}"
