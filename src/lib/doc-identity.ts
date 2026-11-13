/**
 * doc-identity.ts —— 文档身份（Group + Relation）的归一、校验与归属判定
 *
 * 为什么单独抽出来：文档「移动」（doc-move）与「删除」（doc-delete）面对同一组用户输入，
 * 判据只要有一处不同源，就会出现「移动说合法、删除说非法」这种分裂体验：
 *
 *   ├─ Group / relation 的路径注入判据（`..`、`/`、保留键）必须与写入侧一致
 *   └─ 「这篇文档是不是数据源同步下来的」必须由同一条规则回答
 *      —— 两者对它的**处置**不同（移动阻断、删除放行但预告），但判据本身不能各写一套
 */
import fs from 'node:fs';
import path from 'node:path';

import { getKbDir } from './scope.js';
import { isUnsafeRelationName } from './wiki-sync.js';
import { isRootGroup } from './import-path.js';
import { DocumentEditError } from './document-editor.js';

/** 统一抛「可被 HTTP 层翻译成状态码 + code」的错误（见 mcp-http-api.ts::sendDocEditError） */
export function reject(status: number, code: string, message: string, details?: Record<string, unknown>): never {
  throw new DocumentEditError(status, code, message, details);
}

/**
 * Group 路径归一 + 校验（复用写入侧同一套判据：空段 / 点段 / 反斜杠 / 保留键）。
 *
 * @param allowRoot 是否放行根保留键 `__root__`。
 *   移动的**源侧**拒绝（删除链路按 Group 树定位，根没有稳定的树节点，强行支持只会半途失败）；
 *   目标侧放行（用户在选择器里显式点「根目录」）；
 *   删除放行 —— 根散文件本来就存在于 users 的库里，不给删等于留一个删不掉的孤儿。
 */
export function normalizeGroup(raw: string, field: string, allowRoot = false): string {
  const group = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!group) reject(400, 'DOC_ID_INVALID', `缺少${field}`);
  if (isRootGroup(group)) {
    if (allowRoot) return group;
    reject(400, 'DOC_ID_INVALID',
      `暂不支持移动「根目录」下的文档（${group} 是内部保留键）：请先把目标文档归到具体 Group`);
  }
  if (group.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    reject(400, 'DOC_ID_INVALID', `${field} 路径不合法：${group}`);
  }
  return group;
}

export function normalizeRelation(raw: string, field: string): string {
  const relation = String(raw ?? '').trim();
  if (!relation) reject(400, 'DOC_ID_INVALID', `缺少${field}`);
  // relation 会直接成为 wiki 文件名；含 "/" "\\" ".." 会破坏目录结构（写入侧同一判据）
  if (isUnsafeRelationName(relation) || relation === '.' || /[\u0000]/.test(relation)) {
    reject(400, 'DOC_ID_INVALID', `${field} 不能包含 "/"、"\\" 或 ".."：${relation}`);
  }
  return relation;
}

/**
 * 数据源管辖判定：`sourcePath` 能在该 scope 已登记数据源的目录（含多映射子目录）下找到实体文件
 * ⇒ 这篇文档的「真相源」在仓库外，ki 侧改动后下次同步会重新导入（同步**不做**内容查重）。
 *
 * 返回实体文件绝对路径；不属于数据源管辖时返回 undefined。
 */
export function datasourceManagedFile(scope: string, sourcePath?: string): string | undefined {
  const rel = String(sourcePath ?? '').trim();
  if (!rel) return undefined;
  const file = path.join(getKbDir(scope), 'datasource.json');
  if (!fs.existsSync(file)) return undefined;
  let raw: { dir?: unknown; mappings?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { dir?: unknown; mappings?: unknown };
  } catch {
    return undefined; // 登记损坏与「是否受管辖」无关：交给数据源页自己的 fail-loud
  }
  const dir = typeof raw.dir === 'string' ? raw.dir : undefined;
  if (!dir) return undefined;
  const mappings = Array.isArray(raw.mappings) ? raw.mappings : [];
  const subdirs = mappings.length > 0
    ? mappings.map((item) => String((item as { subdir?: unknown })?.subdir ?? ''))
    : [''];
  // 两种相对基线都要试：单数据源 = 相对 dir；多映射 = 相对各自 subdir（历史记录里也可能已带子目录前缀）
  const candidates = [path.resolve(dir, rel), ...subdirs.map((sub) => path.resolve(dir, sub, rel))];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在即不是这个基线，继续下一个
    }
  }
  return undefined;
}
