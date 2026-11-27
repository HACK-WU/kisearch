/**
 * 知识地图图集（atlas）的类型定义。
 *
 * 设计基线：REQ-20261120-003 design/S01 §3.7。
 * 「部署包」= 一个 zip：根目录含唯一 .html（entry）+ 可选 meta.json；
 * 「entry」= 解包后被下发的那一个 html；「快照」= entry 内嵌的代码片段。
 */

/** zip 内的一个条目（中央目录项），用于上传回显与上限判断 */
export interface AtlasZipEntry {
  /** 条目路径（已做安全校验，不含 `..` / 绝对路径） */
  name: string;
  /** 解压后字节数 */
  size: number;
}

/** 落在 `.atlas/meta.json` 的元信息；字段与 GET /api/atlas/status 响应 1:1 */
export interface AtlasMeta {
  /** 图集标题（取自 atlas.config.json 的 title） */
  title: string;
  /** 生成基线分支 */
  branch: string;
  /** 生成基线 commit（短 hash 即可） */
  baseline: string;
  /** 生成时间（ISO 字符串，由生成侧给出） */
  generatedAt: string;
  /** 图数（可选，包内 meta.json 提供） */
  viewCount?: number;
  /** 包内条目清单（上传时回显，页面「包内条目」用） */
  entries?: AtlasZipEntry[];
  /** entry html 字节数 */
  size: number;
  /** 原 zip 字节数 */
  packageSize: number;
  /** entry html 的 sha256（十六进制） */
  sha256: string;
  /**
   * 原 zip 字节的 sha256（十六进制，2026-11-25）。
   *
   * 与 `sha256` 的分工：那个是 **entry html** 的指纹，而远程客户端（ki-client）零依赖、
   * 不会解 zip，**算不出它**。因此「同包重传跳过 / 取回校验 / 回滚确认版本」一律以本字段
   * 为基准 —— 用 `packageSize` 代判会把「同大小不同内容」的包误判成未变更，那是静默不更新。
   *
   * ⚠️ 可选：2026-11-25 之前写入的 meta.json 没有它，读取侧必须按缺失兜底（不许抛错）。
   */
  packageSha256?: string;
  /** 服务端写入时间 */
  uploadedAt: string;
  /** 上传方标识：`cli:<用户名>` 或 `http:<登录用户>` */
  uploadedBy?: string;
  /**
   * 归属主库（2026-11-27）。图集库 `<主库>-atlas` 装包时写入，便于改名后反查。
   * 可选：旧包没有该字段，读取侧必须按缺失兜底。
   */
  mainScope?: string;
}

/** GET /api/atlas/status 的 data 形状 */
export interface AtlasStatus {
  exists: boolean;
  meta?: AtlasMeta;
}

/** installPackage 的可选项 */
export interface InstallOptions {
  /**
   * 调用方提供的 meta 兜底：包内 meta.json 缺失时用它。
   * 只取 title/branch/baseline/generatedAt/viewCount，其余字段由服务端计算。
   */
  meta?: Partial<Pick<AtlasMeta, 'title' | 'branch' | 'baseline' | 'generatedAt' | 'viewCount' | 'mainScope'>>;
  /** 上传方标识 */
  uploadedBy?: string;
}

/** installPackage 的结果 */
export interface InstallResult {
  meta: AtlasMeta;
  /** 是否把上一版归档进了 archive/ */
  archived: boolean;
}
