/**
 * AI 分析 · 写入组危险开关（REQ-20261123-004）源码契约断言。
 *
 * 钉住四件事，防止后续「顺手」改回危险默认：
 *  1. 危险组用独立样式（红点 / 橙色开关）且文案标「危险 · 默认关」；
 *  2. 开启前必须二次确认，文案写明「后台运行 + 全局生效」；
 *  3. **缺键按所属组默认**（危险组关、只读组开），不得退回「缺键即开」；
 *  4. 文案不再声称「全部为只读工具且默认全开」。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const layer = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');

describe('AI 分析 · 写入组危险开关（REQ-20261123-004）', () => {
  it('危险组有独立样式与「危险 · 默认关」文案', () => {
    assert.match(layer, /ki-chat-cfg__group--danger/, '危险分组需独立样式类（红点）');
    assert.match(layer, /ki-chat-cfg__sw--danger/, '危险开关需独立样式类（橙色）');
    assert.match(layer, /危险 · 默认关/, '分组计数后必须标「危险 · 默认关」');
  });

  it('开启危险工具前必须二次确认，文案写明后台运行与全局生效', () => {
    assert.match(layer, /title: '开启危险工具'/, '点开危险开关应弹确认');
    assert.match(layer, /分析在后台运行/, '必须说明执行时没有逐次确认');
    assert.match(layer, /全局生效，对所有库的所有分析/, '必须说明影响范围是全局');
    assert.match(layer, /不提供回滚/, '必须说明写入不可回滚');
  });

  it('缺键按所属组默认（危险组关、只读组开），不得退回「缺键即开」', () => {
    assert.match(
      layer,
      /analysisCfg\.tools\[n\] \?\? g\.danger !== true/,
      '缺键必须按组 danger 判定，不能一律视作开启',
    );
    assert.match(
      layer,
      /const analysisToolOn = \(name: string\): boolean => \(/,
      'skill↔工具依赖判断应复用同一套缺键语义',
    );
  });

  it('文案不再声称「全部为只读工具且默认全开」', () => {
    assert.doesNotMatch(layer, /全部为只读工具且默认全开/);
  });
});
