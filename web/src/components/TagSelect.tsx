/**
 * TagSelect.tsx —— tag 筛选下拉（combobox + 平铺选项）
 *
 * 与顶栏 Scope 选择器一致的交互：收起时显示当前筛选（未筛选显示「全部 tag」），
 * 展开时输入框转为关键字过滤；只能从已有 tag 中选择，输入内容不会写入筛选值。
 */

import { useEffect, useRef, useState } from 'react';
import { useDocList } from '@/lib/hooks';

interface TagSelectProps {
  scope: string;
  value: string;
  onChange: (v: string) => void;
  /** 输入框宽度（筛选行布局约束；flex 布局下可被拉伸覆盖） */
  width?: number;
}

export function TagSelect({ scope, value, onChange, width = 140 }: TagSelectProps): JSX.Element {
  const { data } = useDocList(scope);
  const tags = data?.tags ?? [];
  const disabled = tags.length === 0;
  const [open, setOpen] = useState(false);
  /** 展开时的搜索词：关闭后清空，输入框回到当前筛选值 */
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // 当前值不在列表中（如切换 scope 后该 tag 已不存在）时仍保留显示，避免筛选态静默丢失
  const options = value && !tags.includes(value) ? [value, ...tags] : tags;
  const keyword = filter.trim().toLowerCase();
  const filtered = keyword ? options.filter((t) => t.toLowerCase().includes(keyword)) : options;

  // 点击外部关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const openPicker = (): void => {
    if (disabled) return;
    setFilter('');
    setOpen(true);
  };
  const closePicker = (): void => {
    setFilter('');
    setOpen(false);
  };
  const pick = (tag: string): void => {
    onChange(tag);
    closePicker();
  };

  /** 回车：唯一匹配即选中（输入内容不会写入筛选值），否则仅收起 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      closePicker();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (filtered.length === 1) pick(filtered[0]);
    else closePicker();
  };

  return (
    <div className="ki-combobox" ref={rootRef} style={{ width }}>
      <div className="ki-combobox__input-wrap">
        <input
          className="ki-form-input"
          placeholder={disabled ? '暂无 tag' : open ? '搜索 tag…' : '全部 tag'}
          value={open ? filter : value}
          disabled={disabled}
          onChange={(e) => {
            // Esc 收起后焦点可能仍在输入框：首字符输入应重新展开并作为搜索词
            if (!open) setOpen(true);
            setFilter(e.target.value);
          }}
          onFocus={() => { if (!open) openPicker(); }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          title={disabled ? '当前知识库暂无自定义 tag' : '按 tag 过滤文档（可输入关键字搜索）'}
        />
        <button
          type="button"
          className={`ki-combobox__toggle${open ? ' ki-combobox__toggle--open' : ''}`}
          tabIndex={-1}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (open) closePicker();
            else openPicker();
          }}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      <div className={`ki-combobox__panel${open ? ' ki-combobox__panel--open' : ''}`}>
        <div className="ki-combobox__options">
          {/* 搜索时隐藏「全部 tag」，避免与匹配结果混淆；清空搜索即可回到该入口 */}
          {!keyword && (
            <button
              type="button"
              className={`ki-combobox__option${value ? '' : ' ki-combobox__option--active'}`}
              onClick={() => pick('')}
            >
              <span className="ki-combobox__option-label">全部 tag</span>
              {!value && <span className="ki-combobox__option-check">✓</span>}
            </button>
          )}
          {filtered.map((t) => (
            <button
              key={t}
              type="button"
              className={`ki-combobox__option${t === value ? ' ki-combobox__option--active' : ''}`}
              onClick={() => pick(t)}
            >
              <span className="ki-combobox__option-label">{t}</span>
              {t === value && <span className="ki-combobox__option-check">✓</span>}
            </button>
          ))}
          {keyword && filtered.length === 0 && (
            <div className="ki-combobox__empty">没有匹配的 tag</div>
          )}
        </div>
      </div>
    </div>
  );
}
