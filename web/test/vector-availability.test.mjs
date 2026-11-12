/**
 * 向量可用性判据单测（lib/vectorAvailability.ts + lib/healthSummary.ts 的向量部分）
 *
 * 背景：该能力来自 windows 提交 4e9d624，2026-10-29 合并 66c3c19（windows ← master）时
 * 随 hooks.ts / 三页面被「以 master 为准」整取而丢失；本次以纯函数形式接回，此处锁住不变量。
 *
 * 锁住六条不变量：
 *   1) 四态判定顺序：unavailable（scope 降级 / 向量探测项 fail）→ unknown（请求失败 / ok:false）
 *      → available（探测项齐且全 pass **且** scopeList.vectorAvailable === true）→ checking；
 *      "已确诊不可用"不得被另一次请求失败盖成"未知"（两者给用户的动作不同）；
 *   2) 探测项不全（后端未跑完）时保守判 unknown，不误放行为 available；
 *   3) `summarizeHealth` 的 level / label 判定**逐字未变**（新增 vectorFailures 字段不得影响它们）；
 *   4) `vectorOnlyFailureLabel` 只在"全部 fail 项都是向量探测项"时给降级文案；
 *   5) `vectorBadgeLabel` 不对 checking / unreachable / slow 降级（服务本身的问题更该被看到）；
 *   6) 编辑器「保存时向量化」默认值 = 跟随文档索引（2026-11-12 B 口径）：派生写法、点击取反方式、
 *      向量不可用降级三条用源码守卫锁住；开关说明按文档当前索引模式分两种说法（见文件末尾 describe）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { resolveVectorAvailability, vectorAvailabilityHint, editorVectorizeHint, vectorBadgeLabel } =
  await vite.ssrLoadModule('/src/lib/vectorAvailability.ts');
const { summarizeHealth, vectorOnlyFailureLabel, isVectorHealthCheck, VECTOR_HEALTH_CHECK_NAMES } =
  await vite.ssrLoadModule('/src/lib/healthSummary.ts');
after(async () => vite.close());

const item = (name, status, detail) => ({ name, status, ...(detail === undefined ? {} : { detail }) });
const healthOf = (items) => ({
  ok: true,
  report: {
    pass: items.filter((i) => i.status === 'pass').length,
    warn: items.filter((i) => i.status === 'warn').length,
    fail: items.filter((i) => i.status === 'fail').length,
    items,
  },
});
/** 全部向量探测项 pass 的健康报告（available 的前置条件之一） */
const vectorAllPass = () => ['apiKey', 'URL 连通性', '密钥有效性', '维度匹配'].map((n) => item(n, 'pass'));
const slice = (data, extra = {}) => ({ data, error: undefined, isPending: false, ...extra });

describe('白名单与 healthSummary 契约', () => {
  it('四个后端探测项名被识别为向量项，其它项名不算', () => {
    assert.equal(VECTOR_HEALTH_CHECK_NAMES.size, 4);
    for (const n of ['apiKey', 'URL 连通性', '密钥有效性', '维度匹配']) {
      assert.equal(isVectorHealthCheck(n), true, n);
    }
    assert.equal(isVectorHealthCheck('目录可读'), false);
    assert.equal(isVectorHealthCheck('批大小探测'), false);
  });

  it('新增 vectorFailures 不改变 level / label（回归锁）', () => {
    const fail = summarizeHealth(healthOf([item('a', 'pass'), item('b', 'fail', '磁盘不可读')]), null, false);
    assert.equal(fail.level, 'fail');
    assert.equal(fail.label, '1 项异常 · b');
    assert.deepEqual(fail.vectorFailures, []);

    const ok = summarizeHealth(healthOf([item('a', 'pass')]), null, false);
    assert.equal(ok.level, 'ok');
    assert.equal(ok.label, '服务健康');
    assert.deepEqual(ok.vectorFailures, []);

    const pending = summarizeHealth(undefined, null, true);
    assert.equal(pending.level, 'checking');
    assert.deepEqual(pending.vectorFailures, []);
  });

  it('vectorFailures 只收 fail 状态的向量项（warn 不算）', () => {
    const s = summarizeHealth(healthOf([
      item('密钥有效性', 'fail', '401'),
      item('维度匹配', 'warn', '待确认'),
      item('apiKey', 'pass'),
    ]), null, false);
    assert.deepEqual(s.vectorFailures, ['密钥有效性']);
  });
});

