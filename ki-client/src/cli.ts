#!/usr/bin/env node
/**
 * ki-client 入口。
 *
 * 只做三件事：解析全局参数 → 选命令 → 统一错误出口（`code + message + hint`）。
 * 业务逻辑一律在 `commands/` 下，本文件不碰 HTTP、不碰配置细节。
 */

import fs from 'node:fs';

import { parseArgs } from './args.js';
import { readConfig, resolveConfigPath } from './config.js';
import { resolveRemote } from './remote.js';
import { ClientError, formatError } from './errors.js';
import { runPing } from './commands/ping.js';
import { runRemote } from './commands/remote.js';
import { runAsset } from './commands/asset.js';
import { runDoc } from './commands/doc.js';
import { runUpload } from './commands/upload.js';
import { runAtlas } from './commands/atlas.js';
import { getJson } from './http.js';

const HELP = `ki-client —— ki 的远端取件客户端（多源，类比 git remote）

用法：
  ki-client <命令> [参数] [--remote <源名>] [--json]

命令：
  remote add <名字> <地址> [--token <t> | --token-stdin]
                           新增/更新一个源（同名换地址会清空旧 token）
  remote list              列出所有源
  remote show <名字>       看单个源的详情
  remote remove <名字>     删除一个源
  ping                     连通性 / 鉴权 / 契约版本 / 取件能力自检
  asset get --scope <库> --group <组> --refs <ref[,ref]> --out <目录>
                           把附件（图片）落到本地，输出绝对路径 + sha256
  doc get --scope <库> --group <组> --relation <文档> --out <目录>
                           把正文还原成 .md 并取回文中附件（--no-assets 只取正文）
  upload --scope <库> [--group <组>] <文件...>
  upload-dir --scope <库> [--group <组>] <目录>
                           上传 markdown 与 assets 下的图片，保留目录结构（--wait 等导入完成）
  atlas upload --scope <库> --file <zip> [--title <标题>] [--force]
                           把打包好的图集装进远端库（同包重传默认跳过，--force 强制）
  atlas status --scope <库>
                           核对已部署图集的基线 / 体积 / 包指纹
  status --task <id>       查看一次导入进度

全局参数：
  --remote <名字>          指定用哪个源（配置多个源时必须给）
  --config <路径>          指定配置文件（默认 ~/.ki-client/config.yaml）
  --json                   机器可读输出
  --help / --version

环境变量：
  KI_CLIENT_CONFIG         配置文件路径（低于 --config）
  KI_REMOTE                默认源名（低于 --remote）
  KI_TOKEN_<源名>          该源的 token（覆盖配置里的 token；源名转大写，非字母数字转下划线）
  KI_URL / KI_TOKEN        没有任何配置源时的隐式源（兼容 CI 一次性调用）

示例：
  ki-client remote add prod http://127.0.0.1:7423 --token-stdin
  ki-client remote add test http://10.0.0.7:233 --token-stdin
  ki-client ping --remote prod
  ki-client asset get --remote prod --scope img-demo --group demo \\
      --refs shots/composer.png --out ./tmp

退出码：0 成功 / 1 失败（错误码与出路见输出）
`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.bool('version')) {
    console.log(readVersion());
    return 0;
  }
  if (args.bool('help') || args.positionals.length === 0) {
    console.log(HELP);
    return args.positionals.length === 0 && !args.bool('help') ? 1 : 0;
  }

  const configPath = resolveConfigPath(args.string('config'));
  const [command] = args.positionals;
  // 命令名本身已消费掉：子命令与位置参数从第 2 项开始（否则 `remote add` 会把
  // 'remote' 当成子命令名，报「不认识的子命令 remote remote」）
  const subArgs = { ...args, positionals: args.positionals.slice(1) };

  switch (command) {
    case 'remote':
      return runRemote(subArgs, configPath);

    case 'ping': {
      const remote = resolveRemote(readConfig(configPath), args.string('remote'));
      return runPing(subArgs, remote);
    }

    case 'asset': {
      const remote = resolveRemote(readConfig(configPath), args.string('remote'));
      return runAsset(subArgs, remote);
    }

    case 'doc': {
      const remote = resolveRemote(readConfig(configPath), args.string('remote'));
      return runDoc(subArgs, remote);
    }

    case 'upload':
    case 'upload-dir': {
      const remote = resolveRemote(readConfig(configPath), args.string('remote'));
      // 这两个命令的「命令名」本身就是子命令（与 remote/asset/doc 不同），
      // subArgs 已把命令名切掉 → 塞回首位，让 runUpload 统一按 [sub, ...rest] 解析
      return runUpload({ ...subArgs, positionals: [command, ...subArgs.positionals] }, remote);
    }

    case 'atlas': {
      const remote = resolveRemote(readConfig(configPath), args.string('remote'));
      // 与 upload 同一范式：命令名本身就是子命令（upload / status），塞回首位交给 runAtlas 解析
      return runAtlas({ ...subArgs, positionals: [command, ...subArgs.positionals] }, remote);
    }

    case 'status': {
      const taskId = args.string('task')?.trim();
      if (!taskId) throw new ClientError('USAGE', '缺参数：--task', '上传响应的 taskId 即为它');
      const remote = resolveRemote(readConfig(configPath), args.string('remote'));
      const status = await getJson(remote, '/open/v1/import/status', { taskId });
      console.log(JSON.stringify({ remote: remote.name, taskId, status }, null, 2));
      return 0;
    }

    default:
      throw new ClientError('USAGE', `不认识的命令：${command}`, '用 ki-client --help 看命令清单');
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(formatError(err));
    process.exit(1);
  });
