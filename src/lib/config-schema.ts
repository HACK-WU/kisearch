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

import { isAbsolute } from 'path';

import { validateQueryTimeoutMs } from './query-timeout.js';

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

/**
 * 绝对路径校验（供 `wikiSync.sourceDir` 使用）。
 *
 * 为什么禁止相对路径：`loadConfig` 对相对路径的解析基准是**配置文件所在目录**
 * （`expandPath` 的 `path.resolve(baseDir, …)`，baseDir = `path.dirname(configFile)`），
 * 而用户写 `./wiki` 时想的是**当前仓库 / 当前 shell 的 cwd**。配置放在 `~/.ki/config.yaml`
 * 时两者相差极远（`./wiki` → `~/.ki/wiki`），写回会静默写到错误位置 —— 语义猜不对，
 * 因此不猜：直接拒绝并要求写绝对路径（fail-loud + 给出路）。
 *
 * 允许 `~` / `$HOME` 前缀（展开后即绝对路径，且跨机器可移植，模板与文档都用这种写法）。
 * `${HOME}/…` **不**支持：`expandPath` 不认该写法，会拼成字面量目录 `${HOME}`。
 */
function absolutePath(value: unknown, path: string, add: AddFn): void {
  const s = value as string;
  if (!s.trim()) return; // 空串：由 string 分支的 warn 处理（按"未配置"）
  if (/^(\$HOME|~)(?=$|[\\/])/.test(s) || isAbsolute(s)) return;
  add(
    path,
    `必须是绝对路径（如 /data/wiki，或 $HOME/wiki、~/wiki）：实际为 "${s}"。`
    + '相对路径的解析基准是配置文件所在目录而非 shell 当前目录，极易静默落到错误位置，故不支持'
  );
}

// ─── 思考级别校验（REQ-20261016-001 · 设计 §9.1）───────────────
//
// D5 口径：**只走 OpenAI 通用协议、不做厂商适配** ⇒ 这里**不维护任何内置取值表**
//   （`low/high/max` 只是调试样本），清单本身就是权威白名单。
// 但"不校验取值"≠"不校验形状"：长度/数量/重复/保留字仍需护栏（否则误粘贴即可撑爆面板）。

/** 前端保留字：面板用"跟随模型默认"表示它，**不得**出现在配置中（设计 §2 / §4.3）。 */
export const REASONING_EFFORT_RESERVED = '__follow_default__';
/** 单值长度上限（`prompt-config` 的覆盖值校验**同源引用**本常量，避免两处漂移） */
export const REASONING_EFFORT_MAX_CHARS = 64;
/** 清单数量上限（与 `MAX_SKILLS = 20` 同风格） */
const EFFORT_MAX_ITEMS = 20;

/** 清单元素校验（类型由 `stringArray` 分支负责；此处只看取值形状）。 */
function validateEffortsList(value: unknown, path: string, add: AddFn): void {
  const list = value as unknown[];
  // 显式空清单合法：语义是"没有可选档位"（面板禁用 + 引导补档位），与"未配置"区分
  if (list.length > EFFORT_MAX_ITEMS) {
    add(path, `最多 ${EFFORT_MAX_ITEMS} 个档位，实际 ${list.length}`);
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== 'string') continue; // 元素类型问题已由 stringArray 分支报出
    if (!item.trim()) {
      add(`${path}[${i}]`, '档位值不能为空字符串');
    } else if (item.length > REASONING_EFFORT_MAX_CHARS) {
      add(`${path}[${i}]`, `档位值不得超过 ${REASONING_EFFORT_MAX_CHARS} 字符，实际 ${item.length}`);
    } else if (item === REASONING_EFFORT_RESERVED) {
      add(`${path}[${i}]`, `"${REASONING_EFFORT_RESERVED}" 是内部保留值（表示"跟随模型默认"），不能作为档位；请填写上游真实取值`);
    } else if (seen.has(item)) {
      add(`${path}[${i}]`, `档位值重复：${item}`);
    }
    seen.add(item);
  }
}

/** 默认档（单值）校验：不校验是否在清单内 —— 那是跨字段的事（见下）。 */
function validateEffortValue(value: unknown, path: string, add: AddFn): void {
  const s = value as string;
  if (!s.trim()) {
    add(path, '档位值不能为空字符串');
  } else if (s.length > REASONING_EFFORT_MAX_CHARS) {
    add(path, `档位值不得超过 ${REASONING_EFFORT_MAX_CHARS} 字符，实际 ${s.length}`);
  } else if (s === REASONING_EFFORT_RESERVED) {
    add(path, `"${REASONING_EFFORT_RESERVED}" 是内部保留值（表示"跟随模型默认"）；如需"不传"请直接删除本字段`);
  }
}

/**
 * 跨字段校验：默认档必须落在清单内（设计 §5 决策 1 —— 单字段 validate 拿不到兄弟字段，
 * 故挂在 `llm` 的 **object 节点** 上；`walkValue` 的 validate 调用位于 switch 之后，对 object 同样执行）。
 *
 * ⚠️ 该错误会**阻断全部 ki 命令**（配置加载阶段 fail-loud）⇒ 文案必须给出两条出路。
 */
