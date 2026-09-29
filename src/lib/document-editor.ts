/** Browse 在线编辑：精确读取、乐观锁和按 sourceDir 配置保存。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, getScopeWikiSync } from './config.js';
import { getLocalKbDir, getRelationsCachePath, getSource } from './scope.js';
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
}

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
  const cache = readJson<RelationCache>(getRelationsCachePath(identity.scope));
  const relation = cache?.groups?.[identity.group]?.hot_relations?.find((item) => item.text === identity.relation);
  if (!relation) reject(404, 'DOC_NOT_FOUND', '文档不存在');
  const kbPath = getLocalKbDir(identity.scope, identity.group);
  const content = readJson<Record<string, string>>(kbPath)?.[identity.relation];
  if (typeof content !== 'string') reject(404, 'DOC_NOT_FOUND', '文档原文不存在');
  return { relation, content, kbPath };
}

function configuredSourceDir(scope: string): string | undefined {
  const sourceDir = getSource(scope)?.dir;
  if (sourceDir) return sourceDir;
  const config = getScopeWikiSync(loadConfig(), scope);
  return config?.enabled && config.sourceDir ? config.sourceDir : undefined;
}

function resolveSource(identity: DocumentIdentity, relation: RelationRecord): string | undefined {
  const root = configuredSourceDir(identity.scope);
  if (!root) return undefined;
  if (getScopeWikiSync(loadConfig(), identity.scope)?.enabled === false) {
    reject(409, 'SOURCE_DISABLED', '已配置 wikiSync.enabled=false，不能写回源文件');
  }
  const rel = relation.sourcePath?.replace(/\\/g, '/');
  if (!rel || rel.includes('#') || path.posix.isAbsolute(rel)
    || rel.split('/').some((part) => !part || part === '.' || part === '..')) {
    reject(409, 'SOURCE_MISMATCH', '文档缺少可唯一定位的源文件路径');
  }
  const cache = readJson<RelationCache>(getRelationsCachePath(identity.scope));
  const owners = Object.values(cache?.groups ?? {}).flatMap((entry) => entry.hot_relations ?? [])
    .filter((item) => item.sourcePath?.replace(/\\/g, '/') === rel);
  if (owners.length !== 1) reject(409, 'SOURCE_MISMATCH', `源文件被 ${owners.length} 个 KB 文档引用，不能唯一写回`);
  const stem = path.posix.basename(rel).replace(/\.(?:md|markdown)$/i, '');
  if (stem === path.posix.basename(rel) || stem !== identity.relation) {
    reject(409, 'SOURCE_MISMATCH', `源文件名与 KB 文档名不一致：${rel} ↔ ${identity.relation}`);
  }
  const relativeDir = path.posix.dirname(rel);
  if (relativeDir !== '.' && identity.group !== relativeDir && !identity.group.endsWith(`/${relativeDir}`)) {
    reject(409, 'SOURCE_MISMATCH', `源文件子路径与 KB Group 不一致：${rel} ↔ ${identity.group}`);
  }
  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = fs.realpathSync(root);
    const rootStat = fs.statSync(rootReal);
    if (rootStat.isFile()) {
      if (rel !== path.basename(rootReal)) reject(409, 'SOURCE_MISMATCH', '单文件导入的 sourcePath 与配置源文件不一致');
      fileReal = rootReal;
    } else {
      fileReal = fs.realpathSync(path.resolve(rootReal, rel));
    }
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    reject(409, 'SOURCE_UNAVAILABLE', `配置的源目录或文件不可用：${(error as Error).message}`);
  }
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) {
    reject(409, 'SOURCE_MISMATCH', '源文件不在配置的 sourceDir 内');
  }
  try {
    if (!fs.statSync(fileReal).isFile()) reject(409, 'SOURCE_MISMATCH', '源路径不是文件');
    fs.accessSync(fileReal, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    reject(409, 'SOURCE_UNAVAILABLE', `源文件不可读写：${(error as Error).message}`);
  }
  return fileReal;
}

export function readDocumentForEdit(identity: DocumentIdentity) {
  const doc = loadDocument(identity);
  const sourceConfigured = Boolean(configuredSourceDir(identity.scope));
  let sourceRevision: string | undefined;
  let sourceError: string | undefined;
  if (sourceConfigured) {
    try {
      const file = resolveSource(identity, doc.relation)!;
      const sourceContent = fs.readFileSync(file, 'utf8');
      if (sourceContent !== doc.content) sourceError = '源文件与 KB 正文不一致，请先人工合并后再编辑';
      sourceRevision = contentRevision(sourceContent);
    } catch (error) {
      sourceError = (error as Error).message;
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
    ...(!sourceConfigured ? { warning: '未配置 sourceDir：保存只更新 KB；用旧源重导可能覆盖本次修改' } : {}),
  };
}

function writeSourceAtomically(file: string, content: string, expectedContent: string): void {
  const tmp = `${file}.ki-edit-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    fs.chmodSync(tmp, fs.statSync(file).mode);
    if (fs.readFileSync(file, 'utf8') !== expectedContent) {
      reject(409, 'SOURCE_CONFLICT', '源文件在保存期间再次发生变化，请重新加载');
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
      reject(409, 'DOC_EDIT_RETRY_CONFLICT', '该草稿发布后 KB 正文又发生变化，不能用旧草稿写回源文件');
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
    sourceContent = fs.readFileSync(file, 'utf8');
    const sourceRevision = contentRevision(sourceContent);
    const sourceMatchesLoadedVersion = Boolean(input.expectedSourceRevision)
      && sourceRevision === input.expectedSourceRevision;
    if (!sourceMatchesLoadedVersion) {
      reject(409, 'SOURCE_CONFLICT', '源文件在加载后发生变化，请重新加载并人工合并', {
        source: 'conflict', kb: 'unchanged', index: 'unchanged', sourcePath: file,
      });
    }
    // 新保存必须来自源文件与 KB 一致的读取基线。唯一例外是：索引/KB 已发布、
    // 源写回失败后，使用同一已发布草稿重试源写回。
    if (input.expectedRevision !== input.expectedSourceRevision && !publishedSourceRetry) {
      reject(409, 'SOURCE_CONFLICT', '加载时源文件与 KB 正文已分叉，请人工合并后重新加载', {
        source: 'conflict', kb: 'unchanged', index: 'unchanged', sourcePath: file,
      });
    }
    if (sourceContent !== doc.content && !publishedSourceRetry) {
      reject(409, 'SOURCE_CONFLICT', '保存前源文件与 KB 正文已分叉，请人工合并后重新加载', {
        source: 'conflict', kb: 'unchanged', index: 'unchanged', sourcePath: file,
      });
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
      throw new DocumentEditError(500, 'SOURCE_WRITE_FAILED', `KB 已保存，但源文件写回失败：${(error as Error).message}`, {
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
    fullTextUpdated: indexedAs === 'fts',
    vectorStored: indexedAs === 'dense',
    indexedAs,
    ...(!file ? { warning: '未配置 sourceDir：源 Markdown 未更新；用旧源重导可能覆盖本次修改' } : {}),
  };
}
