import { createContext, useContext, type ReactNode } from 'react';
import type { SaveDocumentResponse } from '@/api/httpApi';

export interface DocumentEditorRequest {
  /** 导航值：顶栏 scope（视图模式下是**视图名**）。列表缓存失效 / 重挂载键都沿用它 */
  scope: string;
  /**
   * 文档真实所属的知识库（视图模式下与 `scope` 不同）。
   *
   * 编辑/保存是写路径，后端只认真实库名（视图名一律 `VIEW_NOT_WRITABLE`，
   * `doc/edit` 读通道则因读不到 `dataDir/<视图名>/` 报「文档不存在」）。
   * 单库模式下不填，读请求处回落到 `scope`。
   */
  member?: string;
  group: string;
  relation: string;
  readerSelection?: string;
  onSaved?: (content: string, result: SaveDocumentResponse) => void;
}

interface DocumentEditorContextValue {
  isOpen: boolean;
  open: (request: DocumentEditorRequest) => void;
}

const Context = createContext<DocumentEditorContextValue>({ isOpen: false, open: () => {} });

export function DocumentEditorProvider({ value, children }: { value: DocumentEditorContextValue; children: ReactNode }): JSX.Element {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDocumentEditor(): DocumentEditorContextValue {
  return useContext(Context);
}
