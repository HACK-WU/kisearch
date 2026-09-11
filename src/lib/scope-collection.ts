import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateScope } from './scope.js';
import type { KiConfig } from './config.js';

/** 当前向量布局版本：一个 scope 一个独立 Collection。 */
export const VECTOR_LAYOUT_VERSION = 2;

/**
 * 规范化可能尚未创建的路径，同时解析已经存在的父目录中的符号链接。
 * 直接对不存在的 vectorDir 调用 realpath 会导致首次启动前后指纹变化，
 * 从而把同一个 daemon 误判成两个实例；保留缺失尾段可使两次结果稳定。
 */
function stableRealpath(input: string): string {
  const absolute = path.resolve(input);
  const missing: string[] = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync(current), ...missing);
  } catch {
    return absolute;
  }
}

/**
 * daemon Socket 的稳定 owner 身份。Socket 路径不能随 scope 注册表、embedding
 * 参数或 scopeMode 变化，否则同一 vectorDir 会被拆成多个 socket，产生双 owner；
 * 这些完整配置差异仍由 configFingerprint 在 ping 握手阶段拒绝。
 */
export function daemonIdentityFingerprint(config: KiConfig): string {
  const payload = {
    vectorDir: stableRealpath(config.vectorDir),
    dataDir: stableRealpath(config.dataDir),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

// ─── daemon 身份漂移守卫 ───

/**
 * daemon 启动时捕获的身份指纹（vectorDir + dataDir）。
 *
 * 为何需要：loadConfig 现在按 mtime/size 热失效，daemon 运行期间配置可变。
 * 两类变更必须区分对待：
 *  - **可热生效**：scope 注册/授权、scopeMode、token —— 不热生效就会造成撤权后
 *    仍继续服务的 fail-open；
 *  - **不可热生效**：vectorDir/dataDir —— daemon 内存里的 engine 与已打开的
 *    Collection 句柄仍指向旧路径，而 getScopeCollectionPath/getScopeDataDir 会按
 *    新配置解析 → 读到旧句柄、写到新路径，数据落到错误位置且静默。
 * 因此后者必须 fail-loud 要求重启，而不是静默跟着配置跑。
 */
let _daemonIdentity: string | null = null;
/**
 * 启动时的 scope 级 kbDir 签名。
 *
 * 必须单独快照而不能并入 daemonIdentityFingerprint：后者决定 Socket 路径，
 * 一旦随 kbDir 变化就会把同一份数据裂成两个 owner（双写竞态）。
 * 但 kbDir 变更同样不可热生效：它立即改变 getScopeDataDir 的结果（KB 文件改落
 * 新目录），而向量 Collection 仍按 vectorDir/<scope> 原地不动 → KB 与向量索引
 * 指向不同数据，且漂移守卫恒为 false（实测可复现）。
 */
let _daemonScopeKbDirs: string | null = null;

/** 仅由 daemon owner 进程在启动时调用；CLI/测试不调用，因此不受守卫影响。 */
export function captureDaemonIdentity(config: KiConfig): string {
  _daemonIdentity = daemonIdentityFingerprint(config);
  _daemonScopeKbDirs = scopeKbDirsSignature(config);
  return _daemonIdentity;
}

export function getDaemonIdentity(): string | null {
  return _daemonIdentity;
}

/**
 * 仅供测试隔离：captureDaemonIdentity 写入的是模块级单例，同进程内不可逆。
 * 当前无污染（npm run test:all 每个测试文件独立 jiti 进程，模块缓存不跨文件共享），
 * 但将来任何在同一文件内先跑 daemon 启动路径、再断言 CLI 语义（守卫应为 no-op）
 * 的用例都会被静默污染，故提供与 resetConfigCache 对称的清零入口。
 */
export function resetDaemonIdentity(): void {
  _daemonIdentity = null;
  _daemonScopeKbDirs = null;
}

/** 当前配置的身份是否与 daemon 启动时不同（未捕获时恒为 false）。 */
export function isDaemonIdentityDrifted(config: KiConfig): boolean {
  if (_daemonIdentity === null) return false;
  return daemonIdentityFingerprint(config) !== _daemonIdentity
    || scopeKbDirsSignature(config) !== _daemonScopeKbDirs;
}

/**
 * 身份漂移则 fail-loud。调用点：daemon 侧每个业务请求入口（RPC execute、HTTP /mcp 与 /api/*），
 * 以及长操作的写入边界与 getEngine 命中缓存前（入口一次检查拦不住数分钟的中途变更）。
 * 不用于 /healthz 与 ping：那两个端点必须在漂移时仍可用，否则运维无法诊断。
 * @throws code=DAEMON_IDENTITY_DRIFT
 */
export function assertDaemonIdentityCurrent(config: KiConfig): void {
  if (_daemonIdentity === null) return;
  const identityChanged = daemonIdentityFingerprint(config) !== _daemonIdentity;
  const kbDirsChanged = scopeKbDirsSignature(config) !== _daemonScopeKbDirs;
  if (!identityChanged && !kbDirsChanged) return;
  // 区分两类漂移，因为出路不同：vectorDir/dataDir 变了是重启；kbDir 变了可能是
  // 用户故意改的，但同样必须重启（已打开的句柄与已写的 KB 位置不会自己迁移）。
  const what = identityChanged
    ? 'vectorDir/dataDir'
    : 'scope 级 kbDir';
  throw Object.assign(
    new Error(
      `daemon 身份配置已漂移：当前 ${what} 与 daemon 启动时不同。`
      + 'daemon 内存中的 engine 与已打开的 Collection 句柄仍指向旧路径，'
      + '继续服务会把数据写到错误位置（KB 与向量索引可能指向不同数据）。'
      + '请执行 ki mcp stop && ki mcp --http --daemon 以新配置重启 daemon。'
    ),
    { code: 'DAEMON_IDENTITY_DRIFT' },
  );
}

/** scope 级 kbDir 映射的规范化签名（经 stableRealpath，按 scope 名排序）。 */
function scopeKbDirsSignature(config: KiConfig): string {
  return JSON.stringify(
    Object.entries(config.scopes)
      .filter(([, value]) => !!value.kbDir)
      .map(([scope, value]) => [scope, stableRealpath(value.kbDir!)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** 按完整运行配置生成握手指纹（不包含 embedding 密钥）。 */
export function configFingerprint(config: KiConfig): string {
  const canonicalVectorDir = stableRealpath(config.vectorDir);
  const payload = {
    vectorDir: canonicalVectorDir,
    // daemon 同时读写 KB/cache；相同 vectorDir 但不同 dataDir 的配置不能共享 owner。
    dataDir: stableRealpath(config.dataDir),
    scopeKbDirs: JSON.parse(scopeKbDirsSignature(config)) as unknown,
    embedding: {
      provider: config.embedding.provider,
      baseURL: config.embedding.baseURL,
      model: config.embedding.model,
      dimension: config.embedding.dimension,
    },
    vector: {
      maxOpenCollections: config.vector?.maxOpenCollections ?? 8,
    },
    scopeMode: config.scopeMode,
    scopes: Object.keys(config.scopes).sort(),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

/** 向量 Collection 根目录；旧的单 Collection 目录保留，由用户重新 import 重建。 */
export function getCollectionsRoot(config: KiConfig): string {
  return path.join(config.vectorDir, 'collections');
}

/** scope → Collection dbPath。scope 已做字符校验，不允许逃逸 collections 根目录。 */
export function getScopeCollectionPath(config: KiConfig, scope: string): string {
  validateScope(scope);
  const root = path.resolve(getCollectionsRoot(config));
  const target = path.resolve(root, scope);
  if (target !== path.join(root, scope) || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`scope Collection 路径越界：${scope}`);
  }
  // lexical 校验无法阻止手工创建的 scope 符号链接逃逸；已存在的 Collection
  // 必须解析后仍位于 collections 根目录内。
  let targetStat: fs.Stats;
  try {
    targetStat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw err;
  }
  try {
    const rootReal = fs.realpathSync(root);
    const targetReal = fs.realpathSync(target);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`scope Collection 符号链接越界：${scope}`);
    }
  } catch (err) {
    if (targetStat.isSymbolicLink()) {
      throw new Error(`scope Collection 符号链接无效：${scope}`);
    }
    throw err;
  }
  return target;
}

/** 布局元数据文件，供 daemon 握手和错误诊断使用。 */
export function getLayoutPath(config: KiConfig): string {
  return path.join(getCollectionsRoot(config), 'layout.json');
}

export function ensureVectorLayout(config: KiConfig): void {
  const root = getCollectionsRoot(config);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const layoutPath = getLayoutPath(config);
  if (!fs.existsSync(layoutPath)) {
    fs.writeFileSync(
      layoutPath,
      JSON.stringify({ version: VECTOR_LAYOUT_VERSION, createdAt: new Date().toISOString(), host: os.hostname() }, null, 2),
      { mode: 0o600 },
    );
    return;
  }
  let layout: { version?: unknown };
  try {
    layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as { version?: unknown };
  } catch {
    throw new Error(`向量布局元数据损坏：${layoutPath}；请删除向量目录后重新 import`);
  }
  if (layout.version !== VECTOR_LAYOUT_VERSION) {
    throw new Error(`向量布局版本不匹配：期望 ${VECTOR_LAYOUT_VERSION}，实际 ${String(layout.version)}；请删除向量目录后重新 import`);
  }
}

export function removeScopeCollection(config: KiConfig, scope: string): void {
  const target = getScopeCollectionPath(config, scope);
  fs.rmSync(target, { recursive: true, force: true });
}
