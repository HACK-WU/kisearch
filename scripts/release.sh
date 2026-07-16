#!/usr/bin/env bash
# 发布脚本：构建 npm 包并创建 GitHub Release，上传 tarball
# 用法: ./scripts/release.sh <version> [prerelease]
# 示例:
#   ./scripts/release.sh 0.2.0              # 发布正式版
#   ./scripts/release.sh 0.2.0-beta.1 true  # 发布预发布版

set -euo pipefail

VERSION="${1:?请指定版本号，例如: $0 0.2.0}"
PRERELEASE="${2:-false}"
PKG_NAME="KiSearch"
TARBALL="${PKG_NAME}-${VERSION}.tgz"
REPO="HACK-WU/KiSearch"

echo "==> 发布版本: ${VERSION}"

# 1. 确认版本号与 package.json 一致
PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" != "$VERSION" ]; then
  echo "错误: package.json 版本为 ${PKG_VERSION}，与指定版本 ${VERSION} 不一致"
  echo "请先运行: npm version ${VERSION} --no-git-tag-version"
  exit 1
fi

# 2. 确认工作区干净（无未提交的变更）
if ! git diff-index --quiet HEAD --; then
  echo "错误: 工作区有未提交的变更，请先提交或暂存"
  git status --short
  exit 1
fi

# 3. 确认关键文件存在
echo "==> 检查关键文件..."
for f in bin/ki.mjs scripts/mcp-server.ts README.md package.json; do
  if [ ! -f "$f" ]; then
    echo "错误: 关键文件 $f 不存在"
    exit 1
  fi
done
echo "  ✅ 关键文件检查通过"

# 4. 运行测试
echo "==> 运行测试..."
if ! npm test 2>&1 | tail -3; then
  echo "错误: 测试未通过，拒绝发布"
  exit 1
fi
echo "  ✅ 测试通过"

# 5. 打包（npm pack 根据 package.json files 字段打包）
echo "==> 打包 ${TARBALL}..."
npm pack

if [ ! -f "${TARBALL}" ]; then
  echo "错误: 打包文件 ${TARBALL} 未生成"
  exit 1
fi

echo "==> 打包内容:"
tar -tzf "${TARBALL}" | head -20 || true
echo "  ... (共 $(tar -tzf "${TARBALL}" | wc -l | tr -d ' ') 个文件)"
echo "==> 打包文件大小: $(du -h ${TARBALL} | cut -f1)"

# 6. 创建/覆盖 git tag
TAG="v${VERSION}"
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "==> tag ${TAG} 已存在，覆盖..."
  git tag -d "$TAG"
  git push origin ":refs/tags/${TAG}" 2>/dev/null || true
fi
echo "==> 创建 tag: ${TAG}"
git tag --no-sign "$TAG" -m "Release ${TAG}"

# 7. 推送 tag
echo "==> 推送 tag 到远程..."
git push origin "$TAG" --force

# 8. 创建 GitHub Release 并上传 tarball
RELEASE_NOTES="## 📦 ${PKG_NAME} ${TAG}

\`ki mcp\` 启动 MCP Server，暴露 8 个工具（query_group / get_module_info / search / manage_index / sync_relation / store / bulk_store）。

### 安装

\`\`\`bash
npm install -g https://github.com/${REPO}/releases/download/${TAG}/${TARBALL}
\`\`\`

### MCP 配置

\`\`\`json
{ \"mcpServers\": { \"ki\": { \"command\": \"ki\", \"args\": [\"mcp\"] } } }
\`\`\`"

if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  # 如果 Release 已存在，先删除再重建
  if gh release view "$TAG" &>/dev/null 2>&1; then
    echo "==> Release ${TAG} 已存在，删除旧版本..."
    gh release delete "$TAG" --yes --cleanup-tag 2>/dev/null || true
    # 重新创建 tag（被 gh 删掉了）
    git tag --no-sign "$TAG" -m "Release ${TAG}"
    git push origin "$TAG" --force
  fi

  echo "==> 创建 GitHub Release ${TAG}..."
  if [ "$PRERELEASE" = "true" ]; then
    gh release create "$TAG" "${TARBALL}" \
      --title "${TAG}" \
      --notes "${RELEASE_NOTES}" \
      --prerelease
  else
    gh release create "$TAG" "${TARBALL}" \
      --title "${TAG}" \
      --notes "${RELEASE_NOTES}"
  fi
  echo ""
  echo "==> ✅ 发布完成!"
  echo ""
  echo "==> 安装命令:"
  echo "    npm install -g https://github.com/${REPO}/releases/download/${TAG}/${TARBALL}"
else
  echo ""
  echo "==> ⚠️  gh CLI 未认证，请手动创建 Release："
  echo ""
  echo "    1. 在 GitHub 上创建 Release: https://github.com/${REPO}/releases/new"
  echo "    2. Tag: ${TAG}"
  echo "    3. 上传文件: ${TARBALL}"
  echo "    4. 或者运行以下命令（需要先 gh auth login）："
  echo ""
  echo "    gh release create ${TAG} ${TARBALL} --title '${TAG}' --notes '${RELEASE_NOTES}'"
  echo ""
  echo "    打包文件已保存在: ${TARBALL}"
  echo ""
  echo "==> 安装命令:"
  echo "    npm install -g https://github.com/${REPO}/releases/download/${TAG}/${TARBALL}"
fi

# 9. 提示清理
echo ""
echo "==> 发布完成后可手动清理: rm -f ${TARBALL}"
