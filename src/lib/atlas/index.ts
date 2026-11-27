/**
 * 图集内核门面。
 *
 * 所有入口（CLI `ki atlas`、HTTP `GET /api/atlas/*`、二期页面上传）都只从这里取能力，
 * 不在入口层重复实现校验（设计 S01 §3.3：校验链只有一份）。
 */
export { installPackage, readStatus, readEntry, removePackage } from './package.js';
export { receiveChunk, cleanupStaleUploads, STALE_UPLOAD_MS } from './upload.js';
export type { ChunkPayload, ChunkResult } from './upload.js';
export { AtlasError, ATLAS_CODES, atlasCodeName, atlasHttpStatus, describeAtlasError } from './errors.js';
export type { AtlasCodeKey } from './errors.js';
export { entryPath, packageZipPath, metaPath, archiveDir, atlasDir } from './paths.js';
export { MAX_ENTRY_BYTES, MAX_ENTRIES, MAX_UNZIPPED_TOTAL, MAX_ZIP_BYTES } from './zip-read.js';
export { resolveAtlasMap, atlasScopeFor, mainScopeFor, isAtlasScope, AtlasScopeMapError, DEFAULT_ATLAS_SUFFIX } from './scope-map.js';
export type { AtlasScopeMap } from './scope-map.js';
export type { AtlasMeta, AtlasStatus, AtlasZipEntry, InstallOptions, InstallResult } from './types.js';
