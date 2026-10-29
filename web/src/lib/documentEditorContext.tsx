import { createContext, useContext, type ReactNode } from 'react';
import type { SaveDocumentResponse } from '@/api/httpApi';

export interface DocumentEditorRequest {
  scope: string;
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
