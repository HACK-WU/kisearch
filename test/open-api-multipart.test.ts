/**
 * multipart 流式解析器边界测试（REQ-20261105-001 / W6）
 *
 * design S-02 §3.3 的边界表逐条落成用例（缺一即为缺陷）：
 *   1 boundary 跨 chunk 截断 / 2 part 头跨 chunk / 3 filename 含目录 /
 *   3b RFC 5987 `filename*` 中文 / 4 缺 filename / 5 relPath 越界（由 sink 拒）/
 *   6 单文件超限但仍处理后续文件 / 7 累计超上限扔 413 / 8 非 files 字段丢弃 /
 *   9 尾部 `--boundary--` 结束 / 10 客户端中途断开
 * 另覆盖：0 字节文件、边界恰好落在 chunk 末尾。
 *
 * 运行：npx jiti test/open-api-multipart.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { parseMultipart, MultipartError, type MultipartSink, type FileStartDecision } from '../src/lib/open-api/multipart.js';

const BOUNDARY = '----ki-test-boundary';

/** 组装一个 multipart 请求体 */
function body(parts: string[]): Buffer {
  const chunks: string[] = [];
  for (const p of parts) chunks.push(p);
  chunks.push(`--${BOUNDARY}--\r\n`);
  return Buffer.from(chunks.join(''), 'utf8');
}

/** 生成一个文件 part（filename 原样写入，便于测奇怪路径/编码） */
function filePart(filename: string | null, content: string, name = 'files'): string {
  const disposition = filename === null ? `name="${name}"` : `name="${name}"; filename="${filename}"`;
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; ${disposition}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n`;
}

/** 生成一个 RFC 5987 扩展文件名 part */
function filePartExtended(extValue: string, content: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename*=UTF-8''${extValue}\r\n\r\n${content}\r\n`;
}

interface Capture { files: Map<string, string>; ended: string[]; rejected: { rel: string; reason: string }[] }

function makeSink(opts: { maxBytes?: number; reject?: (rel: string) => string | undefined } = {}): { sink: MultipartSink; capture: Capture } {
  const capture: Capture = { files: new Map(), ended: [], rejected: [] };
  const buffers = new Map<string, Buffer[]>();
  const sink: MultipartSink = {
    onFileStart(rel: string): FileStartDecision {
      const why = opts.reject?.(rel);
      if (why) return { reject: why };
      return { accept: { absPath: `/tmp/${rel}`, maxBytes: opts.maxBytes ?? 1024 * 1024 } };
    },
    onFileChunk(rel: string, chunk: Buffer): void {
      const list = buffers.get(rel) ?? [];
      list.push(Buffer.from(chunk));
      buffers.set(rel, list);
    },
    onFileEnd(rel: string, size: number): void {
      const joined = Buffer.concat(buffers.get(rel) ?? []);
      assert.equal(joined.length, size, `onFileEnd 的 size 应与实际写入一致（${rel}）`);
      capture.files.set(rel, joined.toString('utf8'));
      capture.ended.push(rel);
    },
    onFileRejected(rel: string, reason: string): void {
      capture.rejected.push({ rel, reason });
      buffers.delete(rel);
    },
  };
  return { sink, capture };
}

