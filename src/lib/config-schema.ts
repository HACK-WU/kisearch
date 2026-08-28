/**
 * config-schema.ts —— ki 配置文件字段级校验（名称 + 类型 + 取值）
 *
 * 供 config.ts::parseAndExpand 在 YAML/JSON 语法解析成功后调用：
 *   语法正确 ≠ 内容合法。拼错的字段名（datDir）、写错的类型（dimension: "4096"）、
 *   非法枚举值（scopeMode: strick）过去会被宽容解析静默吞掉（落默认值 / NaN），
 *   本模块把它们收敛为一次性的 fail-loud 错误清单。
 *
 * 校验策略（与项目「fail-loud + 给出路」哲学对齐）：
 *   - 未知字段名 → 错误（附 Levenshtein 相近字段建议）
 *   - 已知废弃字段（如 scope 级 sourceDir）→ 告警（文档已保证“被忽略”，不打破存量配置）
 *   - 类型不符 / 非法枚举 / 非法取值 → 错误
 *   - null 的 scope 条目（YAML 裸写 `default:`）→ 告警（现行为是静默丢弃，属高频陷阱）
 *   - 收集全部问题后一次性报告，避免用户「改一个报一个」挤牙膏
 */

// ─── 节点模型 ───

/** 单条校验问题（path 为配置文件内的字段路径，如 scopes.monitor.wikiSync.enabled） */
export interface ConfigIssue {
  path: string;
  message: string;
}

type AddFn = (path: string, message: string) => void;

/** 告警收集通道（不阻断加载；未提供时告警降级为错误） */
export type WarnFn = (issue: ConfigIssue) => void;

/**
 * 结构节点声明：type 决定标量校验；fields（固定键对象）与 value（map 值）
 * 决定递归方向；nullHandling / deprecated / validate 承载局部特例。
 */
interface ConfigNode {
  type: 'string' | 'number' | 'boolean' | 'object' | 'stringArray' | 'literal';
  /** literal 模式的候选值（如 scopeMode: default | strict） */
  values?: string[];
  /** 固定键对象子表 */
  fields?: Record<string, ConfigNode>;
  /** map 节点（键自由）的值节点，如 scopes → scope 条目 */
  value?: ConfigNode;
  /** map 节点自身声明：遇到 null 的条目值的处理策略（缺省按类型报错）；实现方自行决定走 warn 还是降级 add */
  nullHandling?: (path: string, key: string, add: AddFn, warn: WarnFn | undefined) => void;
  /** 该层已知废弃字段：字段名 → 迁移说明。命中只告警不阻断（存量配置仍可加载） */
  deprecated?: Record<string, string>;
  /**
   * 类型通过后的取值校验（正整数、URL 前缀、端口范围等）。
   * 注：类型/结构本身不合法时 walkValue 提前 return，不会回调 validate；
   * object 节点挂 validate 无实际意义（子字段由 fields 负责），仅对标量使用。
   */
  validate?: (value: unknown, path: string, add: AddFn) => void;
}

// ─── 通用校验器 ───

function positiveInt(value: unknown, path: string, add: AddFn): void {
  if ((value as number) <= 0 || !Number.isInteger(value)) {
    add(path, '应为正整数');
  }
}

function portRange(value: unknown, path: string, add: AddFn): void {
  const n = value as number;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    add(path, `应为 1-65535 之间的整数，实际=${n}`);
  }
}

function httpUrl(value: unknown, path: string, add: AddFn): void {
  const s = value as string;
  if (!/^https?:\/\//.test(s)) {
    add(path, '应为 http(s):// 开头的 URL');
  }
}

// ─── Schema 声明（与 docs/configuration.md 字段表一一对应） ───

const SCOPE_ENTRY: ConfigNode = {
  type: 'object',
  fields: {
    kbDir: { type: 'string' },
    wikiSync: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        sourceDir: { type: 'string' },
        autoBackfill: { type: 'boolean' },
      },
    },
    clean: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        rules: {
          type: 'object',
          fields: {
            bom: { type: 'boolean' },
            frontmatter: { type: 'boolean' },
            htmlComment: { type: 'boolean' },
            mermaid: { type: 'boolean' },
            codePath: { type: 'boolean' },
            codeBlock: { type: 'boolean' },
            emptyChunk: { type: 'boolean' },
            keepShortSamples: { type: 'boolean' },
          },
        },
        hooks: { type: 'stringArray' },
      },
    },
    import: {
      type: 'object',
      fields: {
        extensions: { type: 'stringArray' },
        maxFileSize: { type: 'number', validate: positiveInt },
      },
    },
  },
  // 已知废弃：scope 级 sourceDir 已由 wikiSync.sourceDir / group-index source 块承载。
  // 文档已声明「旧配置残留该字段会被忽略」，故只告警不阻断，不打破存量配置。
  deprecated: {
    sourceDir: '已废弃字段（被忽略）：导入源由 group-index source 块承载，Wiki 源目录请配置 wikiSync.sourceDir',
  },
};

