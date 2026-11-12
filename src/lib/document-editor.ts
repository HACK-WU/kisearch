/** Browse 在线编辑：精确读取、乐观锁和按 wikiSync.sourceDir 配置保存。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, getScopeWikiSync } from './config.js';
import { getKbDir, getLocalKbDir } from './scope.js';
import { loadGroupCache, readAllGroupCaches } from './group-cache.js';
import { readJson, writeJson } from './store.js';
import { contentRevision, createDraft, loadDraft, saveDraft, type RelationEditDraft } from './relation-edit-draft.js';
import { readLiveRelation, relationIndexMode } from './relation-edit-live.js';
import type { Relation } from './scoring.js';
import { discardUnpublishedIndex, finishRelationEditNow } from './relation-edit-publish.js';
import { assertNoPendingVectorMigration } from './vector-client.js';

interface RelationRecord {
  text: string;
  sourcePath?: string;
  tags?: string[];
  ftsIndexComplete?: boolean;
}
interface RelationCache {
  groups: Record<string, { hot_relations: RelationRecord[] }>;
}

export interface DocumentIdentity { scope: string; group: string; relation: string }
export interface EditDocumentInput extends DocumentIdentity {
  content: string;
  expectedRevision: string;
  expectedSourceRevision?: string;
  vectorize?: boolean;
  editId?: string;
  /**
   * 强制以 KB 为准覆盖源文件（REQ「强制保存」）：跳过**源文件侧**全部三道校验。
   *
   * 覆盖范围严格限定在源文件侧 —— KB 侧乐观锁（`DOC_EDIT_CONFLICT`）与索引发布链路不受影响，
   * 否则强制保存会变成「谁最后点谁赢」的并发覆写。用户 2026-11-12 拍板：加载后源文件又变化也覆盖。
   */
  force?: boolean;
}

/** 源文件校验错误分类：只有 `CONTENT_DIVERGED` 允许用户选择强制覆盖 */
export type SourceErrorCode = 'CONTENT_DIVERGED' | 'SOURCE_MISMATCH' | 'SOURCE_UNAVAILABLE' | 'SOURCE_DISABLED';

export class DocumentEditError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly details?: Record<string, unknown>) {
    super(message);
  }
}

function reject(status: number, code: string, message: string, details?: Record<string, unknown>): never {
  throw new DocumentEditError(status, code, message, details);
}

function validateIdentity(input: DocumentIdentity): void {
  if (!input.scope || !input.group || !input.relation) reject(400, 'DOC_ID_INVALID', '缺少 scope、group 或文档名');
  if (!input.group.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'))
    || /[\\/\u0000]/.test(input.relation) || input.relation === '.' || input.relation === '..') {
    reject(400, 'DOC_ID_INVALID', '文档路径或名称不合法');
  }
}

function loadDocument(identity: DocumentIdentity): { relation: RelationRecord; content: string; kbPath: string } {
  validateIdentity(identity);
  // 批次 2（W6/R12）：单组读双轨（文档编辑器加载只需目标组）
  const relation = loadGroupCache(identity.scope, identity.group)
    ?.hot_relations.find((item) => item.text === identity.relation);
  if (!relation) reject(404, 'DOC_NOT_FOUND', '文档不存在');
  const kbPath = getLocalKbDir(identity.scope, identity.group);
  const content = readJson<Record<string, string>>(kbPath)?.[identity.relation];
  if (typeof content !== 'string') reject(404, 'DOC_NOT_FOUND', '文档原文不存在');
  return { relation, content, kbPath };
}

/**
 * wiki 回写目标根目录：**只认**配置里的 `wikiSync.sourceDir`（2026-11-12 用户裁定）。
 *
 * `group-index.json` 的 `source` 块是「导入源目录」，上传方式导入时它指向
 * `/root/.ki/import-uploads/<uuid>` 这份**临时副本**。此前它优先级更高，导致：
 * 编辑保存 / 添加链接 / ki_edit_relation 全部写回副本，而用户在 config 里显式配的
 * `wikiSync.sourceDir` 被静默忽略 —— 用户改了正文却在自己仓库里看不到任何变化。
 *
 * 新口径：开启 wiki 回写（`wikiSync.enabled !== false`）且配了 `sourceDir` 才写回文件；
 * 否则只写 KB，一个文件都不碰。
 */
function configuredSourceDir(scope: string): string | undefined {
  const config = getScopeWikiSync(loadConfig(), scope);
  // `config?.enabled !== false` 不会把 config 收窄为非 null，后半段必须再带可选链
  return config?.enabled !== false && config?.sourceDir ? config.sourceDir : undefined;
}

