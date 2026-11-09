/**
 * 手写 multipart/form-data 流式解析器（零依赖）。
 *
 * 为什么不引 `busboy` / `formidable`（design S-02 D-01）：
 *   项目只有 6 个运行时依赖且都偏基础设施，为一个接口引入 Express 生态的解析器不划算；
 *   更重要的是它们会把 part 的写入交给自己的 fs 层，而本需求要的是「解析器不碰文件系统，
 *   落盘策略（越界、大小、跳过、清理）全在 sink 里」——那样才只有一处真相。
 *
 * 责任划分：
 *   · 解析器：切边界、解析 part 头、按 sink 的决定投递字节流
 *   · sink：路径清洗、文件句柄、单文件上限后的清理、跳过样本
 *   `onFileStart` 返回 reject 时，解析器**仍继续消费该 part 的 body 直到下一个边界**
 *   （只是不再回调 chunk）——这是「跳过这个文件但不断整包」的实现前提。
 *
 * ★ 不缓冲全量：每轮只把「可能构成边界前缀」的尾巴留在内存里（≤ boundary 长度 + 4），
 *   因此内存占用与上传体积无关（design S-02 D-02 的硬要求）。
 */

import type http from 'node:http';

/** `onFileStart` 的决定：接受（给出落点与单文件上限）或拒绝（给出原因，进跳过样本） */
export type FileStartDecision = { accept: { absPath: string; maxBytes: number } } | { reject: string };

export interface MultipartSink {
  /** 收到一个 part 的文件名（已归一为 posix 相对路径）时的落点决定 */
  onFileStart(relPath: string): FileStartDecision;
  /** 该 part 的一段字节（调用方保证同一时刻只有一个 part 在写） */
  onFileChunk(relPath: string, chunk: Buffer): void;
  /** 该 part 正常收完（size = 实际写入字节数） */
  onFileEnd(relPath: string, size: number): void;
  /** 该 part 被拒（路径非法 / 缺文件名 / 超单文件上限）；sink 负责删掉可能的半截文件 */
  onFileRejected(relPath: string, reason: string): void;
}

export interface MultipartLimits {
  /** 整个请求体的上限（超了立刻中断连接，不继续读 —— 否则「拒绝但继续读」等于白挨打） */
  maxTotalBytes: number;
}

export interface MultipartResult {
  totalBytes: number;
  /** 是否所有文件都被拒（调用方据此决定是否 400 NO_VALID_FILE） */
  rejectedAll: boolean;
}

/** 单次请求的解析错误（带 HTTP 语义，供路由层直接映射状态码） */
export class MultipartError extends Error {
  constructor(
    readonly code: 'OPEN_API_BAD_MULTIPART' | 'OPEN_API_PAYLOAD_TOO_LARGE',
    message: string,
    readonly detail: { actual?: number; limit?: number } = {},
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}

/** part 头累积上限：防御「永不出现的空行」把内存撑爆 */
const MAX_HEADER_BYTES = 16 * 1024;
const CRLF = '\r\n';

export async function parseMultipart(
  req: http.IncomingMessage,
  boundary: string,
  sink: MultipartSink,
  limits: MultipartLimits,
): Promise<MultipartResult> {
  if (!boundary) throw new MultipartError('OPEN_API_BAD_MULTIPART', 'multipart 缺少 boundary');

  const firstDelim = Buffer.from(`--${boundary}`);
  const nextDelim = Buffer.from(`\r\n--${boundary}`);

  type State = 'preamble' | 'headers' | 'body' | 'done';
  let state: State = 'preamble';
  let buf = Buffer.alloc(0);
  let headerBuf = Buffer.alloc(0);
  let totalBytes = 0;
  let savedCount = 0;
  let rejectedCount = 0;

  let current: {
    rel: string;
    maxBytes: number;
    written: number;
    overflowed: boolean;
  } | null = null;
  let currentRejectedAtStart = false;

  const finishPart = (): void => {
    if (!current) return;
    if (current.overflowed) {
      // 超单文件上限：不算 saved，交由 sink 删半截文件并记样本
      rejectedCount++;
      sink.onFileRejected(
        current.rel,
        `超过单文件上限 ${current.maxBytes} 字节（实际已写入 ${current.written} 字节）。`
        + '可调大 scopes.<scope>.import.maxFileSize，或在上传前先 GET /open/v1/ping 核对 limits.maxFileSize',
      );
    } else {
      savedCount++;
      sink.onFileEnd(current.rel, current.written);
    }
    current = null;
    currentRejectedAtStart = false;
  };

  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    totalBytes += chunk.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new MultipartError(
        'OPEN_API_PAYLOAD_TOO_LARGE',
        `请求体超过上限 ${limits.maxTotalBytes} 字节（已收 ${totalBytes} 字节）。`
        + '可调大 mcp.http.uploadMaxBytes；若经过反向代理，还需同步调大其 client_max_body_size',
        { actual: totalBytes, limit: limits.maxTotalBytes },
      );
    }
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