const CONFIG_SCHEMA: ConfigNode = {
  type: 'object',
  fields: {
    dataDir: { type: 'string' },
    backupDir: { type: 'string' },
    vectorDir: { type: 'string' },
    embedding: {
      type: 'object',
      fields: {
        provider: { type: 'string' },
        baseURL: { type: 'string', validate: httpUrl },
        model: { type: 'string' },
        dimension: { type: 'number', validate: positiveInt },
        apiKey: { type: 'string' },
      },
    },
    scopeMode: { type: 'literal', values: ['default', 'strict'] },
    scopes: {
      type: 'object',
      value: SCOPE_ENTRY,
      // YAML 裸写 `default:` 解析为 null：现行为静默丢弃，降级为显式告警
      nullHandling: (path, key, add, warn) => {
        const issue: ConfigIssue = { path, message: `scope "${key}" 的值为空（YAML 裸写会解析为 null），该 scope 将被忽略；如需注册请显式写 {}` };
        if (warn) warn(issue);
        else add(path, issue.message);
      },
    },
    mcp: {
      type: 'object',
      fields: {
        http: {
          type: 'object',
          fields: {
            host: { type: 'string' },
            port: { type: 'number', validate: portRange },
            allowedHosts: { type: 'stringArray' },
          },
        },
      },
    },
  },
};

// ─── 遍历实现（单一入口 walkObject，fields 固定键 / value map 键两分支） ───