function resolveSource(identity: DocumentIdentity, relation: RelationRecord): string | undefined {
  const root = configuredSourceDir(identity.scope);
  if (!root) return undefined;
  const rel = relation.sourcePath?.replace(/\\/g, '/');
  if (!rel || rel.includes('#') || path.posix.isAbsolute(rel)
    || rel.split('/').some((part) => !part || part === '.' || part === '..')) {
    reject(409, 'SOURCE_MISMATCH', '文档缺少可唯一定位的 wiki 回写目标路径');
  }
  // 批次 2（W6）：全量读双轨（sourcePath owner 唯一性判定需枚举全部 relation）
  const owners = [...readAllGroupCaches(identity.scope).values()].flatMap((entry) => entry.hot_relations)
    .filter((item) => item.sourcePath?.replace(/\\/g, '/') === rel);
  if (owners.length !== 1) reject(409, 'SOURCE_MISMATCH', `wiki 回写目标被 ${owners.length} 个 KB 文档引用，不能唯一写回`);
  const stem = path.posix.basename(rel).replace(/\.(?:md|markdown)$/i, '');
  if (stem === path.posix.basename(rel) || stem !== identity.relation) {
    reject(409, 'SOURCE_MISMATCH', `wiki 回写目标文件名与 KB 文档名不一致：${rel} ↔ ${identity.relation}`);
  }
  const relativeDir = path.posix.dirname(rel);
  if (relativeDir !== '.' && identity.group !== relativeDir && !identity.group.endsWith(`/${relativeDir}`)) {
    reject(409, 'SOURCE_MISMATCH', `wiki 回写目标子路径与 KB Group 不一致：${rel} ↔ ${identity.group}`);
  }
  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = fs.realpathSync(root);
    const rootStat = fs.statSync(rootReal);
    if (rootStat.isFile()) {
      if (rel !== path.basename(rootReal)) reject(409, 'SOURCE_MISMATCH', '单文件导入的 sourcePath 与配置的 wiki 回写目标不一致');
      fileReal = rootReal;
    } else {
      fileReal = fs.realpathSync(path.resolve(rootReal, rel));
    }
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    reject(409, 'SOURCE_UNAVAILABLE', `配置的 wiki 回写目标不可用：${(error as Error).message}`);
  }
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) {
    reject(409, 'SOURCE_MISMATCH', 'wiki 回写目标不在配置的 sourceDir 内');
  }
  try {
    if (!fs.statSync(fileReal).isFile()) reject(409, 'SOURCE_MISMATCH', 'wiki 回写目标不是文件');
    fs.accessSync(fileReal, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    reject(409, 'SOURCE_UNAVAILABLE', `wiki 回写目标不可读写：${(error as Error).message}`);
  }
  return fileReal;
}

/**
 * 该 scope 是否登记了数据源（供「以源为准」的提示用，前端**只展示不可点**）。
 *
 * 之所以在这里顺手读：数据源是「导入上游」，wiki 回写目标是「导出下游」，两者分叉时
 * 用户最合理的动作往往是「先更新源数据、再同步」（2026-11-12 用户推定为此提示）。
 * 直接读 `datasource.json` 而不引 `datasource.ts`，避免编辑热路径背上整个数据源模块。
 */
function dataSourceHint(scope: string): { type: 'git' | 'directory'; target: string } | undefined {
  try {
    const file = path.join(getKbDir(scope), 'datasource.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      type?: string; dir?: string; git?: { remoteUrl?: string };
    };
    const target = raw.git?.remoteUrl ?? raw.dir;
    if (!target) return undefined;
    return { type: raw.type === 'git' ? 'git' : 'directory', target };
  } catch {
    return undefined;
  }
}

