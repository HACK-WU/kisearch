#!/usr/bin/env bash
# ============================================================
# Knowledge-Indexer 安装器 — 下载 Skills / Rules
#
# 💡 推荐使用 ki setup（支持多目录、配置文件等）
#    详见: ki setup --help
#
# 用法:
#   bash install.sh --skills -t /path/to/target -t /path/to/target2
#   bash install.sh --rules --file /path/to/targets.txt
#   bash install.sh /path/to/target --skills   # 旧用法，兼容
#
#   或:
#   curl -fsSL ... -o ki-install.sh
#   bash ki-install.sh --skills -t /path/to/target
# ============================================================
set -euo pipefail

# 提示：推荐使用 ki setup（支持多目录、配置文件）
if [ -t 2 ]; then
    echo "💡 提示：推荐使用 ki setup，功能更强大" >&2
    echo "   curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install-latest.sh | bash && ki setup --skills" >&2
    echo "" >&2
fi

GITHUB_REPO="HACK-WU/knowledge-indexer"
GITHUB_BRANCH="master"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}"

DEFAULT_TARGETS_FILE="$HOME/.ki-targets"
POSITIONAL_TARGET=""
TARGETS=()
CONFIG_FILE=""
MODES=()

while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
        --skills)  MODES+=("skills") ;;
        --rules)   MODES+=("rules")  ;;
        --all)     echo "错误：--all 已废弃"; exit 1 ;;
        --docs)    echo "错误：--docs 已废弃"; exit 1 ;;
        -t)
            shift
            [ $# -eq 0 ] && { echo "错误：-t 需要参数"; exit 1; }
            TARGETS+=("$1")
            ;;
        --file)
            shift
            [ $# -eq 0 ] && { echo "错误：--file 需要参数"; exit 1; }
            CONFIG_FILE="$1"
            ;;
        --file=*)  CONFIG_FILE="${arg#*=}" ;;
        -*)
            echo "未知选项: $arg"
            exit 1
            ;;
        *)
            POSITIONAL_TARGET="$arg"
            ;;
    esac
    shift
done

