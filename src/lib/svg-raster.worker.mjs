/**
 * SVG 栅格化 worker（REQ-20261123-008 · B3）
 *
 * ═══ 为什么必须是独立的 .mjs，而不是 .ts ═══
 * 本项目用 jiti 直跑 TS（`node jiti-cli.mjs src/mcp-server.ts`），但 `new Worker()` 走的是
 * Node 原生 ESM 加载器，**不认识 .ts**。用 jiti 在 worker 内注册再转 import 也能跑，但那
 * 等于在 worker 里再起一套模块系统（启动更慢、错误栈更难读）。
 * 这里把 worker 写成纯 ESM：只依赖 `@resvg/resvg-js`，不需要任何转译。
 *
 * ═══ 为什么建 Resvg 实例的开销不可省 ═══
 * 实测：同一个实例不能复用于不同 svg（`render()` 是一次性的），而 `loadSystemFonts`
 * 在实例化时构建字体库。所以每条消息新建实例是**必然开销**，不需要为此做池化。
 *
 * ═══ 安全 ═══
 * resvg 不执行脚本、不加载外部资源（实测：`<image href="file:///etc/passwd">` 与相对路径
 * 穿越的输出与不含 image 版本字节完全相同）。因此这里不需要额外的 resourcesDir 隔离。
 */

import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js');

/** 与主线程约定的最大输出宽度（DESIGN §3.2：1568 = 上游尺寸拐点） */
const DEFAULTS = { maxWidth: 1568 };

parentPort?.on('message', (msg) => {
  const id = msg?.id;
  try {
    const resvg = new Resvg(String(msg?.svg ?? ''), {
      // 按宽度缩放：SVG 的 viewBox 尺寸各异，按宽统一给一个上限才好预算 token
      fitTo: { mode: 'width', value: Number(msg?.maxWidth) || DEFAULTS.maxWidth },
      // 系统字体：服务器有 Noto CJK，中文图才能渲染出真字（否则是空白/方框）
      font: { loadSystemFonts: true },
      // SVG 常无背景，透明 PNG 送模型可能被当黑底
      background: 'white',
    });
    const png = resvg.render().asPng();
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    // 转成可 transfer 的 ArrayBuffer，避免主线程再拷一份（图大时拷贝很贵）
    const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    parentPort?.postMessage({ id, ok: true, png: ab, width, height }, [ab]);
  } catch (err) {
    parentPort?.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
});