describe('四态判定（顺序不可调换）', () => {
  it('两路都在 loading → checking', () => {
    const v = resolveVectorAvailability({
      health: { data: undefined, error: undefined, isPending: true },
      scopeList: { data: undefined, error: undefined, isPending: true },
    });
    assert.equal(v.status, 'checking');
  });

  it('探测项全 pass 且 vectorAvailable===true → available', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf(vectorAllPass())),
      scopeList: slice({ ok: true, scopes: [], vectorAvailable: true }),
    });
    assert.equal(v.status, 'available');
    assert.equal(v.reason, undefined);
  });

  it('scope 枚举降级（vectorAvailable===false）→ unavailable，透出 vectorReason', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf(vectorAllPass())),
      scopeList: slice({ ok: true, scopes: [], vectorAvailable: false, vectorReason: '向量库被导入进程持锁' }),
    });
    assert.equal(v.status, 'unavailable');
    assert.equal(v.reason, '向量库被导入进程持锁');
  });

  it('向量探测项 fail → unavailable，reason 取该项 detail', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf([item('a', 'pass'), item('密钥有效性', 'fail', '401 Unauthorized')])),
      scopeList: slice({ ok: true, scopes: [], vectorAvailable: true }),
    });
    assert.equal(v.status, 'unavailable');
    assert.equal(v.reason, '401 Unauthorized');
  });

  /**
   * 401/403 与维度不符自 2026-11-02 起改为「可降级」：MCP 启动不再拒绝，健康报告里这几项变 warn。
   * 判据必须把 warn 与 fail 同等视为不可用（`status !== 'pass'`）—— 锁住此点，
   * 否则将来有人改成 `=== 'fail'`，401 用户会看到"向量可用"却一用就失败。
   */
  it('向量探测项 warn（401/维度不符降级后的真实形态）→ 同样 unavailable，reason 透出修复指引', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf([
        item('apiKey', 'pass'),
        item('URL 连通性', 'pass'),
        item('密钥有效性', 'warn', '密钥无效（HTTP_401）：请更新 embedding.apiKey'),
        item('维度匹配', 'warn', '未获取到向量，无法校验维度'),
      ])),
      scopeList: slice({ ok: true, scopes: [], vectorAvailable: false }),
    });
    assert.equal(v.status, 'unavailable');
    assert.match(v.reason, /请更新 embedding\.apiKey/);
  });

  it('unavailable 优先于 unknown：另一次请求失败不改判「未知」', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf([item('维度匹配', 'fail', '768 ≠ 1024')])),
      scopeList: { data: undefined, error: new Error('network down'), isPending: false },
    });
    assert.equal(v.status, 'unavailable');
    assert.equal(v.reason, '768 ≠ 1024');
  });

  it('请求失败（无向量失败项）→ unknown，reason 走人性化文案而非浏览器黑话', () => {
    const v = resolveVectorAvailability({
      health: { data: undefined, error: new Error('Failed to fetch'), isPending: false },
      scopeList: { data: undefined, error: undefined, isPending: false },
    });
    assert.equal(v.status, 'unknown');
    assert.match(v.reason, /无法连接服务/);
    assert.doesNotMatch(v.reason, /Failed to fetch/);
  });

  it('探测项不全（后端未跑完）→ 保守 unknown，不误放行为 available', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf([item('apiKey', 'pass'), item('URL 连通性', 'pass')])),
      scopeList: slice({ ok: true, scopes: [], vectorAvailable: true }),
    });
    assert.equal(v.status, 'unknown');
  });

  it('报告里没有向量探测项（旧 daemon）→ unknown 且给出可行动原因', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf([item('配置文件', 'pass'), item('dataDir', 'pass')])),
      scopeList: slice({ ok: true, scopes: [], vectorAvailable: true }),
    });
    assert.equal(v.status, 'unknown');
    assert.match(v.reason, /daemon 版本可能较旧/);
    assert.match(v.reason, /ki mcp --http/);
  });

  it('探测项齐但 scopeList 未声明 vectorAvailable===true → unknown', () => {
    const v = resolveVectorAvailability({
      health: slice(healthOf(vectorAllPass())),
      scopeList: slice({ ok: true, scopes: [] }),
    });
    assert.equal(v.status, 'unknown');
  });
});