export function readDocumentForEdit(identity: DocumentIdentity) {
  const doc = loadDocument(identity);
  const sourceConfigured = Boolean(configuredSourceDir(identity.scope));
  let sourceRevision: string | undefined;
  let sourceError: string | undefined;
  let sourceErrorCode: SourceErrorCode | undefined;
  let sourceFile: string | undefined;
  if (sourceConfigured) {
    try {
      const file = resolveSource(identity, doc.relation)!;
      const sourceContent = fs.readFileSync(file, 'utf8');
      if (sourceContent !== doc.content) {
        // 主语必须是「wiki 回写目标」而不是「源文件」：后者会被读成数据源/导入源那份文档，
        // 用户根本不知道说的是哪个文件（2026-11-12 用户指出的歧义）。
        sourceError = 'wiki 回写目标文档与 KB 正文不一致';
        // 只有这一类允许用户选择「以 KB 覆盖回写目标」；下面的 SOURCE_* 属定位/权限问题，
        // 强制也写不进去（或会写错文件），前端据此决定是否露出强制入口。
        sourceErrorCode = 'CONTENT_DIVERGED';
        sourceFile = file;
      }
      sourceRevision = contentRevision(sourceContent);
    } catch (error) {
      sourceError = (error as Error).message;
      sourceErrorCode = error instanceof DocumentEditError
        ? (error.code as SourceErrorCode)
        : 'SOURCE_UNAVAILABLE';
    }
  }
  return {
    ok: true as const,
    ...identity,
    content: doc.content,
    revision: contentRevision(doc.content),
    indexMode: relationIndexMode(doc.relation as Relation),
    sourceConfigured,
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(sourceError ? { sourceError } : {}),
    ...(sourceErrorCode ? { sourceErrorCode } : {}),
    ...(sourceFile ? { sourceFile } : {}),
    // 仅分叉时给数据源提示：其余错误（定位/权限）与「以源为准」无关
    ...(sourceErrorCode === 'CONTENT_DIVERGED' ? { dataSource: dataSourceHint(identity.scope) } : {}),
    ...(!sourceConfigured ? { warning: '未开启 wiki 回写（未配置 wikiSync.sourceDir）：本次只更新 KB，不写任何文件' } : {}),
  };
}

