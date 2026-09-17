/**
 * SearchPage.tsx —— 语义搜索（ki-search-form + ki-qr-item 结果）
 *
 * 调 ki_search（include_original: true, tag: ki-search）→ 原文内容 + Group 路径。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useScopeValue } from '@/lib/scopeContext';
import { kiGetModuleInfo, kiSearch } from '@/api/mcpClient';
import { fetchTags, getSearchConfig } from '@/api/httpApi';
import { useDocList } from '@/lib/hooks';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { resolveDocumentLink, type DocumentView } from '@/lib/documentLinks';

/** Threshold 滑块上限：实际检索分数量级 ~0.0x，max=1 无意义 */
const THRESHOLD_MAX = 0.2;
/** Threshold 步进（滑块与 −/+ 按钮共用） */
const THRESHOLD_STEP = 0.005;
const QUERY_TIMEOUT_MIN_SECONDS = 0.001;
const QUERY_TIMEOUT_MAX_SECONDS = 60;

/** 步进调整 threshold：clamp 到 [0, MAX]，toFixed 防浮点漂移 */
const stepThreshold = (cur: number, dir: 1 | -1): number => {
  const next = Math.round((cur + dir * THRESHOLD_STEP) * 1000) / 1000;
  return Math.min(THRESHOLD_MAX, Math.max(0, next));
};

interface Result {
  group?: string;
  relation?: string;
  score?: number;
  original?: string;
  /** 向量文档内容 */
  content?: string;
  /** 命中向量对应的标签（多 tag 文档去重后仅其一） */
  tag?: string;
  /** 文档级自定义标签全量（后端反查 relations-cache relation.tags） */
  tags?: string[];
  /** 向量数据标识（doc id） */
  memoryId?: string;
}

