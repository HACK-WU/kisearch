/**
 * 上传增量状态（`upload-dir` 的「断点续传」靠它）。
 *
 * ═══ 为什么不用 HTTP 层断点续传 ═══
 * multipart / tar.gz 都是「一次请求一个整体」，服务端没有分片协议，请求中断就是整批丢。
 * 所以能做到的真实续传粒度是**文件级**：每个文件传成功后立刻记一笔，下次只补没记过的。
 *
 * ═══ 为什么状态不放目标目录 ═══
 * 目标目录通常是被 git 管理的文档仓，扔一个 `.ki-client-*.json` 进去会被误提交/误删。
 * 统一放 `~/.ki-client/state/<key>.json`（0700/0600），key 由「源 + 库 + 组 + 目录」派生。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FileRecord {
  sha256: string;
  size: number;
  /** 最近一次成功上传的时间（ISO） */
  at: string;
}

export interface UploadState {
  version: 1;
  /** 相对路径 → 上次成功上传的内容指纹 */
  files: Record<string, FileRecord>;
}

function stateDir(): string {
  return path.join(os.homedir(), '.ki-client', 'state');
}

/**
 * 状态 key：同一**源（名 + 地址）** + 库 + 组 + 本地目录才共享一份增量记录。
 *
 * ★ 必须含 `url`：同名源被 `remote add` 改到另一台机器后，若 key 只看源名，
 *   旧状态会让客户端误以为「这些文件已经传过了」而整批跳过 —— 目标库里其实一份都没有。
 */
export function stateKey(input: { remote: string; url: string; scope: string; group?: string; dir: string }): string {
  const raw = [input.remote, input.url, input.scope, input.group ?? '', path.resolve(input.dir)].join('\u0000');
  return crypto.createHash('sha1').update(raw, 'utf-8').digest('hex').slice(0, 16);
}

export function statePath(key: string): string {
  return path.join(stateDir(), `${key}.json`);
}

/** 读状态；不存在或损坏都返回空（状态坏了最多重传，不能阻断上传） */
export function readState(key: string): UploadState {
  try {
    const raw = fs.readFileSync(statePath(key), 'utf-8');
    const parsed = JSON.parse(raw) as UploadState;
    if (parsed?.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
      return { version: 1, files: {} };
    }
    return parsed;
  } catch {
    return { version: 1, files: {} };
  }
}

/** 原子写（tmp + rename），失败静默——状态写不进去不该让上传失败 */
export function writeState(key: string, state: UploadState): void {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = statePath(key);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    // 忽略：下次会重传，不影响正确性
  }
}

export function sha256File(absPath: string): { sha256: string; size: number } {
  const buf = fs.readFileSync(absPath);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}
