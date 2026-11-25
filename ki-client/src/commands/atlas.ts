/**
 * 图集（atlas）远程部署：把打包好的 `atlas.zip` 装进远端 kisearch。
 *
 * ═══ 和 `ki atlas upload` 的分工 ═══
 * 内核是同一个（服务端 `installPackage`：校验 zip → 归档旧版 → 原子替换 → 写 meta），
 * 差别只在通道：
 *   · `ki atlas upload`   —— 同机直写盘，内核在本地进程里跑；
 *   · `ki-client atlas`   —— 走 `/open/v1/atlas/*`，内核在远端 daemon 里跑。
 *
 * ═══ 两条刻意的取舍 ═══
 * 1. **不分片**：图集包上限 20MB，远端单请求上限默认 512MB —— 分片只会带来「半途残留暂存目录」
 *    这一类新问题。整包一次发，失败就是失败，服务端要么没装要么装完。
 * 2. **跳过判断只看服务端指纹**：不用本地 state 文件。图集是「整包覆盖」语义，别人（Web 页 /
 *    另一台机器）传过一版之后，本地记的指纹立刻失真；而 `packageSha256` 是服务端算的实际值，
 *    没有失真面。代价是每次多一次 `GET /atlas/status`，收益是绝不误跳。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ParsedArgs } from '../args.js';
import { ClientError } from '../errors.js';
import { assertAtlasUpload, getJson, pingRemote, postBinary } from '../http.js';
import type { ResolvedRemote } from '../remote.js';

/** `GET /open/v1/atlas/status` 与 `POST /open/v1/atlas/package` 的共同响应形状 */
interface AtlasStatusBody {
  ok: boolean;
  scope?: string;
  exists: boolean;
  title?: string;
  branch?: string;
  baseline?: string;
  generatedAt?: string;
  viewCount?: number;
  entries?: Array<{ name?: string; size?: number }>;
  size?: number;
  packageSize?: number;
  /** entry html 的指纹（与本地 CLI 回显的「sha」同一字段） */
  sha256?: string;
  /** 原 zip 的指纹：跳过判断与回传校验都用它（旧服务端可能没有） */
  packageSha256?: string;
  uploadedAt?: string;
  uploadedBy?: string;
  archived?: boolean;
}

const USAGE = [
  'atlas upload --scope <库> --file <zip> [--title <标题>] [--force] [--json]',
  'atlas status --scope <库> [--json]',
].join('\n  ');

/** 人类可读体积（与 upload 命令同口径，保持输出一致） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function sha256Of(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 包内 entry 名（根目录唯一的 .html）；拿不到就显示「-」而不是编一个 */
function entryNameOf(body: AtlasStatusBody): string {
  const html = body.entries?.find((e) => typeof e.name === 'string' && /\.html?$/i.test(e.name));
  return html?.name ?? '-';
}

/**
 * 人读回显：字段名与 `ki atlas upload` 的输出严格对齐。
 *
 * 为什么要对齐：同一个人在新旧机器上会用这两条命令，回显不一致会让人以为是两套东西
 * （本地版由 `src/atlas.ts::printInstallSummary` 定义）。
 */
function printAtlasMeta(scope: string, body: AtlasStatusBody, json: boolean): void {
  if (json) return;
  console.log(`已安装到 ${scope}/.atlas/`);
  const baseline = [body.branch ?? '-', body.baseline ?? '-'].filter(Boolean).join('@');
  const generated = body.generatedAt ? `（生成 ${body.generatedAt.slice(0, 10)}）` : '';
  console.log(`  标题   ${body.title ?? '-'}`);
  console.log(`  基线   ${baseline}${generated}`);
  const entries = body.entries?.length ?? 0;
  console.log(`  条目   ${entries} 个 · entry ${entryNameOf(body)}`);
  console.log(
    `  体积   ${body.size !== undefined ? formatBytes(body.size) : '-'}`
      + `（zip ${body.packageSize !== undefined ? formatBytes(body.packageSize) : '-'}）`,
  );
  console.log(`  sha    ${body.sha256 ? body.sha256.slice(0, 8) : '-'}`);
  if (body.packageSha256) console.log(`  包指纹 ${body.packageSha256.slice(0, 12)}`);
  if (body.archived) console.log('上一版已归档到 archive/');
}

