/**
 * 第三方上传 API 开关的**唯一解析点**（`--upload-api` / `--no-upload-api` / 配置 / lock）。
 *
 * 为什么单独成文件：这个开关要在四个地方取值——`ki mcp --http` 启动、
 * `ki mcp restart`（要把上次的值带给子进程）、`ki mcp status`（回显）、
 * 以及启动日志。四处各写一份 `args.includes('--no-upload-api')` 必然会分叉，
 * 而分叉的表现是「关掉了又自己开回来」这种安全回退，极难在评审里看出来。
 *
 * 优先级：**CLI > 配置 > lock（上次运行值）> 默认（开启）**。
 * - CLI 最高：一条命令就能切换，不必先改配置；
 * - 配置次之：运维写在 YAML 里的意图必须被尊重，否则改配置不生效（正是
 *   `mcp.http.localAdmin` 曾经踩过的静默失效坑）；
 * - lock 仅在没有更明确指令时充当「上次状态」：保证 `ki mcp restart --no-upload-api`
 *   之后的裸 `ki mcp restart` 不会静默把通道开回来（验收锚点 A9）。
 *
 * 正反两个 flag 都支持，与 `--web` / `--no-web` 的既有体例一致：只给 `--no-*` 时
 * 用户没有任何一条命令能把通道重新打开（写配置也要等重启），等于制造反向死锁。
 */

/** 生效值的来源，供 `ki mcp status` 标注可信度 */
export type UploadApiSource = 'cli' | 'config' | 'lock' | 'default';

export interface UploadApiResolution {
  /** 生效值：true = 开放 `/open/v1/import/*` */
  uploadApi: boolean;
  source: UploadApiSource;
}

export interface UploadApiInput {
  /** 命令行参数（原样传入即可，本函数只认两个开关 flag） */
  cliArgs?: readonly string[];
  /** `mcp.http.uploadApi`；undefined = 未配置 */
  configValue?: boolean;
  /** lock 文件里的上次生效值；undefined = 无 lock / 旧版 lock 无该字段 */
  lockValue?: boolean;
}

/** CLI 上是否显式给了开关（`--no-upload-api` 与 `--upload-api` 同时出现时后者让位） */
export function resolveUploadApi(input: UploadApiInput): UploadApiResolution {
  const args = input.cliArgs ?? [];
  if (args.includes('--no-upload-api')) return { uploadApi: false, source: 'cli' };
  if (args.includes('--upload-api')) return { uploadApi: true, source: 'cli' };
  if (typeof input.configValue === 'boolean') return { uploadApi: input.configValue, source: 'config' };
  if (typeof input.lockValue === 'boolean') return { uploadApi: input.lockValue, source: 'lock' };
  return { uploadApi: true, source: 'default' };
}

/**
 * 「已有实例在跑，本次开关参数不生效」的提示文案（不需要提示时返回 undefined）。
 *
 * 为什么必须有这句：命中幂等单例时本进程直接 exit(0)，用户看到的是启动成功；
 * 若不同时说明「运行中实例仍按旧值工作」，`--no-upload-api` 会被误认为已生效
 * —— 安全开关的表现与实际相反，是最难在事后发现的一类问题。
 *
 * 文案集中在此，是因为复用判断出现在两个入口（`mcp-server` 的启动守卫、
 * `startHttpMcpServer` 内的兜底守卫），两处各写一句必然漂移。
 */
export function describeUploadApiReuseMismatch(
  runningValue: boolean | undefined,
  requested: boolean,
): string | undefined {
  if (typeof runningValue !== 'boolean' || runningValue === requested) return undefined;
  const flag = requested ? '--upload-api' : '--no-upload-api';
  return (
    `注意：正在运行的实例的上传 API 开关为「${runningValue ? '开启' : '已关闭'}」，与本次参数不一致；` +
    `本次不会生效。如需切换请执行 ki mcp restart ${flag}。\n`
  );
}
