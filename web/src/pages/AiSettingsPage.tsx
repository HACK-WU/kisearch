/**
 * AI 设置页（2026-11-15）
 *
 * 解决的是**可发现性**：「AI 配置」此前只能从对话面板头部的「配置」按钮进入，
 * 在事件页想调「AI 分析」的提示词，必须"打开 AI 对话 → 点配置 → 再关掉面板"。
 *
 * 三条能力共用同一份配置与同一套落盘队列（`PromptConfigLayer`），本页只负责：
 *   · 左栏能力导航（对话 / 分析 / 查找）
 *   · 页面级说明（全局一份、生效范围）与只读横幅
 *   · 返回来源页（`?from=` 白名单校验，缺省回事件页）
 *
 * ⚠️ 「AI 分析 / AI 查找」当前**没有消费方**：前者是事件页的方案说明弹窗，
 *    后者是确定性检索（不调 LLM）。因此这两组在 UI 上强制标注「未接入」，
 *    不允许显示成"已生效"（检查点 F1/F2）。
 */

import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { PromptConfigLayer, type CapabilitySection } from '@/chat/PromptConfigLayer';
import { Icon } from '@/components/icons';
import { resolveAiSettingsBack } from '@/lib/aiSettingsUrl';
import { useAuth } from '@/lib/authContext';
import { emitChatConfigSaved } from '@/lib/chatConfigEvents';
import '@/styles/ai-settings.css';

/** 能力分组（顺序 = 用户从"最常用"到"尚未接入"） */
const CAPABILITIES: ReadonlyArray<{ key: CapabilitySection; label: string; state: string; icon: string }> = [
  { key: 'chat', label: 'AI 对话', state: '提示词 · Skill · 工具', icon: 'chat' },
  { key: 'analysis', label: 'AI 分析', state: '目录 · 提示词 · Skill · 工具', icon: 'spark' },
  { key: 'find', label: 'AI 查找', state: '确定性检索 · 未接入', icon: 'search' },
];

/**
 * 返回目标与顶栏 toggle 共用 `lib/aiSettingsUrl`（同一份白名单校验）。
 * 不用 `navigate(-1)`：直接访问 / 刷新本页时历史里没有上一跳，会退出到站外。
 */

export function AiSettingsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can, status } = useAuth();

  const rawCap = params.get('cap');
  const section: CapabilitySection = CAPABILITIES.some((c) => c.key === rawCap)
    ? (rawCap as CapabilitySection)
    : 'chat';

  const backTo = resolveAiSettingsBack(params.get('from'));

  /**
   * 只读门禁（页面级）拆成两件事，避免"横幅撒谎"：
   *   · `isViewer`：**鉴权已就绪**且无写权限 → 显示"当前账号为只读"横幅；
   *   · `controlsLocked`：鉴权未就绪时**也先锁住控件** —— 否则用户在权限未知时点开关，
   *     会发出一个必然 403 的写入请求，界面显示"保存失败"而不是"没权限"。
   *   后台 PUT 仍按能力 403 兜底，前端锁只是体验层。
   */
  const canWrite = can('ops.write');
  const isViewer = status !== 'loading' && !canWrite;
  const controlsLocked = isViewer || status === 'loading';

  /** 切分组：只改 URL（可深链、可刷新恢复），不重挂载整页 */
  const selectSection = useCallback((next: CapabilitySection): void => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('cap', next);
      return p;
    }, { replace: true });
  }, [setParams]);

  const goBack = useCallback((): void => { navigate(backTo); }, [navigate, backTo]);

  return (
    <div className="ai-set">
      <p className="ai-set__note">
        <b>全局一份配置</b>，不随顶部 scope 变化；改动即时落盘。
        提示词与 Skill 对之后新建的会话 / 调用生效，工具开关下一次提问即生效。
      </p>

      {isViewer && (
        <p className="ai-set__ro" role="status">
          当前账号为只读：可以查看全部 AI 配置，修改全局 AI 配置需要管理员写权限（<code>ops.write</code>）。
        </p>
      )}

      <div className="ai-set__body">
        <nav className="ai-set__nav" aria-label="AI 能力">
          {CAPABILITIES.map((c) => (
            <button
              key={c.key}
              type="button"
              className="ai-set__cap"
              aria-current={section === c.key ? 'true' : undefined}
              onClick={() => selectSection(c.key)}
            >
              {/*
                ⚠️ 必须保留 `ki-icon`：本仓的图标全是 24×24 **纯路径**，没有内联 fill/stroke，
                描边与"空心"完全由 `.ki-icon` 提供（stroke:currentColor / fill:none）。
                只写自定义类名 ⇒ 回退 SVG 默认黑色填充（对话气泡变实心、放大镜圆变成黑点）。
              */}
              <Icon name={c.icon} className="ki-icon ai-set__cap-ic" />
              <span className="ai-set__cap-body">
                <span className="ai-set__cap-name">{c.label}</span>
                <span className="ai-set__cap-state">{c.state}</span>
              </span>
            </button>
          ))}
        </nav>

        {/* 宿主只提供定位上下文（`position: relative`）：配置层在面板里是 `absolute; inset:0`
            的覆盖层，页面样式表把它还原成文档流并按分组出卡，见 ai-settings.css 的同名注释。 */}
        <div className="ai-set__panel">
          {/*
            不加 `key={section}`：配置层持有的是**整份**配置草稿，切分组只改变"渲染哪几块"，
            不需要重建实例。加 key 会在每次切分组时重新 GET 配置、闪一下「读取配置…」，
            并且把"保存中"状态一并清空（用户会以为刚才那次没保存）。
          */}
          <PromptConfigLayer
            capability={section}
            hideHeader
            readOnly={controlsLocked}
            onClose={goBack}
            // 通知常驻的对话面板重拉配置：否则改完「上下文窗口」后，面板占比分母仍是旧值
            onSaved={emitChatConfigSaved}
          />
        </div>
      </div>
    </div>
  );
}