    // 一次流入可能跨多个状态，循环直到本段数据耗尽
    for (;;) {
      if (state === 'done') {
        buf = Buffer.alloc(0);
        break;
      }

      if (state === 'preamble') {
        const idx = buf.indexOf(firstDelim);
        if (idx < 0) {
          // 只保留可能是边界前缀的尾巴
          buf = tail(buf, firstDelim.length - 1);
          break;
        }
        const after = idx + firstDelim.length;
        if (buf.length < after + 2) { buf = buf.subarray(idx); break; }
        const mark = buf.subarray(after, after + 2).toString('latin1');
        buf = buf.subarray(after + 2);
        if (mark === '--') { state = 'done'; continue; }
        if (mark !== CRLF) {
          throw new MultipartError('OPEN_API_BAD_MULTIPART', `multipart 边界后格式非法（期望 CRLF/--，实际 ${JSON.stringify(mark)}）`);
        }
        headerBuf = Buffer.alloc(0);
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        // 首个 part 的头紧跟在 CRLF 之后，因此从 buf 起点累积到 \r\n\r\n
        headerBuf = Buffer.concat([headerBuf, buf]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (headerBuf.length > MAX_HEADER_BYTES) {
            throw new MultipartError('OPEN_API_BAD_MULTIPART', 'multipart 的 part 头过长（未找到空行）');
          }
          buf = Buffer.alloc(0);
          break;
        }
        const headerText = headerBuf.subarray(0, end).toString('utf8');
        buf = headerBuf.subarray(end + 4);
        headerBuf = Buffer.alloc(0);

        const part = parsePartHeaders(headerText);
        if (!part.isFile) {
          // 文本参数一律走 query（design S-02 D-04）：非 files 字段丢弃内容，不记跳过样本
          current = null;
          currentRejectedAtStart = true;
          state = 'body';
          continue;
        }
        if (!part.fileName) {
          current = null;
          currentRejectedAtStart = true;
          rejectedCount++;
          state = 'body';
          // 没有文件名无法记样本的 rel，用占位名（真实字段名更利于定位客户端问题）
          sink.onFileRejected(part.name || '(未命名字段)', '缺少 filename（curl 请用 -F "files=@路径"）');
          continue;
        }
        const decision = sink.onFileStart(part.fileName);
        if ('reject' in decision) {
          current = null;
          currentRejectedAtStart = true;
          rejectedCount++;
          sink.onFileRejected(part.fileName, decision.reject);
          state = 'body';
          continue;
        }
        current = { rel: part.fileName, maxBytes: decision.accept.maxBytes, written: 0, overflowed: false };
        currentRejectedAtStart = false;
        state = 'body';
        continue;
      }

      // state === 'body'
      const idx = buf.indexOf(nextDelim);
      if (idx < 0) {
        // 只把「一定不属于边界」的部分投递出去，尾巴留着（可能被下一个 chunk 补成边界）
        const keep = Math.min(buf.length, nextDelim.length - 1);
        const flushLen = buf.length - keep;
        emit(buf.subarray(0, flushLen));
        buf = buf.subarray(flushLen);
        break;
      }
      // 找到边界：需要边界后 2 字节才能判定「结束」还是「下一个 part」
      if (buf.length < idx + nextDelim.length + 2) {
        emit(buf.subarray(0, idx));
        buf = buf.subarray(idx);
        break;
      }
      emit(buf.subarray(0, idx));
      const after = idx + nextDelim.length;
      const mark = buf.subarray(after, after + 2).toString('latin1');
      buf = buf.subarray(after + 2);
      finishPart();
      if (mark === '--') { state = 'done'; continue; }
      if (mark !== CRLF) {
        throw new MultipartError('OPEN_API_BAD_MULTIPART', `multipart 边界后格式非法（期望 CRLF/--，实际 ${JSON.stringify(mark)}）`);
      }
      headerBuf = Buffer.alloc(0);
      state = 'headers';
      continue;
    }
  }

  // 收流结束：仍处于 body 说明客户端没发结束边界（截断）
  if (state === 'body' && !currentRejectedAtStart) {
    finishPart();
  }
  if (state !== 'done') {
    throw new MultipartError('OPEN_API_BAD_MULTIPART', 'multipart 请求体不完整（未收到结束边界）');
  }

  return { totalBytes, rejectedAll: savedCount === 0 && rejectedCount > 0 };

  function emit(bytes: Buffer): void {
    if (bytes.length === 0) return;
    if (!current) return; // 被拒的 part：继续消费但不投递
    if (current.overflowed) return;
    if (current.written + bytes.length > current.maxBytes) {
      // 超限后不再写，但必须继续读到本 part 结束（否则整包断掉）
      const allowed = Math.max(0, current.maxBytes - current.written);
      if (allowed > 0) {
        sink.onFileChunk(current.rel, bytes.subarray(0, allowed));
        current.written += allowed;
      }
      current.overflowed = true;
      return;
    }
    sink.onFileChunk(current.rel, bytes);
    current.written += bytes.length;
  }
}