export function SearchPage(): JSX.Element {
  const scope = useScopeValue();
  const [query, setQuery] = useState('');
  const [threshold, setThreshold] = useState(0);
  /** undefined 表示默认配置尚未读取；此时不传 timeout，避免硬编码值覆盖服务端配置。 */
  const [queryTimeout, setQueryTimeout] = useState<string | undefined>();
  const [queryTimeoutStatus, setQueryTimeoutStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const queryTimeoutTouched = useRef(false);
  const [limit, setLimit] = useState('10');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<DocumentView | null>(null);
  const [history, setHistory] = useState<DocumentView[]>([]);
  const [forwardHistory, setForwardHistory] = useState<DocumentView[]>([]);
  /** O1：本次查询降级为关键词检索时的原因；null 表示语义检索正常（分数为混合 RRF 口径） */
  const [degradeReason, setDegradeReason] = useState<string | null>(null);
  /** 本次被跳过的 scope（strict 未注册 / 无向量 Collection）：不展示即静默漏召回 */
  const [skippedScopes, setSkippedScopes] = useState<{ scope: string; reason: string }[]>([]);
  /** 供「清空」后把焦点交还输入框，用户可直接打下一次查询 */
  const inputRef = useRef<HTMLInputElement>(null);

  // Tag 过滤
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const { data: docData } = useDocList(scope);

  /** 手动打开搜索结果是新的导航起点。 */
  const openDocument = useCallback((doc: DocumentView): void => {
    setHistory([]);
    setForwardHistory([]);
    setViewing(doc);
  }, []);

  const closeDocument = useCallback((): void => {
    setHistory([]);
    setForwardHistory([]);
    setViewing(null);
  }, []);

  /** 返回搜索结果抽屉中的上一级本地文档。 */
  const goBack = useCallback((): void => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    if (viewing) setForwardHistory((prev) => [...prev, viewing]);
    setViewing(previous);
  }, [history, viewing]);

  /** 前进到搜索结果抽屉中最近一次返回前的文档。 */
  const goForward = useCallback((): void => {
    const next = forwardHistory[forwardHistory.length - 1];
    if (!next) return;
    setForwardHistory((prev) => prev.slice(0, -1));
    if (viewing) setHistory((prev) => [...prev, viewing]);
    setViewing(next);
  }, [forwardHistory, viewing]);

  /** 搜索结果抽屉也支持复用 Browse 页的本地文档链接解析。 */
  const handleLocalLink = useCallback((href: string): boolean => {
    const target = resolveDocumentLink(href, viewing?.path, viewing?.group, docData?.docs ?? []);
    if (!target) return false;
    if (viewing) setHistory((prev) => [...prev, viewing]);
    setForwardHistory([]);
    setViewing({ module: target.name, group: target.group, path: target.path });
    return true;
  }, [docData?.docs, viewing]);

  useEffect(() => {
    let cancelled = false;
    fetchTags(scope).then((res) => {
      if (!cancelled && res.ok) setAvailableTags(res.tags.map((t) => t.tag));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    getSearchConfig().then((res) => {
      if (cancelled || queryTimeoutTouched.current) return;
      if (res.ok && Number.isFinite(res.timeout) && res.timeout > 0) {
        setQueryTimeout(String(res.timeout));
        setQueryTimeoutStatus('ready');
      } else {
        setQueryTimeoutStatus('error');
      }
    }).catch(() => {
      if (!cancelled && !queryTimeoutTouched.current) setQueryTimeoutStatus('error');
    });
    return () => { cancelled = true; };
  }, []);

  const run = async (): Promise<void> => {
    if (!query.trim()) return;
    // 未手动调整时不发送覆盖值，让服务端每次使用最新配置；手动调整后才发送请求级 timeout。
    const timeout = queryTimeoutTouched.current && queryTimeout !== undefined
      ? Number(queryTimeout)
      : undefined;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < QUERY_TIMEOUT_MIN_SECONDS || timeout > QUERY_TIMEOUT_MAX_SECONDS)) {
      setError(`Timeout 必须是 ${QUERY_TIMEOUT_MIN_SECONDS}-${QUERY_TIMEOUT_MAX_SECONDS} 秒之间的数字`);
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    setDegradeReason(null);
    setSkippedScopes([]);
    try {
      // Tag 过滤语义：选中具体 tag 时精确过滤（不含 ki-search），"全部"才用默认 ki-search
      const searchTags = selectedTags.length > 0
        ? selectedTags          // 仅用户选中的 tag（精确过滤）
        : ['ki-search'];        // 默认全部（ki-search）
      const res = await kiSearch(query.trim(), {
        scope,
        tags: searchTags,
        threshold: threshold || undefined,
        limit: Number(limit) || 10,
        ...(timeout !== undefined ? { timeout } : {}),
      });
      // 后端业务层错误（如向量库锁定）
      if ((res as Record<string, unknown>).ok === false) {
        const errMsg = (res as Record<string, unknown>).error as string | undefined;
        setError(errMsg ?? '搜索服务暂不可用');
        return;
      }
      const hits = (res.results ?? []) as Result[];
      setResults(hits);
      setTotal(hits.length);
      // O1：降级时后端返回 BM25 原始分（量级可达几十），与混合 RRF 分（~0.01–0.03）
      // 不可比，必须显式提示，否则用户只会看到分数"无故暴涨"。
      setDegradeReason(
        res.degraded === true ? (res.degradedReason ?? '查询向量计算失败') : null,
      );
      setSkippedScopes(Array.isArray(res.skipped) ? res.skipped : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /** 只清空搜索输入，保留当前结果列表，方便用户继续查看或复制结果。 */
  const clearAll = (): void => {
    setQuery('');
    inputRef.current?.focus();
  };

  const toggleTag = (tag: string): void => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  };

  return (
    <>
      <div className="ki-page-head">
        <div>
          <h1>语义搜索</h1>
          <p>向量 + BM25 混合检索 · 原文内容 + Group 路径</p>
        </div>
      </div>

      {/* 搜索表单 */}
      <form
        className="ki-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="ki-search-bar">
          <input
            ref={inputRef}
            className="ki-search-input"
            placeholder="输入自然语言查询，如：告警收敛策略是什么？"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            data-ki-search-input
            aria-label="语义搜索"
          />
          {/* type="button" 必须显式：位于 form 内，缺省为 submit 会误触发搜索。
              loading 时禁用：在途 run() 完成后仍会 setResults，否则清空会被异步结果覆盖回填。 */}
          <button
            type="button"
            className="ki-btn ki-btn--secondary"
            style={{ height: 42, padding: '0 18px' }}
            disabled={loading || (!query && results === null)}
            onClick={clearAll}
          >
            清空
          </button>
          <button className="ki-btn ki-btn--primary" style={{ height: 42, padding: '0 24px' }} disabled={loading || !query.trim()}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </div>
        <div className="ki-query-options">
          <div className="ki-query-option" style={{ flex: '1 0 100%' }}>
            <span className="ki-form-label" style={{ marginRight: 8 }}>Tags</span>
            <div className="ki-tag-select">
              <span
                className={`ki-tag-chip${selectedTags.length === 0 ? ' ki-tag-chip--active' : ''}`}
                onClick={() => setSelectedTags([])}
              >
                全部
              </span>
              {availableTags.map((t) => (
                <span
                  key={t}
                  className={`ki-tag-chip${selectedTags.includes(t) ? ' ki-tag-chip--active' : ''}`}
                  onClick={() => toggleTag(t)}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="ki-query-option">
            <span className="ki-form-label">Threshold</span>
            <input
              type="range"
              className="ki-range"
              min={0}
              max={THRESHOLD_MAX}
              step={THRESHOLD_STEP}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <button
              type="button"
              className="ki-step-btn"
              aria-label="降低阈值"
              disabled={threshold <= 0}
              onClick={() => setThreshold((v) => stepThreshold(v, -1))}
            >−</button>
            <span className="ki-threshold-val">{threshold.toFixed(3)}</span>
            <button
              type="button"
              className="ki-step-btn"
              aria-label="提高阈值"
              disabled={threshold >= THRESHOLD_MAX}
              onClick={() => setThreshold((v) => stepThreshold(v, 1))}
            >+</button>
          </div>
          <div className="ki-query-option">
            <span className="ki-form-label">Timeout</span>
            <input
              className="ki-form-input"
              type="number"
              min={QUERY_TIMEOUT_MIN_SECONDS}
              max={QUERY_TIMEOUT_MAX_SECONDS}
              step="any"
              value={queryTimeout ?? ''}
              placeholder={queryTimeoutStatus === 'loading' ? '读取中' : queryTimeoutStatus === 'error' ? '服务端默认' : '3'}
              onChange={(e) => {
                queryTimeoutTouched.current = true;
                setQueryTimeoutStatus('ready');
                setQueryTimeout(e.target.value);
              }}
              aria-label="查询 embedding 超时时间（秒）"
              title={queryTimeoutStatus === 'error' ? '默认配置读取失败；留空时将由服务端配置决定' : undefined}
              style={{ width: 76 }}
            />
            <span className="ki-form-suffix">s</span>
          </div>
          <div className="ki-query-option">
            <span className="ki-form-label">Limit</span>
            <select className="ki-form-select" style={{ width: 'auto', minWidth: 72 }} value={limit} onChange={(e) => setLimit(e.target.value)}>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </select>
          </div>
        </div>
      </form>

      {/* 空状态引导 */}
      {!loading && results === null && (
        <div className="ki-empty" style={{ padding: 56 }}>
          <div>
            <div style={{ fontSize: 32, marginBottom: 8 }}>⌕</div>
            <h3>输入查询开始搜索</h3>
            <p>混合检索当前 scope 的知识库内容，命中结果可定位原文。</p>
          </div>
        </div>
      )}

      {error && (
        <div className="ki-empty" style={{ padding: 40 }}>
          <div>
            <h3>搜索失败</h3>
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* 结果 */}
      {results !== null && (
        <section>
          {/* 结果完整性提示：降级（分数口径变化）+ 跳过 scope（漏召回）。
              两者后端都已返回，不展示即静默降级 / 静默漏召回。 */}
          {(degradeReason !== null || skippedScopes.length > 0) && (
            <div className="ki-banner" role="status" style={{ marginBottom: 12 }}>
              <div
                className="ki-banner__msg"
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}
              >
                {degradeReason !== null && (
                  <>
                    <span>{degradeReason}</span>
                    <span className="ki-cell-sub">
                      本次分数为 BM25 关键词分（量级可达几十），与混合检索的 RRF 融合分（约 0.01–0.03）不可比，Threshold 对本次结果不生效。
                    </span>
                  </>
                )}
                {skippedScopes.length > 0 && (
                  <>
                    <span>已跳过 {skippedScopes.length} 个 scope，结果可能不完整</span>
                    <span className="ki-cell-sub">
                      {skippedScopes.map((s) => `${s.scope}：${s.reason}`).join('；')}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="ki-results">
            <div className="ki-results__head">
              <span className="ki-results__title">搜索结果</span>
              <span className="ki-results__meta">
                {total} 条结果{loading ? ' · 搜索中…' : ''}
              </span>
            </div>
            {results.length === 0 && !loading ? (
              <div className="ki-empty" style={{ border: 'none', padding: 40 }}>
                <div>
                  <h3>未找到相关内容</h3>
                  <p>
                    {degradeReason !== null
                      // 降级时后端已跳过 threshold（BM25 尺度与混合 RRF 不可比），
                      // 再建议"降低 threshold"既与上方提示条矛盾、调了也没用
                      ? '建议：调整关键词 / 切换 tag 过滤 / 稍后重试（本次为关键词降级检索，Threshold 不生效）。'
                      : skippedScopes.length > 0
                        // 跳过 scope 时漏召回才是主因，threshold 不是当前症结
                        ? '建议：调整关键词 / 切换 tag 过滤 / 检查上方被跳过的 scope。'
                        : '建议：调整关键词 / 降低 threshold / 切换 tag 过滤。'}
                  </p>
                </div>
              </div>
            ) : (
              results.map((r, i) => (
                <div
                  key={i}
                  className="ki-qr-item"
                  onClick={() => {
                    const doc = docData?.docs.find((item) => item.group === r.group && item.name === r.relation);
                    openDocument({
                      module: r.relation ?? r.group ?? 'doc',
                      content: r.original,
                      group: r.group,
                      path: doc?.path,
                    });
                  }}
                >
                  <div className={`ki-qr-rank${i < 3 ? ' ki-qr-rank--top' : ''}`}>{i + 1}</div>
                  <div className="ki-qr-body">
                    {/* 文档名称 + Group 路径 */}
                    <div className="ki-qr-title">
                      <span className="ki-qr-name">{r.relation ?? '(未知文档)'}</span>
                      <span className="ki-badge ki-badge--kb">{r.group ?? '(无 Group)'}</span>
                    </div>
                    {/* 原文 / 向量内容 */}
                    <div className="ki-qr-content">{r.original ?? r.content ?? r.relation ?? '(无内容)'}</div>
                    {/* meta：标签 + 向量数据 */}
                    <div className="ki-qr-meta">
                      <span className="ki-badge ki-badge--vec">RAG</span>
                      {(() => {
                        // 优先展示全量自定义 tags；旧后端无 tags 字段时回退单条 hit.tag
                        const tags = r.tags?.length ? r.tags : (r.tag ? [r.tag] : []);
                        return tags.map((t) => (
                          <span key={t} className="ki-badge ki-badge--tag">#{t}</span>
                        ));
                      })()}
                      <span className="ki-cell-sub ki-memoryid" title={r.memoryId ?? ''}>
                        {r.memoryId ? `vector: ${r.memoryId.slice(0, 12)}…` : 'vector: -'}
                      </span>
                      <span className="ki-cell-sub">点击查看原文</span>
                    </div>
                  </div>
                  <div className="ki-qr-score">
                    {(r.score ?? 0).toFixed(3)}
                    {/* 降级时 score 是 BM25 原值（可达几十），不 clamp 会算出 7000%+ 宽度撑出卡片 */}
                    <div className="ki-score-bar-bg">
                      <div
                        className="ki-score-bar"
                        style={{ width: `${Math.min(100, Math.max(0, Math.round((r.score ?? 0) * 100)))}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {viewing && (
        <ModuleDrawer
          key={`${scope}:${viewing.group ?? ''}:${viewing.module}`}
          scope={scope}
          module={viewing.module}
          group={viewing.group}
          initialContent={viewing.content}
          onClose={closeDocument}
          fetcher={kiGetModuleInfo}
          onLocalLink={handleLocalLink}
          canGoBack={history.length > 0}
          onBack={goBack}
          canGoForward={forwardHistory.length > 0}
          onForward={goForward}
        />
      )}
    </>
  );
}
