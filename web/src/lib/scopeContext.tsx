/**
 * scopeContext.tsx —— 全局 scope 上下文（跨页面共享，localStorage 持久化）
 */

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'ki-web:scope';

interface ScopeContextValue {
  scope: string;
  setScope: (s: string) => void;
}

const ScopeContext = createContext<ScopeContextValue>({
  scope: 'default',
  setScope: () => {},
});

export function ScopeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [scope, setScopeState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? 'default';
    } catch {
      return 'default';
    }
  });

  const setScope = (s: string): void => {
    setScopeState(s);
    try {
      localStorage.setItem(STORAGE_KEY, s);
    } catch {
      /* 忽略 */
    }
  };

  return (
    <ScopeContext.Provider value={{ scope, setScope }}>
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope(): ScopeContextValue {
  return useContext(ScopeContext);
}

export function useScopeValue(): string {
  return useContext(ScopeContext).scope;
}
