/**
 * 浏览器端「文件 → base64」的唯一实现（上传接口要的就是 base64 字符串）。
 *
 * 为什么要分块：`String.fromCharCode(...bytes)` 在 1MB 文件上约 100 万个参数，
 * 会直接 `RangeError: Maximum call stack size exceeded`。按 32KB 切片拼接才安全。
 *
 * 调用方：`ImportPage`（知识写入 → 上传导入）、`EventRefUploadModal`（事件参考文档上传）。
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
