/**
 * 图集分片上传（S-06 §3.2）。
 *
 * 为什么分片：整包 base64 一次 POST 会被服务端 `uploadMaxBytes` 与内存双双卡住；
 * 分片还能天然支持「中断后同 uploadId 续传」（按 batchIndex 命名落盘）。
 *
 * 两条硬约束：
 * 1. **最后一片到达才合并**——未收完不能在 `.atlas/` 里留下半个图集（需求 N4）。
 * 2. **合并失败清空暂存**——校验不过的包没有任何保留价值，留着只会让「下次续传」拼出脏包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atlasDir, safeSegment, uploadDir } from './paths.js';
import { installPackage } from './package.js';
import type { InstallOptions, InstallResult } from './types.js';
import { AtlasError } from './errors.js';

/** 暂存保留时长：超过即视为废弃上传 */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** 单片文件名：零填充 6 位，保证字符串排序 = 数字序（part-10 不会排到 part-2 前面） */
const partName = (i: number): string => `part-${String(i).padStart(6, '0')}`;

export interface ChunkPayload {
  scope: string;
  uploadId: string;
  batchIndex: number;
  batchCount: number;
  /** base64 内容数组；`name` 仅作占位，落盘名统一按 batchIndex 生成 */
  files: { name?: string; content: string }[];
}

export interface ChunkResult {
  /** 是否已收完并完成安装 */
  done: boolean;
  /** 已收到的片数 */
  received: number;
  /** 总片数 */
  of: number;
  /** done=true 时的安装结果 */
  install?: InstallResult;
}

/**
 * 清理超过 24h 的暂存目录（惰性：每次上传前顺带跑一次，不引定时器）。
 * 失败不阻断上传——清理是卫生工作，不该让正常上传因它失败。
 */
export function cleanupStaleUploads(scope: string, now: number = Date.now()): number {
  const root = path.join(atlasDir(scope), '.upload');
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      const st = fs.statSync(dir);
      if (now - st.mtimeMs > STALE_UPLOAD_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* 单条清理失败不影响其余 */
    }
  }
  return removed;
}

/**
 * 收一个分片；收满后合并、校验、安装，并清空该 uploadId 的暂存。
 *
 * @throws AtlasError 参数非法 / 合并后校验失败（已清空暂存）
 */
export function receiveChunk(payload: ChunkPayload, opts: InstallOptions = {}): ChunkResult {
  const scope = payload.scope;
  const uploadId = safeSegment(payload.uploadId, 'uploadId');
  const { batchIndex, batchCount, files } = payload;

  if (!Number.isInteger(batchIndex) || !Number.isInteger(batchCount) || batchCount < 1 || batchCount > 500) {
    throw new AtlasError('PACKAGE_INVALID', `分片参数非法（batchIndex=${batchIndex}, batchCount=${batchCount}）`);
  }
  if (batchIndex < 0 || batchIndex >= batchCount) {
    throw new AtlasError('PACKAGE_INVALID', `batchIndex 越界：${batchIndex} / ${batchCount}`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new AtlasError('PACKAGE_INVALID', '缺少 files 数组（{ files: [{ content: "<base64>" }] }）');
  }
  // 一片一个文件：多文件会被 concat 成一片，语义含糊（调用方以为发了多片）。
  // 与其猜，不如显式拒绝——前端与文档都是「一请求一片」。
  if (files.length > 1) {
    throw new AtlasError('PACKAGE_INVALID', `files 只接受 1 个元素，收到 ${files.length} 个`, '一请求一片：把内容切好后再逐片发送');
  }

  // 只在首片清理：每片都全量扫描 .upload/ 会让 500 片的包多扫 500 次目录
  if (batchIndex === 0) cleanupStaleUploads(scope);

  const dir = uploadDir(scope, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  // 同一片重复到达时覆盖同名文件（幂等，便于客户端重试）
  const buf = Buffer.concat(files.map((f) => Buffer.from(String(f.content ?? ''), 'base64')));
  fs.writeFileSync(path.join(dir, partName(batchIndex)), buf);

  const received = fs.readdirSync(dir).filter((n) => n.startsWith('part-')).length;
  /**
   * 收口判据是「已收片数 == 总片数」，**不是**「这一片是最后一片」：
   * 客户端乱序 / 重试时，最后到达的可能是 index 0；按「最后一片」判会永远收不了口
   * （S-06 测试 ④ 抓到的缺陷）。缺片时 received < batchCount，自然不合并。
   */
  if (received < batchCount) {
    return { done: false, received, of: batchCount };
  }

  const parts = fs.readdirSync(dir).filter((n) => n.startsWith('part-')).sort();
  const zipBuf = Buffer.concat(parts.map((n) => fs.readFileSync(path.join(dir, n))));
  try {
    const install = installPackage(scope, zipBuf, opts);
    fs.rmSync(dir, { recursive: true, force: true });
    return { done: true, received, of: batchCount, install };
  } catch (err) {
    // 校验失败：暂存没有任何保留价值，清掉避免「续传拼出脏包」
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

