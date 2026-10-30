/**
 * 向量可用性判据单测（lib/vectorAvailability.ts + lib/healthSummary.ts 的向量部分）
 *
 * 背景：该能力来自 windows 提交 4e9d624，2026-10-29 合并 66c3c19（windows ← master）时
 * 随 hooks.ts / 三页面被「以 master 为准」整取而丢失；本次以纯函数形式接回，此处锁住不变量。
 *
 * 锁住五条不变量：
 *   1) 四态判定顺序：unavailable（scope 降级 / 向量探测项 fail）→ unknown（请求失败 / ok:false）
 *      → available（探测项齐且全 pass **且** scopeList.vectorAvailable === true）→ checking；
 *      "已确诊不可用"不得被另一次请求失败盖成"未知"（两者给用户的动作不同）；
 *   2) 探测项不全（后端未跑完）时保守判 unknown，不误放行为 available；
 *   3) `summarizeHealth` 的 level / label 判定**逐字未变**（新增 vectorFailures 字段不得影响它们）；
 *   4) `vectorOnlyFailureLabel` 只在"全部 fail 项都是向量探测项"时给降级文案；
 *   5) `vectorBadgeLabel` 不对 checking / unreachable / slow 降级（服务本身的问题更该被看到）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
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
const { resolveVectorAvailability, vectorAvailabilityHint, vectorBadgeLabel } =
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

  it('vectorBadgeLabel：非向量 fail 存在时不降级到向量文案', () => {
    const s = summarizeHealth(healthOf([item('目录可读', 'fail', '权限')]), null, false);
    assert.equal(vectorBadgeLabel(s, { status: 'unavailable' }), null);
    assert.equal(s.label, '1 项异常 · 目录可读');
  });
});