# 互斥检查
if [ ${#TARGETS[@]} -gt 0 ] && [ -n "$CONFIG_FILE" ]; then
    echo "错误：-t 和 --file 不能同时使用"
    exit 1
fi

# 解析目标目录
if [ ${#TARGETS[@]} -gt 0 ]; then
    TARGET_DIRS=("${TARGETS[@]}")
    SOURCE_DESC="命令行参数 (-t × ${#TARGET_DIRS[@]})"
elif [ -n "$CONFIG_FILE" ]; then
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "错误：配置文件不存在: $CONFIG_FILE"
        exit 1
    fi
    TARGET_DIRS=()
    while IFS= read -r line; do
        line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        [ -z "$line" ] && continue
        [[ "$line" =~ ^# ]] && continue
        TARGET_DIRS+=("$line")
    done < "$CONFIG_FILE"
    if [ ${#TARGET_DIRS[@]} -eq 0 ]; then
        echo "错误：配置文件为空: $CONFIG_FILE"
        exit 1
    fi
    SOURCE_DESC="配置文件: $CONFIG_FILE"
elif [ -f "$DEFAULT_TARGETS_FILE" ]; then
    TARGET_DIRS=()
    while IFS= read -r line; do
        line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        [ -z "$line" ] && continue
        [[ "$line" =~ ^# ]] && continue
        TARGET_DIRS+=("$line")
    done < "$DEFAULT_TARGETS_FILE"
    SOURCE_DESC="默认配置: $DEFAULT_TARGETS_FILE"
elif [ -n "$POSITIONAL_TARGET" ]; then
    TARGET_DIRS=("$POSITIONAL_TARGET")
    SOURCE_DESC="位置参数"
else
    TARGET_DIRS=()
fi

if [ ${#TARGET_DIRS[@]} -eq 0 ] || [ ${#MODES[@]} -eq 0 ]; then
    echo "用法: bash install.sh [--skills|--rules] [-t <path>... | --file <path>]"
    echo ""
    echo "  --skills        安装 AI Agent Skills（skills/）"
    echo "  --rules         安装加载引导规则（rules/）"
    echo "  -t <path>       指定目标目录（可多次使用，与 --file 互斥）"
    echo "  --file <path>   指定目标目录配置文件（与 -t 互斥）"
    echo ""
    echo "兼容旧用法:"
    echo "  bash install.sh <目标路径> --skills"
    echo ""
    echo "示例:"
    echo "  bash install.sh --skills -t ~/projects/app -t ~/projects/api"
    echo "  bash install.sh --rules --file ~/my-targets.txt"
    echo ""
    echo "推荐使用 ki setup（支持多目录、配置文件）:"
    echo "  curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install-latest.sh | bash"
    echo "  ki setup --skills -t ~/projects/my-app"
    exit 1
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

    # 动态发现 skills 列表：优先 gh，降级为硬编码
    if command -v gh &> /dev/null; then
        SKILLS=$(gh api "repos/${GITHUB_REPO}/contents/skills" --jq '.[] | select(.type=="dir") | .name' 2>/dev/null)
    fi

    if [ -z "${SKILLS:-}" ]; then
        echo "⚠️  gh 不可用，使用静态 skill 列表（可能不是最新）" >&2
        SKILLS="codekb-skill
ki-foundation
memory-skill"
    fi

    echo "🧠 安装 AI Skills → ${DEST}"
    echo ""

    count=0
    total=0
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        total=$((total + 1))
        f="${name}/SKILL.md"
        url="${RAW_BASE}/skills/${f}"
        dest="${DEST}/${f}"
        if download "$url" "$dest"; then
            echo "  [OK] ${f}"
            count=$((count + 1))
        else
            echo "  [FAIL] ${f}"
        fi
    done <<< "$SKILLS"
    echo ""
    echo "已安装: ${count}/${total}"
}

install_rules() {
    if [ "${NORMALIZED_DIR##*/}" = "rules" ]; then
        DEST="$NORMALIZED_DIR"
    else
        DEST="$NORMALIZED_DIR/rules"
    fi
    mkdir -p "$DEST"

    # 动态发现 rules 列表：优先 gh，降级为硬编码
    if command -v gh &> /dev/null; then
        RULES=$(gh api "repos/${GITHUB_REPO}/contents/rules" --jq '.[] | select(.name | endswith(".md")) | .name' 2>/dev/null)
    fi

    if [ -z "${RULES:-}" ]; then
        echo "⚠️  gh 不可用，使用静态 rule 列表（可能不是最新）" >&2
        RULES="ai-codekb-memory.md"
    fi

    echo "📋 安装 Rules → ${DEST}"
    echo ""

    count=0
    total=0
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        total=$((total + 1))
        url="${RAW_BASE}/rules/${name}"
        dest="${DEST}/${name}"
        if download "$url" "$dest"; then
            echo "  [OK] ${name}"
            count=$((count + 1))
        else
            echo "  [FAIL] ${name}"
        fi
    done <<< "$RULES"
    echo ""
    echo "已安装: ${count}/${total}"
}

# ============================================================
# 按模式执行（支持多目标目录）
# ============================================================
echo "🚀 install.sh"
echo "   目标来源: ${SOURCE_DESC}"
echo "   目标数量: ${#TARGET_DIRS[@]}"
echo ""

for i in "${!TARGET_DIRS[@]}"; do
    TARGET_DIR="${TARGET_DIRS[$i]}"
    LABEL="[$(($i + 1))/${#TARGET_DIRS[@]}]"

    if [ ! -d "$TARGET_DIR" ]; then
        echo "${LABEL} 创建目标目录: $TARGET_DIR"
        mkdir -p "$TARGET_DIR"
    fi

    NORMALIZED_DIR="${TARGET_DIR%/}"

    for mode in "${MODES[@]}"; do
        case "$mode" in
            skills) install_skills ;;
            rules)  install_rules  ;;
        esac
        echo ""
    done
done

echo "✅ 完成"
