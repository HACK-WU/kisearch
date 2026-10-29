/**
 * 对话配置的加载 / 草稿 / 保存（对话配置层 · 批次 1）
 *
 * ═══ 三个设计取舍 ═══
 * 1. **每次打开都重新拉**（不建全局缓存）：配置是"低频改动、但必须看到最新"的数据，
 *    缓存导致的过期风险 > 省下的那一次请求；也让"别人/CLI 改了配置"能立刻反映。
 * 2. **草稿由配置层自己持有**，因此「取消」天然等于回滚（丢弃草稿即可），
 *    不需要像 demo 那样做快照对比 —— 少一处状态就少一处不一致。
 * 3. **保存是整体替换**（与后端语义一致），成功后用响应里的 `config` 重置草稿基线，
 *    保证"已保存"状态与磁盘一致。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatApiError, getPromptConfig, savePromptConfig } from '@/api/chatApi';
import type { PromptConfig, PromptConfigOk } from '@/api/chatContract';

export interface FieldError {
  field: string;
  message: string;
}

export interface UsePromptConfigResult {
  loading: boolean;
  loadError: string | null;
  data: PromptConfigOk | null;
  saving: boolean;
  saveError: string | null;
  /** 字段级校验失败（`err.details`）：供 UI 高亮到具体输入项 */
  fieldErrors: FieldError[];
  /** 最近一次保存成功的时间戳（驱动"已保存"反馈；null = 本次打开还没存过） */
  savedAt: number | null;
  reload: () => void;
  /** @returns 是否保存成功 */
  save: (draft: PromptConfig) => Promise<boolean>;
}

export function usePromptConfig(active: boolean): UsePromptConfigResult {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<PromptConfigOk | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  /** 层关闭后到达的响应不应再写 state（避免卸载后 setState / 反应过期数据） */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSavedAt(null);
    void (async () => {
      try {
        const ok = await getPromptConfig();
        if (cancelled || !aliveRef.current) return;
        setData(ok);
      } catch (err) {
        if (cancelled || !aliveRef.current) return;
        setLoadError(err instanceof ChatApiError ? err.message : '配置读取失败');
      } finally {
        if (!cancelled && aliveRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, reloadTick]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  const save = useCallback(async (draft: PromptConfig): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    setFieldErrors([]);
    try {
      const res = await savePromptConfig(draft);
      if (!aliveRef.current) return true;
      // 用服务端回传（含服务端打的时间戳）重置基线：之后"是否已保存"以它为准
      setData((prev) => (prev ? { ...prev, config: res.config } : prev));
      setSavedAt(Date.now());
      return true;
    } catch (err) {
      if (!aliveRef.current) return false;
      if (err instanceof ChatApiError) {
        setSaveError(err.message);
        setFieldErrors(err.details ?? []);
      } else {
        setSaveError('保存失败');
      }
      return false;
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  }, []);

  return { loading, loadError, data, saving, saveError, fieldErrors, savedAt, reload, save };
}