/** 保留尾部 n 字节（n 为边界前缀最长长度） */
function tail(buf: Buffer, n: number): Buffer {
  if (buf.length <= n) return buf;
  return buf.subarray(buf.length - n);
}

interface PartHeaders {
  name: string;
  fileName?: string;
  isFile: boolean;
}

/**
 * 解析 part 头。
 *
 * `filename*`（RFC 5987）优先：curl 对非 ASCII 文件名会发
 * `filename*=UTF-8''%E4%B8%AD%E6%96%87.md`，只读 `filename` 会拿到整串百分号。
 */
function parsePartHeaders(headers: string): PartHeaders {
  const disposition = headers
    .split(CRLF)
    .find((line) => /^content-disposition:/i.test(line)) ?? '';
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? '';
  const extended = /(?:^|;)\s*filename\*=([^;]+)/i.exec(disposition)?.[1]?.trim();
  const plain = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1];
  const rawName = extended ? decodeExtendedFilename(extended) : plain;
  // 路径归一：Windows 客户端可能发反斜杠，统一成 posix 相对路径
  const fileName = rawName ? rawName.replace(/\\/g, '/') : undefined;
  return {
    name,
    fileName,
    // 只有 name="files" 的 part 才算文件；文本参数走 query（丢内容但不报错）。
    // 注意这里是「字段名是否 files」，不是「有没有 filename」—— 缺 filename 属于
    // 客户端用法错误，要进跳过样本（有原因），不能静默当成文本参数丢掉。
    isFile: name === 'files',
  };
}

/** `UTF-8''%E4%B8%AD.md` → `中.md`；解不出就退回原串（宁可文件名怪，也不要 400） */
function decodeExtendedFilename(value: string): string {
  const parts = value.split("''");
  const encoded = parts.length === 2 ? parts[1] : value;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
