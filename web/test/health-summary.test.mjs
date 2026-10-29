/**
 * 服务健康判据单测（REQ-20261016-003）
 *
 * 锁住五条不变量：
 *   1) **判定优先级不变**：checking → unreachable/slow → 首个 fail → 首个 warn → ok；
 *      尤其"拿到了 HTTP 应答（error 带 status）不得判 unreachable"—— 这是历史踩坑：
 *      误报「未就绪」会让用户去重启一个本来正常的 daemon；
 *   2) 明细清单：fail 全部排在 warn 之前、同级保持原序；detail 缺省退化 message、再退化空串；
 *   3) doctor 计数：只采信 report.pass/warn/fail 三个数值，缺一即 undefined（不编造）；
 *   4) 文案口径：徽标文案不再出现「MCP HTTP」；不可达给可行动人话而非 `Failed to fetch`；
 *   5) 复制载荷：优先 detail，为空退化为项名。
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
const { summarizeHealth, toHealthIssues, healthIssueCopyText, humanizeHealthError } =
  await vite.ssrLoadModule('/src/lib/healthSummary.ts');
after(async () => vite.close());

const item = (name, status, detail) => ({ name, status, ...(detail === undefined ? {} : { detail }) });
const report = (items) => ({
  pass: items.filter((i) => i.status === 'pass').length,
  warn: items.filter((i) => i.status === 'warn').length,
  fail: items.filter((i) => i.status === 'fail').length,
  items,
});
const body = (items) => ({ ok: true, report: report(items) });

describe('判定优先级（守 #2 回归锁）', () => {
  it('pending → checking', () => {
    const s = summarizeHealth(undefined, null, true);
    assert.equal(s.level, 'checking');
    assert.equal(s.label, '检测中…');
    assert.deepEqual(s.issues, []);
    assert.equal(s.hasReport, false);
  });

  it('fetch reject（无 status）→ unreachable', () => {
    const s = summarizeHealth(undefined, { message: 'Failed to fetch' }, false);
    assert.equal(s.level, 'unreachable');
    assert.equal(s.label, '无法连接服务');
    assert.deepEqual(s.issues, []);
  });

  it('有 HTTP 应答（带 status）→ 绝不判 unreachable，而是 slow', () => {
    const s = summarizeHealth(undefined, { status: 400, body: { ok: false, error: '健康检查超时（>22s）' } }, false);
    assert.equal(s.level, 'slow');
    assert.equal(s.detail, '健康检查超时（>22s）');
    assert.notEqual(s.level, 'unreachable');
  });

  it('有 fail → fail；只有 warn → warn；全 pass → ok', () => {
    assert.equal(summarizeHealth(body([item('a', 'pass'), item('b', 'fail')]), null, false).level, 'fail');
    assert.equal(summarizeHealth(body([item('a', 'pass'), item('b', 'warn')]), null, false).level, 'warn');
    assert.equal(summarizeHealth(body([item('a', 'pass')]), null, false).level, 'ok');
  });

  it('fail 优先于 warn（即使 warn 在 items 中更靠前）', () => {
    const s = summarizeHealth(body([item('w1', 'warn'), item('f1', 'fail'), item('w2', 'warn')]), null, false);
    assert.equal(s.level, 'fail');
    assert.equal(s.label, '1 项异常 · f1');
  });
});

describe('明细清单与计数', () => {
  it('fail 全排在 warn 之前，同级保序', () => {
    const s = summarizeHealth(body([
      item('w1', 'warn'), item('f1', 'fail'), item('p1', 'pass'), item('f2', 'fail'), item('w2', 'warn'),
    ]), null, false);
    assert.deepEqual(s.issues.map((i) => i.name), ['f1', 'f2', 'w1', 'w2']);
    assert.deepEqual(s.issues.map((i) => i.status), ['fail', 'fail', 'warn', 'warn']);
  });

  it('徽标文案带异常数量（不再只说"有告警"）', () => {
    const s = summarizeHealth(body([item('w1', 'warn'), item('w2', 'warn'), item('f1', 'fail')]), null, false);
    assert.equal(s.label, '1 项异常 · f1');
    const w = summarizeHealth(body([item('w1', 'warn'), item('w2', 'warn')]), null, false);
    assert.equal(w.label, '2 项告警 · w1');
  });

  it('计数取自 report.pass/warn/fail（不自行推算）', () => {
    const s = summarizeHealth({ ok: true, report: { pass: 9, warn: 1, fail: 2, items: [item('f1', 'fail')] } }, null, false);
    assert.deepEqual(s.counts, { pass: 9, warn: 1, fail: 2 });
    assert.equal(s.issues.length, 1);
  });

  it('计数任一缺失即 undefined（不编造）', () => {
    const s = summarizeHealth({ ok: true, report: { warn: 1, fail: 0, items: [item('w1', 'warn')] } }, null, false);
    assert.equal(s.counts, undefined);
  });

  it('旧 daemon（无 report）→ 有应答仍判 ok，但 hasReport=false、issues 空', () => {
    const s = summarizeHealth({ ok: true }, null, false);
    assert.equal(s.level, 'ok');
    assert.equal(s.hasReport, false);
    assert.equal(s.counts, undefined);
    assert.deepEqual(s.issues, []);
  });

  it('report 存在但 items 为空 → hasReport=false', () => {
    const s = summarizeHealth({ ok: true, report: { pass: 0, warn: 0, fail: 0, items: [] } }, null, false);
    assert.equal(s.hasReport, false);
  });

  it('detail 缺失时退化 message，两者皆缺则为空串（trim 后）', () => {
    const issues = toHealthIssues([
      { name: 'a', status: 'fail', message: '来自 message' },
      { name: 'b', status: 'warn', detail: '  带空白  ' },
      { name: 'c', status: 'warn' },
    ]);
    assert.deepEqual(issues.map((i) => i.detail), ['来自 message', '带空白', '']);
  });
});

describe('文案与复制载荷', () => {
  it('不可达给可行动人话，不出现浏览器黑话', () => {
    assert.match(humanizeHealthError('Failed to fetch'), /无法连接服务（服务未启动或网络异常）/);
    assert.match(humanizeHealthError('NetworkError when attempting to fetch resource.'), /无法连接服务/);
    assert.match(humanizeHealthError(undefined), /ki mcp --http --web/);
  });

  it('后端真实原因原样透出（不被前端覆盖）', () => {
    assert.equal(humanizeHealthError('健康检查超时（>22s）：探测未在预算内完成'), '健康检查超时（>22s）：探测未在预算内完成');
  });

  it('徽标文案不含「MCP HTTP」前缀（D2：与"服务存活"区分开）', () => {
    const all = [
      summarizeHealth(undefined, null, true),
      summarizeHealth(undefined, { message: 'Failed to fetch' }, false),
      summarizeHealth(undefined, { status: 500 }, false),
      summarizeHealth(body([item('a', 'pass')]), null, false),
      summarizeHealth(body([item('w', 'warn')]), null, false),
      summarizeHealth(body([item('f', 'fail')]), null, false),
    ];
    for (const s of all) assert.doesNotMatch(s.label, /MCP HTTP/);
  });

  it('复制载荷优先 detail，为空退化为项名', () => {
    assert.equal(healthIssueCopyText({ name: '批大小探测', status: 'warn', detail: 'batchSize=32 超过上限 25' }), 'batchSize=32 超过上限 25');
    assert.equal(healthIssueCopyText({ name: '旧 daemon 项', status: 'warn', detail: '' }), '旧 daemon 项');
  });
});