/** 把 Buffer 按指定切片尺寸拆成多个 chunk，模拟 TCP 分片 */
function chunked(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

async function parse(chunks: Buffer[], sink: MultipartSink, maxTotalBytes = 10 * 1024 * 1024) {
  const req = Readable.from(chunks) as unknown as import('node:http').IncomingMessage;
  return parseMultipart(req, BOUNDARY, sink, { maxTotalBytes });
}

describe('multipart 正常路径', () => {
  it('单文件：内容与大小正确', async () => {
    const { sink, capture } = makeSink();
    const r = await parse(chunked(body([filePart('a.md', '# hello\nworld')]), 4096), sink);
    assert.equal(capture.files.get('a.md'), '# hello\nworld');
    assert.equal(capture.ended.length, 1);
    assert.equal(r.rejectedAll, false);
    assert.ok(r.totalBytes > 0);
  });

  it('多文件 + 0 字节文件', async () => {
    const { sink, capture } = makeSink();
    await parse(chunked(body([filePart('a.md', 'A'), filePart('empty.md', ''), filePart('b.md', 'B')]), 4096), sink);
    assert.equal(capture.files.get('a.md'), 'A');
    assert.equal(capture.files.get('empty.md'), '');
    assert.equal(capture.files.get('b.md'), 'B');
    assert.deepEqual(capture.ended.sort(), ['a.md', 'b.md', 'empty.md']);
  });

  it('#1 boundary 跨 chunk 被截断：逐字节分片仍能正确切分', async () => {
    const { sink, capture } = makeSink();
    const content = 'line1\r\nline2\n' + 'x'.repeat(200);
    await parse(chunked(body([filePart('a.md', content)]), 1), sink);
    assert.equal(capture.files.get('a.md'), content);
  });

  it('#2 part 头跨 chunk：头被切碎仍能解析', async () => {
    const { sink, capture } = makeSink();
    await parse(chunked(body([filePart('header-cut.md', 'ok')]), 7), sink);
    assert.equal(capture.files.get('header-cut.md'), 'ok');
  });

  it('#3 filename 含目录：相对路径原样保留（目录上传的唯一载体）', async () => {
    const { sink, capture } = makeSink();
    await parse(chunked(body([filePart('sub/dir/a.md', 'nested')]), 3), sink);
    assert.equal(capture.files.get('sub/dir/a.md'), 'nested');
  });

  it('#3b RFC 5987 filename*：中文文件名被正确解码（不是百分号串）', async () => {
    const { sink, capture } = makeSink();
    await parse(chunked(body([filePartExtended('%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3.md', '中文')]), 5), sink);
    assert.equal(capture.files.get('中文文档.md'), '中文');
  });

  it('反斜杠路径归一为 posix（Windows 客户端）', async () => {
    const { sink, capture } = makeSink();
    // 用 charCode 拼反斜杠：源码里写 \\\\ 极易数错转义层数（数错只会得到 sub//a.md）
    const winName = 'sub' + String.fromCharCode(92) + 'a.md';
    await parse(chunked(body([filePart(winName, 'win')]), 4), sink);
    assert.equal(capture.files.get('sub/a.md'), 'win');
  });
});

describe('multipart 拒绝与跳过', () => {
  it('#4 缺 filename → 进跳过样本，且不影响后续文件', async () => {
    const { sink, capture } = makeSink();
    const b = body([filePart(null, 'no-name'), filePart('ok.md', 'fine')]);
    await parse(chunked(b, 11), sink);
    assert.equal(capture.rejected.length, 1);
    assert.match(capture.rejected[0].reason, /缺少 filename/);
    assert.equal(capture.files.get('ok.md'), 'fine');
  });

  it('#5 relPath 越界（sink 拒绝）→ 跳过该 part，整包不断', async () => {
    const { sink, capture } = makeSink({
      reject: (rel) => (rel.includes('..') ? '路径越界（含 ..）' : undefined),
    });
    await parse(chunked(body([filePart('../escape.md', 'evil'), filePart('ok.md', 'fine')]), 9), sink);
    assert.equal(capture.rejected.length, 1);
    assert.match(capture.rejected[0].reason, /越界/);
    assert.equal(capture.files.get('ok.md'), 'fine');
    assert.equal(capture.files.has('../escape.md'), false);
  });

  it('#6 单文件超 maxBytes → rejected，后续文件照常', async () => {
    const { sink, capture } = makeSink({ maxBytes: 10 });
    const big = 'y'.repeat(50);
    await parse(chunked(body([filePart('big.md', big), filePart('small.md', 'tiny')]), 13), sink);
    assert.equal(capture.rejected.length, 1);
    assert.match(capture.rejected[0].reason, /超过单文件上限 10 字节/);
    assert.equal(capture.files.get('small.md'), 'tiny');
    assert.equal(capture.files.has('big.md'), false);
  });

  it('#8 非 files 字段（文本参数）被丢弃，不记跳过样本', async () => {
    const { sink, capture } = makeSink();
    const textPart = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="scope"\r\n\r\nproj-a\r\n`;
    await parse(chunked(body([textPart, filePart('a.md', 'A')]), 8), sink);
    assert.equal(capture.rejected.length, 0);
    assert.equal(capture.files.get('a.md'), 'A');
  });

  it('#9 尾部 --boundary-- 后即使还有额外字节也正常结束', async () => {
    const { sink, capture } = makeSink();
    const b = Buffer.concat([body([filePart('a.md', 'A')]), Buffer.from('trailing-junk', 'utf8')]);
    await parse(chunked(b, 6), sink);
    assert.equal(capture.files.get('a.md'), 'A');
  });

  it('#7 累计超过 maxTotalBytes → 抛 PAYLOAD_TOO_LARGE（带实际值与上限）', async () => {
    const { sink } = makeSink();
    const b = body([filePart('a.md', 'z'.repeat(500))]);
    await assert.rejects(
      () => parse(chunked(b, 64), sink, 200),
      (err: unknown) => {
        assert.ok(err instanceof MultipartError);
        assert.equal(err.code, 'OPEN_API_PAYLOAD_TOO_LARGE');
        assert.equal(err.detail.limit, 200);
        assert.ok((err.detail.actual ?? 0) > 200);
        return true;
      },
    );
  });

  it('#10 客户端中途断开（流 error）→ 抛出，不返回「成功」', async () => {
    const { sink } = makeSink();
    const good = chunked(body([filePart('a.md', 'content')]), 32);
    async function* broken(): AsyncGenerator<Buffer> {
      yield good[0];
      throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    }
    const req = Readable.from(broken()) as unknown as import('node:http').IncomingMessage;
    await assert.rejects(() => parseMultipart(req, BOUNDARY, sink, { maxTotalBytes: 1024 * 1024 }), /aborted/);
  });

  it('请求体截断（没有结束边界）→ 报 multipart 不完整，不静默成功', async () => {
    const { sink } = makeSink();
    const full = body([filePart('a.md', 'content')]);
    const truncated = full.subarray(0, full.length - 20);
    await assert.rejects(
      () => parse(chunked(truncated, 16), sink),
      (err: unknown) => err instanceof MultipartError && err.code === 'OPEN_API_BAD_MULTIPART',
    );
  });

  it('缺 boundary → BAD_MULTIPART', async () => {
    const { sink } = makeSink();
    const req = Readable.from([body([filePart('a.md', 'x')])]) as unknown as import('node:http').IncomingMessage;
    await assert.rejects(
      () => parseMultipart(req, '', sink, { maxTotalBytes: 1024 }),
      (err: unknown) => err instanceof MultipartError && err.code === 'OPEN_API_BAD_MULTIPART',
    );
  });

  it('全部文件被拒 → rejectedAll=true（供路由层回 400 NO_VALID_FILE）', async () => {
    const { sink } = makeSink({ reject: () => '扩展名不支持' });
    const r = await parse(chunked(body([filePart('a.txt', 'x')]), 5), sink);
    assert.equal(r.rejectedAll, true);
  });
});