function writeSourceAtomically(file: string, content: string, expectedContent: string): void {
  const tmp = `${file}.ki-edit-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    fs.chmodSync(tmp, fs.statSync(file).mode);
    if (fs.readFileSync(file, 'utf8') !== expectedContent) {
      reject(409, 'SOURCE_CONFLICT', 'wiki 回写目标在保存期间再次发生变化，请重新加载');
    }
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export async function saveDocumentEdit(input: EditDocumentInput) {
  assertNoPendingVectorMigration(input.scope);
  const doc = loadDocument(input);
  if (!input.expectedRevision || typeof input.content !== 'string' || !input.content.trim()) {
    reject(400, 'DOC_EDIT_INVALID', '保存需要非空正文和 expectedRevision');
  }
  const docRevision = contentRevision(doc.content);
  const targetRevision = contentRevision(input.content);
  if (doc.content !== input.content && docRevision !== input.expectedRevision) {
    reject(409, 'DOC_EDIT_CONFLICT', 'KB 正文已变化，请重新加载并比较差异');
  }

  const vectorize = input.vectorize === true;
  const mode = vectorize ? 'dense' : 'fts';
  const currentMode = relationIndexMode(doc.relation as Relation);
  const needsModeChange = currentMode !== mode;
  let editId = input.editId;
  let draft: RelationEditDraft | undefined;
  if (editId) {
    draft = loadDraft(input.scope, editId);
    if (draft.group !== input.group || draft.relation !== input.relation || !draft.skipWikiWriteback) {
      reject(409, 'DOC_EDIT_RETRY_MISMATCH', '重试请求与原保存草稿不一致，请重新加载文档');
    }
    if (draft.content === input.content && draft.targetMode === mode
      && draft.publishedRevision && docRevision !== draft.publishedRevision) {
      reject(409, 'DOC_EDIT_RETRY_CONFLICT', '该草稿发布后 KB 正文又发生变化，不能用旧草稿写回 wiki 回写目标');
    }
  }
  const publishedSourceRetry = Boolean(draft
    && draft.content === input.content
    && draft.targetMode === mode
    && draft.publishedRevision === targetRevision
    && docRevision === draft.publishedRevision);

  const file = resolveSource(input, doc.relation);
  let sourceContent: string | undefined;
  if (file) {
    try {
      sourceContent = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // 定位校验通过后在保存瞬间被删除 / 权限变化：强制保存也**不新建**文件，照旧 fail-loud
      reject(409, 'SOURCE_UNAVAILABLE', `wiki 回写目标在保存时不可读：${(error as Error).message}`);
    }
    if (!input.force) {
      const current = sourceContent!;
      const sourceRevision = contentRevision(current);
      const sourceMatchesLoadedVersion = Boolean(input.expectedSourceRevision)
        && sourceRevision === input.expectedSourceRevision;
      if (!sourceMatchesLoadedVersion) {
        reject(409, 'SOURCE_CONFLICT', 'wiki 回写目标在加载后发生变化，请重新加载并人工合并', {
          source: 'conflict', kb: 'unchanged', index: 'unchanged', sourcePath: file,
        });
      }
      // 新保存必须来自源文件与 KB 一致的读取基线。唯一例外是：索引/KB 已发布、
      // 源写回失败后，使用同一已发布草稿重试源写回。
      if (input.expectedRevision !== input.expectedSourceRevision && !publishedSourceRetry) {
        reject(409, 'SOURCE_CONFLICT', '加载时 wiki 回写目标与 KB 正文已分叉，请人工合并后重新加载', {
          source: 'conflict', kb: 'unchanged', index: 'unchanged', sourcePath: file,
        });
      }
      if (current !== doc.content && !publishedSourceRetry) {
        reject(409, 'SOURCE_CONFLICT', '保存前 wiki 回写目标与 KB 正文已分叉，请人工合并后重新加载', {
          source: 'conflict', kb: 'unchanged', index: 'unchanged', sourcePath: file,
        });
      }
    }
  }

  if (editId && draft) {
    if (draft.content !== input.content || draft.targetMode !== mode) {
      if (draft.publishedRevision) {
        const finished = await finishRelationEditNow(draft);
        if (finished.status !== 'published') reject(500, 'DOC_EDIT_CLEANUP_FAILED', finished.error ?? '旧草稿索引清理失败');
      } else {
        await discardUnpublishedIndex(draft);
        draft.status = 'cancelled';
        saveDraft(draft);
      }
      editId = undefined;
      draft = undefined;
    } else if (draft.status === 'failed' && draft.retryable === false && !draft.publishedRevision) {
      reject(409, 'DOC_EDIT_NOT_RETRYABLE', draft.error ?? '此编辑无法直接重试，请修改内容后重新保存');
    }
  }

  let indexedAs: 'fts' | 'dense' | 'unchanged' = 'unchanged';
  if (doc.content !== input.content || needsModeChange || editId) {
    if (!editId) {
      const live = readLiveRelation(input.scope, input.group, input.relation);
      if (live.revision !== docRevision) reject(409, 'DOC_EDIT_CONFLICT', 'KB 正文已变化');
      draft = createDraft({
        ...input, baseRevision: live.revision, baseMetadataRevision: live.metadataRevision,
        baseContent: live.content, targetMode: mode, skipWikiWriteback: true,
      });
      editId = draft.editId;
    }
    if (!draft) reject(500, 'DOC_EDIT_FAILED', '无法创建索引发布草稿');
    const result = draft.status === 'published' ? draft : await finishRelationEditNow(draft);
    if (result.status !== 'published') {
      const current = loadDocument(input);
      throw new DocumentEditError(500, 'DOC_INDEX_INCOMPLETE', result.error ?? '索引发布失败', {
        editId, retryable: result.retryable !== false || Boolean(result.publishedRevision),
        source: file ? 'unchanged' : 'not_configured',
        kb: current.content === input.content ? 'written' : 'unchanged',
        index: 'incomplete',
      });
    }
    indexedAs = mode;
  }
  let sourceWritten = false;
  if (file && sourceContent !== input.content) {
    try {
      writeSourceAtomically(file, input.content, sourceContent!);
      sourceWritten = true;
    } catch (error) {
      if (error instanceof DocumentEditError && error.status === 409) {
        throw new DocumentEditError(409, error.code, `KB 已保存，但${error.message}`, {
          editId, retryable: false, source: 'conflict', kb: 'written',
          index: indexedAs === 'unchanged' ? 'unchanged' : 'complete', sourcePath: file,
        });
      }
      throw new DocumentEditError(500, 'SOURCE_WRITE_FAILED', `KB 已保存，但 wiki 回写目标写入失败：${(error as Error).message}`, {
        editId, retryable: true, source: 'failed', kb: 'written',
        index: indexedAs === 'unchanged' ? 'unchanged' : 'complete', sourcePath: file,
      });
    }
  }
  return {
    ok: true as const,
    revision: contentRevision(input.content),
    sourceConfigured: Boolean(file),
    sourceWritten,
    /** 本次走的是「以 KB 覆盖源文件」的强制路径（前端据此给不同回执） */
    forced: input.force === true,
    fullTextUpdated: indexedAs === 'fts',
    vectorStored: indexedAs === 'dense',
    indexedAs,
    ...(!file ? { warning: '未开启 wiki 回写（未配置 wikiSync.sourceDir）：本次只更新 KB，未写任何文件' } : {}),
  };
}