function validateEffortCrossField(value: unknown, path: string, add: AddFn): void {
  const obj = value as Record<string, unknown>;
  const def = obj.reasoningEffort;
  if (typeof def !== 'string' || !def.trim()) return; // 未配置 / 类型问题已在上方报出
  const list = obj.reasoningEfforts;
  const at = `${path}.reasoningEffort`;
  if (!Array.isArray(list)) {
    add(at, '配置了思考级别默认档但缺少可选档位清单：请补 llm.reasoningEfforts，或删除本字段（删除 = 不传该参数）');
    return;
  }
  const items = list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (!items.includes(def)) {
    add(
      at,
      `默认档 "${def}" 不在可选档位清单内（可用：${items.length > 0 ? items.join(' | ') : '（清单为空）'}）；`
      + '请同步修改本字段或删除它。⚠️ 该错误会让全部 ki 命令在加载配置阶段即报错（含排障入口）',
    );
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
        // 必须是绝对路径：相对路径会按「配置文件所在目录」展开，与用户直觉（shell cwd）不符
        sourceDir: { type: 'string', validate: absolutePath },
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
        assets: { type: 'boolean' },
        maxAssetSize: { type: 'number', validate: positiveInt },
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
        queryTimeoutMs: { type: 'number', validate: validateQueryTimeoutMs },
        scheduler: {
          type: 'object',
          fields: {
            batchSize: { type: 'number', validate: positiveInt },
            maxConcurrency: { type: 'number', validate: positiveInt },
            maxGlobalConcurrency: { type: 'number', validate: positiveInt },
            maxPrefetchBatches: { type: 'number', validate: positiveInt },
            maxBufferedVectorBytes: { type: 'number', validate: positiveInt },
            globalBufferedVectorBytes: { type: 'number', validate: positiveInt },
            requestTimeoutMs: { type: 'number', validate: positiveInt },
            // B 策略熔断（2026-10-12）：连续失败多少次 provider 调用后停止剩余批次
            consecutiveFailureThreshold: { type: 'number', validate: positiveInt },
          },
        },
      },
    },
    scopeMode: { type: 'literal', values: ['default', 'strict'] },
    // REQ-20261029-001：只读 scope 名单。**顶层节点**（不进 scopes）——
    // 写进 scopes 条目会让 registered=true，strict 模式下等于把只读库加进检索白名单。
    scopeReadonly: { type: 'stringArray' },
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
    vector: {
      type: 'object',
      fields: {
        maxOpenCollections: { type: 'number', validate: positiveInt },
        // S-01（REQ-20261009-003）：索引整理（optimize）——见 ki index-optimize / 导入收尾
        optimize: {
          type: 'object',
          fields: {
            /** 导入收尾是否自动触发索引整理（默认 true） */
            enabled: { type: 'boolean' },
            /** 整理线程数（0 = 引擎自动；1 ≈ 1 核，实验 1 实测） */
            concurrency: { type: 'number', validate: positiveInt },
            /** 整理等待上限，超过即判定"超时 = 中断"（默认 600000） */
            timeoutMs: { type: 'number', validate: positiveInt },
          },
        },
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
    // 【新增】llm 段（REQ-20260924-001 · S01 §3 + §9.1）
    // ⚠️ 整段可选：旧配置无 llm 段必须正常加载（回归点）。
    //    段内 baseURL/model/apiKey 也不做「必填」校验 —— 缺失是**可预期的产品状态**
    //    （由 GET /api/chat/config 返回 enabled:false 表达），而非配置错误。
    //    若在此处 fail-loud，未使用对话功能的用户升级后在 doctor 会变红。
    llm: {
      type: 'object',
      fields: {
        baseURL: { type: 'string' },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        maxTokens: { type: 'number', validate: positiveInt },
        temperature: { type: 'number' },
        requestTimeoutMs: { type: 'number', validate: positiveInt },
        firstByteTimeoutMs: { type: 'number', validate: positiveInt },
        defaultSystemPrompt: { type: 'string' },
        supportsImages: { type: 'boolean' },
        maxImagesPerMessage: { type: 'number', validate: positiveInt },
        maxImageBytes: { type: 'number', validate: positiveInt },
        // ── v2（D13）──
        supportsTools: { type: 'boolean' },
        kbDisclosureAck: { type: 'boolean' },
        // ── v3（REQ-20261013-001）── 上下文上限（字符数，默认 1000K）
        contextChars: { type: 'number', validate: positiveInt },
        // ── v4（REQ-20261016-001）── 思考级别（OpenAI 通用协议纯透传；不做厂商适配 = D5）
        /** 可选档位清单：面板选项来源 + 合法性白名单（**不校验具体取值**） */
        reasoningEfforts: { type: 'stringArray', validate: validateEffortsList },
        /** 部署默认档：必须 ∈ `reasoningEfforts`（跨字段校验挂在本 object 节点上） */
        reasoningEffort: { type: 'string', validate: validateEffortValue },
      },
      validate: validateEffortCrossField,
    },
    // 【新增】chatDir：会话存储根目录（REQ-20260924-001 · S02 §3.1）
    chatDir: { type: 'string' },
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