describe('展示文案', () => {
  it('三态 hint 分别给出降级原因与动作', () => {
    assert.match(vectorAvailabilityHint({ status: 'unavailable', reason: '密钥无效' }), /向量服务不可用.*密钥无效/);
    assert.match(vectorAvailabilityHint({ status: 'checking' }), /正在检查/);
    assert.match(vectorAvailabilityHint({ status: 'unknown', reason: 'timeout' }), /无法确认.*timeout/);
  });

  it('available 态返回空串（不得在正常界面上挂「无法确认」）', () => {
    assert.equal(vectorAvailabilityHint({ status: 'available' }), '');
  });

  it('vectorOnlyFailureLabel：全部 fail 都是向量项才降级', () => {
    const onlyVector = summarizeHealth(healthOf([item('密钥有效性', 'fail', '401'), item('apiKey', 'fail', '未配置')]), null, false);
    assert.equal(vectorOnlyFailureLabel(onlyVector), '向量不可用 · 密钥有效性');

    const mixed = summarizeHealth(healthOf([item('目录可读', 'fail', '权限'), item('密钥有效性', 'fail', '401')]), null, false);
    assert.equal(vectorOnlyFailureLabel(mixed), null);

    const noFail = summarizeHealth(healthOf([item('a', 'pass')]), null, false);
    assert.equal(vectorOnlyFailureLabel(noFail), null);
  });

  it('vectorBadgeLabel：服务不可达/检查中/超时不降级（避免盖掉更该看的问题）', () => {
    const availability = { status: 'unavailable', reason: 'x' };
    for (const level of ['checking', 'unreachable', 'slow']) {
      assert.equal(vectorBadgeLabel({ level, label: 'l', detail: '', issues: [], hasReport: false, vectorFailures: [] }, availability), null, level);
    }
  });

  it('vectorBadgeLabel：报告无 fail 但 scope 层降级 → 向量不可用', () => {
    const s = summarizeHealth(healthOf(vectorAllPass()), null, false);
    assert.equal(vectorBadgeLabel(s, { status: 'unavailable', reason: '被持锁' }), '向量不可用');
  });

  it('vectorBadgeLabel：401 降级为 warn（报告无 fail）→ 仍是「向量不可用」而非「N 项告警」', () => {
    const s = summarizeHealth(healthOf([
      item('配置文件', 'pass'),
      item('密钥有效性', 'warn', '密钥无效（HTTP_401）'),
      item('维度匹配', 'warn', '未获取到向量'),
    ]), null, false);
    assert.equal(s.level, 'warn');
    assert.equal(
      vectorBadgeLabel(s, { status: 'unavailable', reason: '密钥无效（HTTP_401）' }),
      '向量不可用',
      '顶栏必须点明"向量不可用"，而不是笼统的"N 项告警"',
    );
  });

  it('vectorBadgeLabel：非向量 fail 存在时不降级到向量文案', () => {
    const s = summarizeHealth(healthOf([item('目录可读', 'fail', '权限')]), null, false);
    assert.equal(vectorBadgeLabel(s, { status: 'unavailable' }), null);
    assert.equal(s.label, '1 项异常 · 目录可读');
  });
});

/**
 * 编辑文档「保存时向量化」开关的**行内**说明（2026-11-02）。
 *
 * 锁住三条不变量：
 *   1) 只有 `available` 允许说"默认跟随文档索引"这层常规说明；其余三态**必须**同时讲清后果
 *      （"本次只写全文索引（FTS）"）—— 只灰化开关不说后果，用户会以为保存后仍是 dense；
 *   2) **不拼 `availability.reason`**：这句话挂在开关右边同一行，拼上后端原因
 *      （如「密钥无效（HTTP_401）：请更新 embedding.apiKey…后重启 ki mcp」）会拖成三行、
 *      把 footer 顶高 —— 这是 2026-11-02 用户明确否掉的观感。完整原因在顶栏徽标的健康明细里，
 *      故这里连 reason 都不许出现，`reason` 只作为入参存在、不参与输出；
 *   3) 文案必须短：行内单句，超过一定长度必然折行（窄屏由样式兜底折到第二行）。
 */