function childPathOf(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function walkValue(value: unknown, node: ConfigNode, path: string, add: AddFn, warn?: WarnFn): void {
  switch (node.type) {
    case 'string':
      if (typeof value !== 'string') return add(path, `应为字符串，实际为${summarize(value)}`);
      // 空串合法但会被解析器按“未配置”处理（`raw.x ? ... : 默认值`），属同类静默错配 → 告警提示
      // 仅走 warn：不阻断（清空一个字段是合法意图），无 warn 通道时降级为不报
      if (!value.trim() && warn) warn({ path, message: '值为空字符串，将按“未配置”处理（落内置默认值）' });
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return add(path, `应为数字，实际为${summarize(value)}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return add(path, `应为布尔值（true/false），实际为${summarize(value)}`);
      break;
    case 'literal':
      if (typeof value !== 'string' || !node.values!.includes(value)) {
        return add(path, `取值应为 ${node.values!.join(' | ')} 之一，实际为${summarize(value)}`);
      }
      break;
    case 'stringArray':
      if (!Array.isArray(value)) return add(path, `应为字符串数组，实际为${summarize(value)}`);
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') add(`${path}[${i}]`, `数组元素应为字符串，实际为${summarize(value[i])}`);
      }
      break;
    case 'object': {
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        return add(path, `应为对象（含子字段），实际为${summarize(value)}`);
      }
      walkObject(value as Record<string, unknown>, node, path, add, warn);
      break;
    }
  }
  node.validate?.(value, path, add);
}

function walkObject(
  obj: Record<string, unknown>,
  node: ConfigNode,
  prefix: string,
  add: AddFn,
  warn?: WarnFn,
): void {
  const fields = node.fields ?? {};
  const known = new Set(Object.keys(fields));

  // 固定键分支：未知字段报错（附拼写建议），已知废弃字段仅告警
  for (const [key, value] of Object.entries(obj)) {
    const childPath = childPathOf(prefix, key);
    if (known.has(key)) {
      walkValue(value, fields[key], childPath, add, warn);
      continue;
    }
    if (node.value) continue; // 自由键 map：未知键即合法 scope 名，交由下方 map 分支处理
    // YAML 合并键：`yaml` 库的 parse 不展开 `<<:`（实测保留为字面量键），解析器拿不到合并后的字段，
    // 写法看似生效实则静默失效 —— 正是本校验要消除的错配，故显式报错而非归入“非预期字段”。
    if (key === '<<') {
      add(childPath, 'YAML 合并键（<<: *anchor）不会被解析器展开，该写法不生效，请显式写出字段（整值引用 `*anchor` 可用）');
      continue;
    }
    // YAML 锚点的模板载体（`x-common: &tpl {...}` + `p: *tpl` 整值引用，CI 配置常见写法）：
    // 解析器本就忽略此类根键，不能当作拼写错误阻断——否则模板化写法的合法配置会直接跑不起来。
    // 内容不校验（允许为不完整片段）；scopes 下的 x- 键除外（那里它会被当真 scope 解析，走 map 分支校验）。
    if (/^x-[\w.-]+$/.test(key)) continue;
    const deprecatedMsg = node.deprecated?.[key];
    if (deprecatedMsg) {
      // 已知废弃字段：不阻断（文档已保证被忽略），仅在体检/stderr 提示迁移路径
      if (warn) warn({ path: childPath, message: deprecatedMsg });
      else add(childPath, deprecatedMsg);
      continue;
    }
    add(childPath, `非预期字段${suggestSuffix(key, Object.keys(fields))}（可用：${Object.keys(fields).join(' | ')}）`);
  }

  // 自由键 map 分支（scopes.<name>）：键非空，null 走 nullHandling，其余按值节点递归
  if (!node.value) return;
  const valueNode = node.value;
  for (const [key, value] of Object.entries(obj)) {
    if (known.has(key)) continue; // 与固定键重名的条目已在上方按类型分支校验
    const childPath = childPathOf(prefix, key);
    if (key === '<<') {
      // 同上：map 层的 `<<` 会被解析器当成一个名为 "<<" 的 scope（或盖掉真实条目），同样不生效
      add(childPath, 'YAML 合并键（<<: *anchor）不会被解析器展开，该写法不生效，请显式写出字段（整值引用 `*anchor` 可用）');
      continue;
    }
    if (!key.trim()) {
      add(prefix, '存在空 scope 名（key 应为非空字符串）');
      continue;
    }
    if (value === null || value === undefined) {
      // nullHandling 声明在 map 节点自身（如 scopes），而非条目值节点
      if (node.nullHandling) {
        node.nullHandling(childPath, key, add, warn);
      } else {
        add(childPath, `应为对象（含子字段），实际为${summarize(value)}`);
      }
      continue;
    }
    walkValue(value, valueNode, childPath, add, warn);
  }
}

// ─── 工具 ───

/** 值摘要：错误信息里展示实际值片段（截断防长） */
function summarize(value: unknown): string {
  // null 在 YAML/JSON 配置里几乎总是「只写了键名、忘填值」（如 `dataDir:` 后空着），
  // 单独提示比只说「null」更有指导性（文档字段概览被整段复制也会命中此路径）
  if (value === null) return ' null（只写了键名未赋值？）';
  if (value === undefined) return ' 空值';
  if (typeof value === 'object') return Array.isArray(value) ? ' 数组' : ' 对象';
  const s = String(value);
  return ` ${typeof value}（${s.length > 30 ? s.slice(0, 30) + '…' : s}）`;
}

/** Levenshtein 编辑距离（与 cli-args.ts 同源算法，字段名建议用） */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** 相近字段建议：编辑距离 ≤ max(2, 长度/3) 才提示，避免噪音 */
function suggestSuffix(unknown: string, known: string[]): string {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = editDistance(unknown, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  const threshold = Math.max(2, Math.ceil(unknown.length / 3));
  return best && bestDist <= threshold ? `，您是否想输入 "${best}"？` : '';
}

// ─── 入口 ───

/**
 * 校验解析后的原始配置对象（parseAndExpand 语法解析之后、宽容归一化之前调用）。
 * errors：字段名/类型/取值非法，阻断加载（fail-loud）；
 * warns：不阻断但值得提示（如 YAML 裸写 `default:` 解析为 null 的 scope 条目）。
 */
export function validateConfigFields(raw: unknown): { errors: ConfigIssue[]; warns: ConfigIssue[] } {
  const errors: ConfigIssue[] = [];
  const warns: ConfigIssue[] = [];
  const add = (path: string, message: string): void => { errors.push({ path, message }); };
  if (raw === null || raw === undefined) return { errors, warns };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path: '(root)', message: `根节点应为对象（键值对结构），实际为${summarize(raw)}` });
    return { errors, warns };
  }
  walkValue(raw, CONFIG_SCHEMA, '', add, (issue) => warns.push(issue));
  return { errors, warns };
}
