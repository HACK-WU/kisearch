/**
 * 导入阶段 → UI 呈现 映射单测（2026-10-19 回归锁）
 *
 * 锁住四条曾被真实用户踩到的语义（线上报障 + code review P1）：
 *   1) **等待确认 ≠ 上传中**：`awaiting-confirm` 属"忙"（不许再发新任务），但徽标是「等待确认」、
 *      色调是 partial（不是 running 的转圈观感）；
 *   2) **取消 ≠ 失败**：本地取消（`cancelled`）与服务端确认取消（`failed` + `failureStage='cancelled'`）
 *      都必须给「已取消」+ 灰态，出现红色「导入失败」即为回归；
 *   3) **等待确认的进度条沿用上传百分比**：落到 `importPercent`（`job` 尚不存在 → null）会变无限滚动条；
 *   4) **错误标题优先级**：scan → upload → cancelled → unknown → import → 输入有误（不要改动顺序）。
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
const {
  isBusyPhase,
  isCancelledTrack,
  trackLabelOf,
  trackToneOf,
  activePercentOf,
  errorStatusOf,
} = await vite.ssrLoadModule('/src/lib/importPhase.ts');
after(async () => vite.close());

describe('isBusyPhase：只有"任务未结束"才算忙', () => {
  it('scanning / uploading / awaiting-confirm / importing 属忙', () => {
    for (const phase of ['scanning', 'uploading', 'awaiting-confirm', 'importing']) {
      assert.equal(isBusyPhase(phase), true, `${phase} 应为忙`);
    }
  });

  it('idle / done / failed / cancelled / unknown 不忙（取消后必须能重新开始）', () => {
    for (const phase of ['idle', 'done', 'failed', 'cancelled', 'unknown']) {
      assert.equal(isBusyPhase(phase), false, `${phase} 不应为忙`);
    }
  });
});

describe('isCancelledTrack：取消不是失败', () => {
  it('本地取消（phase=cancelled）成立', () => {
    assert.equal(isCancelledTrack('cancelled'), true);
  });

  it('服务端取消（failed + failureStage=cancelled）成立', () => {
    assert.equal(isCancelledTrack('failed', 'cancelled'), true);
  });

  it('真正的失败不成立', () => {
    assert.equal(isCancelledTrack('failed', 'import'), false);
    assert.equal(isCancelledTrack('failed', 'upload'), false);
    assert.equal(isCancelledTrack('failed', null), false);
  });

  it('其它阶段不成立', () => {
    for (const phase of ['idle', 'scanning', 'uploading', 'awaiting-confirm', 'importing', 'done', 'unknown']) {
      assert.equal(isCancelledTrack(phase), false, `${phase} 不应判为取消`);
    }
  });
});

describe('trackLabelOf：徽标文案', () => {
  it('九个阶段各有明确文案（等待确认不得是「上传中」）', () => {
    assert.equal(trackLabelOf('idle'), '等待开始');
    assert.equal(trackLabelOf('scanning'), '读取目录中');
    assert.equal(trackLabelOf('uploading'), '上传中');
    assert.equal(trackLabelOf('awaiting-confirm'), '等待确认');
    assert.equal(trackLabelOf('importing'), '导入中');
    assert.equal(trackLabelOf('done'), '导入完成');
    assert.equal(trackLabelOf('cancelled'), '已取消');
    assert.equal(trackLabelOf('unknown'), '待确认');
    assert.equal(trackLabelOf('failed'), '导入失败');
  });

  it('failed + cancelled 说「已取消」而不是「导入失败」', () => {
    assert.equal(trackLabelOf('failed', 'cancelled'), '已取消');
  });

  it('failed + import 仍是「导入失败」', () => {
    assert.equal(trackLabelOf('failed', 'import'), '导入失败');
  });
});

describe('trackToneOf：徽标色调', () => {
  it('等待确认用 partial（不是 running，避免"还在跑"的错觉）', () => {
    assert.equal(trackToneOf('awaiting-confirm'), 'partial');
  });

  it('取消一律用 cancelled 灰态', () => {
    assert.equal(trackToneOf('cancelled'), 'cancelled');
    assert.equal(trackToneOf('failed', 'cancelled'), 'cancelled');
  });

  it('真正失败用 failed 红态', () => {
    assert.equal(trackToneOf('failed'), 'failed');
    assert.equal(trackToneOf('failed', 'import'), 'failed');
  });

  it('进行中用 running、完成用 succeeded、待确认用 unknown、未开始用 cancelled', () => {
    assert.equal(trackToneOf('uploading'), 'running');
    assert.equal(trackToneOf('importing'), 'running');
    assert.equal(trackToneOf('scanning'), 'partial');
    assert.equal(trackToneOf('done'), 'succeeded');
    assert.equal(trackToneOf('unknown'), 'unknown');
    assert.equal(trackToneOf('idle'), 'cancelled');
  });
});

describe('activePercentOf：进度条百分比', () => {
  it('等待确认沿用上传百分比（不能落到 null 变无限滚动条）', () => {
    assert.equal(activePercentOf('awaiting-confirm', 100, null), 100);
    assert.equal(activePercentOf('uploading', 42, null), 42);
  });

  it('导入中取导入百分比', () => {
    assert.equal(activePercentOf('importing', 100, 30), 30);
  });

  it('其余阶段取导入百分比（通常为 null）', () => {
    assert.equal(activePercentOf('cancelled', 100, null), null);
    assert.equal(activePercentOf('idle', null, null), null);
  });
});

describe('errorStatusOf：阻塞/失败标题', () => {
  it('按 scan → upload → cancelled → unknown → import 优先级给标题', () => {
    assert.equal(errorStatusOf('scan'), '读取失败');
    assert.equal(errorStatusOf('upload'), '上传失败');
    assert.equal(errorStatusOf('cancelled'), '导入已取消');
    assert.equal(errorStatusOf('unknown'), '任务状态待确认');
    assert.equal(errorStatusOf('import'), '导入失败');
  });

  it('无失败细分（表单校验类）落到「输入有误」', () => {
    assert.equal(errorStatusOf(null), '输入有误');
  });
});
