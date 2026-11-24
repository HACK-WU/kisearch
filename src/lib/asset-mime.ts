/**
 * 附件后缀 → MIME 的单一来源。
 *
 * 为什么单独成文件（而不是从 `asset-image.ts` 直接 import）：
 * `asset-image.ts` 依赖 `import.js`（引用提取）与 `svg-raster.js`（worker_threads），
 * 而 `/api/asset`、`/open/v1/asset` 只需要这张白名单表，不需要导入内核与 worker。
 * 从 `asset-image.ts` 直接 import 会把整个导入内核拉进 HTTP 模块图 ——
 * `open-api/routes/ping.ts` 的 `DEFAULT_MAX_*` 动态 import 就是为了躲同一件事。
 *
 * 后缀集合与 `import.ts` 的 `ASSET_EXTENSIONS` 对应；新增后缀必须两处同步。
 */
export const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};
