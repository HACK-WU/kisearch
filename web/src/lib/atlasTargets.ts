/**
 * atlasTargets.ts —— 视图下「该看哪一份图集」的**唯一判定**（纯函数，不引 React）
 *
 * 为什么必须收敛成一处：页面（渲染 iframe）与顶栏（渲染切换器）各判一次的话，
 * 一旦分叉就会出现「页面直出 A、顶栏却说有 2 个可切」——用户同时看到两个答案。
 * 独立成纯函数还能被 `web/test` 直接 ssrLoadModule 单测：本仓前端测试没有 jsdom，
 * 组件行为只能真机走查，判定逻辑留在纯函数里才测得到。
 *
 * 背景（2026-11-25 用户拍板）：图集是**整幅 HTML 画布**，多库合并不了，也不给视图
 * 单独装一份（`/open/v1/atlas/*` 显式拒绝视图名）。所以视图下要做的不是「合并图集」，
 * 而是「从成员库里挑一份来看」，并且只配了一个时不要再让用户点一次。
 */

/** 一个成员库的图集探针（pending 由调用方先挡掉，这里只处理「已有结果」） */
export interface AtlasProbe {
  scope: string;
  /** 状态读取失败：**不等于**没装图集，不能并进 absent（否则用户以为图集丢了） */
  failed: boolean;
  /** failed=false 时有效 */
  exists: boolean;
  /** ISO 上传时间；旧包 / 旧 daemon 可能缺 */
  uploadedAt?: string;
}

/**
 * `AtlasTarget`（hooks.ts）的结构子集：这里只要这四个字段，用鸭子类型而不是 import
 * 是为了让本模块**不反向依赖 hooks**（判定模块不该知道 React Query 的存在）。
 */
export interface AtlasTargetLike {
  scope: string;
  isError: boolean;
  exists: boolean;
  uploadedAt?: string;
}

/** 页面与顶栏都调它得出同一份判定输入（各写一份容易漏字段、慢慢漂移） */
export function toAtlasProbes(targets: AtlasTargetLike[]): AtlasProbe[] {
  return targets.map((item) => ({
    scope: item.scope,
    failed: item.isError,
    exists: item.exists,
    uploadedAt: item.uploadedAt,
  }));
}

export interface AtlasViewShape {
  /** 装了图集的成员（按成员顺序，不按上传时间重排 —— 切换器列表要稳定） */
  members: string[];
  /** 读取失败的成员 */
  failed: string[];
  /** 确定没装图集的成员 */
  absent: string[];
  /** 当前该看的那份；members 为空时 `null` */
  selected: string | null;
}

/**
 * 视图下的选中优先级：记得的那个（仍可用）> 最近上传 > 成员顺序首个。
 *
 * 「记得」来自 URL `?member=`（顶栏切换时写入）：刷新、收藏、分享都停在同一份。
 * 指向已被移出视图的库时静默回落 —— 视图成员会被 `ki view update` 改。
 *
 * ⚠️ 最近上传只用于**首次进入**：一旦用户手动切过，URL 就是最高优先。否则
 *    「刚给 B 上了新版本」会把正在看 A 的人弹走，属于抢用户的选择。
 */
export function resolveAtlasView(
  probes: AtlasProbe[],
  remembered: string | null | undefined,
): AtlasViewShape {
  const members = probes.filter((p) => !p.failed && p.exists).map((p) => p.scope);
  const failed = probes.filter((p) => p.failed).map((p) => p.scope);
  const absent = probes.filter((p) => !p.failed && !p.exists).map((p) => p.scope);

  let selected: string | null = null;
  if (members.length > 0) {
    if (remembered && members.includes(remembered)) {
      selected = remembered;
    } else {
      selected = members[0];
      let latest = -Infinity;
      for (const probe of probes) {
        if (!members.includes(probe.scope)) continue;
        // 非法/缺失 → NaN，`Number.isFinite` 挡住，自然回落到成员顺序首个
        const at = Date.parse(probe.uploadedAt ?? '');
        if (Number.isFinite(at) && at > latest) {
          latest = at;
          selected = probe.scope;
        }
      }
    }
  }

  return { members, failed, absent, selected };
}

/**
 * 切换器末尾那行补充说明：「另有 K 个成员库未配置图集 · M 个读取失败」。
 *
 * 两类必须分开说：把读失败混进「未配置」等于告诉用户「这些库没有图集」，
 * 而事实上是**没读到**（R5）。没有可说的内容时返回 `null`，调用方不渲染该行。
 */
export function atlasMemberNote(shape: AtlasViewShape): string | null {
  const parts: string[] = [];
  if (shape.absent.length > 0) parts.push(`另有 ${shape.absent.length} 个成员库未配置图集`);
  if (shape.failed.length > 0) parts.push(`${shape.failed.length} 个成员库读取失败`);
  return parts.length > 0 ? parts.join(' · ') : null;
}