/**
 * analysis-write-tools.test.ts —— 分析域「写入」工具装配（REQ-20261123-004）
 *
 * 只验证装配形状与开关判定，**不执行写操作**（真写库由事件页 e2e 覆盖）。
 * 运行：npx jiti test/events/analysis-write-tools.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKbWriteToolEntries, isAnalysisToolEnabled } from '../../src/lib/events/analysis-runner.js';
import { defaultAnalysisConfig } from '../../src/lib/chat/prompt-config.js';

const EXPECTED = ['ki_store', 'ki_sync_relation', 'ki_bulk_sync_relation', 'ki_group_create'];

describe('分析域写入工具装配（REQ-20261123-004）', () => {
  it('装配 4 个写入工具，且不含刻意排除的删除 / 批量文件 / 局部编辑工具', () => {
    const entries = buildKbWriteToolEntries('demo');
    assert.equal(entries.length, EXPECTED.length);
    assert.deepEqual(entries.map((e) => e.name), EXPECTED);
    for (const e of entries) {
      // def 名与 entry 名不一致 ⇒ 模型按 def 调用时 entryMap 查不到，表现为「工具未启用」
      assert.equal(e.def.function.name, e.name, 'def 名与 entry 名必须一致');
    }
    const names = entries.map((e) => e.name);
    for (const excluded of ['ki_delete_relation', 'ki_group_delete_empty', 'ki_bulk_store', 'ki_edit_relation']) {
      assert.equal(names.includes(excluded), false, `${excluded} 不得进入分析工具面`);
    }
  });

  it('describe 对合法参数给中文标签，对非法参数不抛（过程区不能因入参残缺而炸）', () => {
    const entries = buildKbWriteToolEntries('demo');
    const sync = entries.find((e) => e.name === 'ki_sync_relation');
    assert.ok(sync, '应装配 ki_sync_relation');

    const ok = sync!.describe({ group: '工具库', relation: 'Redis', module_info: 'x' });
    assert.equal(ok.label, '写入文档');
    assert.ok(ok.summary.includes('group=工具库'), `摘要应含入参，实际：${ok.summary}`);

    // 缺必填 relation ⇒ 对话侧 parse 抛错 ⇒ describe 必须吞掉并保留标签、摘要留空
    const bad = sync!.describe({ group: '工具库' });
    assert.equal(bad.label, '写入文档');
    assert.equal(bad.summary, '');
  });

  it('开关判定：写入组缺键=关、只读组缺键=开（缺键语义的唯一防线）', () => {
    const cfg = defaultAnalysisConfig();
    cfg.tools = { ki_search: true }; // 模拟只写了一部分键的旧配置
    assert.equal(isAnalysisToolEnabled(cfg, 'ki_search'), true);
    assert.equal(isAnalysisToolEnabled(cfg, 'fs_read'), true, '只读组缺键应按默认开');
    for (const name of EXPECTED) {
      assert.equal(isAnalysisToolEnabled(cfg, name), false, `${name} 缺键必须为关`);
    }
    cfg.tools.ki_sync_relation = true;
    assert.equal(isAnalysisToolEnabled(cfg, 'ki_sync_relation'), true, '显式开启应生效');
  });

  it('写入落点由 scope 注入决定（不做 Group 级白名单，2026-11-23 拍板）', () => {
    // 只验证装配契约：落点约束不在工具侧实现，模型无法通过参数指定其他库
    const entries = buildKbWriteToolEntries('demo');
    assert.equal(entries.length, EXPECTED.length, '工具装配数量不受落点配置影响');
    const sync = entries.find((e) => e.name === 'ki_sync_relation');
    const props = Object.keys((sync!.def.function.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    assert.equal(props.includes('scope'), false, '入参不得含 scope（由 daemon 注入，模型无法跨库写）');
  });
});