describe('editorVectorizeHint（编辑器开关说明）', () => {
  it('available + dense 文档：常规说明（括号形式，跟在标题后面）', () => {
    // 2026-11-12（B 口径）：默认值改为跟随文档当前索引模式，文案不再说"默认关闭"。
    // 不传 indexMode（加载中）走这条兜底，与 dense 同句。
    assert.equal(editorVectorizeHint({ status: 'available' }), '（默认跟随文档索引；关闭时写 FTS）');
    assert.equal(editorVectorizeHint({ status: 'available' }, 'dense'), '（默认跟随文档索引；关闭时写 FTS）');
  });

  it('available + fts 文档：按当前状态陈述，不说"默认关闭"', () => {
    // fts 文档上开关初始是灭的，说"默认关闭"会被读成"你把它关了"（2026-11-12 用户定稿）
    assert.equal(editorVectorizeHint({ status: 'available' }, 'fts'), '（当前为全文索引；保存保持现状）');
  });

  it('unavailable：一句说明，不带后端原因', () => {
    const text = editorVectorizeHint({ status: 'unavailable', reason: '密钥无效（HTTP_401）：请更新 embedding.apiKey' });
    assert.equal(text, '向量服务不可用，本次只写全文索引（FTS）');
  });

  it('★ 任何状态都不许把 reason 拼进文案（否则行内折成三行）', () => {
    for (const status of ['available', 'unavailable', 'checking', 'unknown']) {
      const text = editorVectorizeHint({ status, reason: 'MAGIC-REASON-TOKEN' });
      assert.ok(!text.includes('MAGIC-REASON-TOKEN'), `${status} 把 reason 拼进了文案：${text}`);
    }
  });

  it('checking：说明还在探测、且本次按全文处理', () => {
    const text = editorVectorizeHint({ status: 'checking' });
    assert.ok(text.includes('正在检查'), text);
    assert.ok(text.includes('只写全文索引（FTS）'), text);
  });

  it('unknown：无法确认，但仍讲清本次写全文', () => {
    const text = editorVectorizeHint({ status: 'unknown' });
    assert.ok(text.includes('无法确认'), text);
    assert.ok(text.includes('只写全文索引（FTS）'), text);
  });

  it('除 available 外，任一只读态都必须讲清"只写全文索引"', () => {
    for (const status of ['unavailable', 'checking', 'unknown']) {
      assert.ok(
        editorVectorizeHint({ status }).includes('只写全文索引（FTS）'),
        `${status} 未讲清后果`,
      );
    }
  });

  it('行内单句：非 available 文案不超过 24 个字（防再被拼长）', () => {
    for (const status of ['unavailable', 'checking', 'unknown']) {
      const text = editorVectorizeHint({ status });
      assert.ok([...text].length <= 24, `${status} 文案过长（${[...text].length}）：${text}`);
    }
  });
});

/**
 * 「保存时向量化」默认值的口径（2026-11-12 用户定稿 B）。
 *
 * 为什么用源码守卫而不是渲染测试：默认值是**派生**逻辑（`loaded` 异步到达后才成立），
 * 组件里没有可独立调用的纯函数，跑渲染又要拖起整棵依赖。这三条恰好都是「一行代码就能退回去」
 * 的形态，锁住源码写法最省事。
 */
describe('文档编辑器「保存时向量化」默认值 = 跟随文档索引（B 口径）', () => {
  const src = readFileSync(path.join(webRoot, 'src/components/DocumentEditor.tsx'), 'utf8');

  it('未手动切换时跟随 loaded.indexMode，不得写死 useState(true)', () => {
    assert.match(
      src,
      /const vectorizeChoice = vectorizeTouched \? vectorize : loaded\?\.indexMode === 'dense'/,
      '未 touched 时必须读 loaded.indexMode —— 写死 true 会把 fts-only 文档隐式升级成 dense',
    );
    assert.doesNotMatch(
      src,
      /const \[vectorize, setVectorize\] = useState\(true\)/,
      'vectorize 初值不得为 true（加载是异步的，初值拿不到 indexMode）',
    );
  });

  it('点击按当前显示值取反，不得用 prev => !prev', () => {
    assert.match(src, /setVectorize\(!effectiveVectorize\)/, '应按显示值取反');
    // 断言「不得有任何基于 state 的取反」而不是只挡 `prev => !prev`：
    // 改个形参名（`v => !v`）就能绕过单点匹配，那正是这条守卫要防的退化写法。
    assert.doesNotMatch(
      src,
      /setVectorize\(\s*\(?\s*\w+\s*\)?\s*=>/,
      '未 touched 时 state 恒为 false，而显示值可能已派生为 true ⇒ 第一下点击会「看着亮却没关掉」',
    );
  });

  it('向量不可用时仍强制降级为 FTS（与 2026-11-02 的口径一致）', () => {
    assert.match(src, /const effectiveVectorize = vectorizeChoice && vectorAvailable/);
  });
});