async function runAtlasUpload(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  const scope = args.string('scope')?.trim();
  if (!scope) {
    throw new ClientError('USAGE', '缺参数：scope', '用法：ki-client atlas upload --scope <库> --file <zip>');
  }
  const file = args.string('file')?.trim();
  if (!file) {
    throw new ClientError(
      'USAGE',
      '缺参数：file',
      '先用 pack_atlas.py <图集目录> dist/ --zip 打包，再 --file dist/atlas.zip',
    );
  }

  // ── 本地文件（先于任何网络动作：参数错了不该先连一次远端）──
  const abs = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ClientError('USAGE', `文件不存在：${abs}`, '确认路径；打包产物通常叫 dist/atlas.zip');
  }
  if (!stat.isFile()) {
    throw new ClientError('USAGE', `不是普通文件：${abs}`, '要传的是 pack_atlas.py 产出的 zip，不是目录');
  }
  if (stat.size === 0) {
    throw new ClientError('USAGE', `文件是空的：${abs}`, '重新打包：pack_atlas.py <图集目录> dist/ --zip');
  }
  const zipBuf = fs.readFileSync(abs);
  const localSha = sha256Of(zipBuf);
  const json = args.bool('json');

  // 写操作必须先说清楚「发给谁」（与 upload 命令同一条纪律）。
  // `--json` 时不打印：agent 场景下 stdout 必须是**纯 JSON**，混一行人读文案就得让调用方
  // 去猜哪一行才是数据（upload 命令目前会混，这里是刻意不跟）。
  if (!json) console.log(`via remote=${remote.name} (${remote.url})`);

  const info = await pingRemote(remote, scope);
  const maxPackageSize = assertAtlasUpload(info, remote.name);
  // 本地预检：比「传 20MB 上去等 413」省一次往返；部分客户端库在 413 时还会丢掉响应体
  if (zipBuf.length > maxPackageSize) {
    throw new ClientError(
      'USAGE',
      `图集包 ${formatBytes(zipBuf.length)} 超过服务端上限 ${formatBytes(maxPackageSize)}`,
      '减少视图数量（6~8 页预算）后重新打包；不要靠删快照瘦身',
    );
  }

  // ── 未变更判断：以服务端 meta 的 packageSha256 为准（本地 state 会被别处上传打死）──
  const previous = await getJson<AtlasStatusBody>(remote, '/open/v1/atlas/status', { scope });
  if (!args.bool('force') && previous.exists && previous.packageSha256 === localSha) {
    if (json) {
      console.log(JSON.stringify({ ...previous, ok: true, remote: remote.name, scope, skipped: true, packageSha256: localSha }, null, 2));
      return 0;
    }
    console.log('已是最新，跳过上传（包指纹与服务端一致；--force 可强制重传）');
    printAtlasMeta(scope, previous, false);
    return 0;
  }

  const title = args.string('title')?.trim();
  // title 跟着 query 走：请求体是原始 zip 字节，放不进别的东西
  const query: Record<string, string | undefined> = { scope, title };

  const body = await postBinary<AtlasStatusBody>(
    remote,
    '/open/v1/atlas/package',
    zipBuf,
    'application/zip',
    query,
  );

  // 服务端返回的指纹必须与自己算的一致：这是「装进去的确实是这个包」的唯一硬证据
  if (body.packageSha256 && body.packageSha256 !== localSha) {
    throw new ClientError(
      'SERVER_ERROR',
      `服务端记录的包指纹与本地不一致（本地 ${localSha.slice(0, 12)} / 服务端 ${body.packageSha256.slice(0, 12)}）`,
      '重传一次；仍不一致请检查链路上是否有代理改写了请求体',
    );
  }

  if (json) {
    console.log(JSON.stringify({
      // 以服务端返回为准：`--title` 只是兜底，图集自己声明过标题时它不会生效，
      // 若在这里回填入参，`--json` 就会自证「参数生效了」（那正是本轮 review 抓到的缺陷）
      ...body,
      ok: true,
      remote: remote.name,
      scope,
      skipped: false,
      packageSha256: localSha,
    }, null, 2));
    return 0;
  }
  printAtlasMeta(scope, body, false);
  return 0;
}

async function runAtlasStatus(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  const scope = args.string('scope')?.trim();
  if (!scope) {
    throw new ClientError('USAGE', '缺参数：scope', '用法：ki-client atlas status --scope <库>');
  }

  const json = args.bool('json');
  if (!json) console.log(`via remote=${remote.name} (${remote.url})`);
  const body = await getJson<AtlasStatusBody>(remote, '/open/v1/atlas/status', { scope });

  if (json) {
    console.log(JSON.stringify({ remote: remote.name, ...body }, null, 2));
    return 0;
  }

  if (!body.exists) {
    // 未部署不是错误（退出码 0）：脚本里 `status && upload` 组合不该被这里打断
    console.log(`${scope} 尚未部署图集`);
    console.log(`出路：ki-client atlas upload --scope ${scope} --file <atlas.zip>`);
    return 0;
  }
  console.log(`${scope} 已部署图集`);
  printAtlasMeta(scope, body, false);
  if (body.uploadedAt) {
    console.log(`  上传   ${body.uploadedAt}${body.uploadedBy ? ` by ${body.uploadedBy}` : ''}`);
  }
  return 0;
}

export async function runAtlas(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  // `cli.ts` 把命令名塞回了 positionals 首位（与 upload 同范式），所以子命令在下标 1
  const [, sub] = args.positionals;
  if (sub === 'upload') return runAtlasUpload(args, remote);
  if (sub === 'status') return runAtlasStatus(args, remote);
  throw new ClientError(
    'USAGE',
    sub ? `不认识的 atlas 子命令：${sub}` : '缺 atlas 子命令',
    `用法：\n  ${USAGE}`,
  );
}
