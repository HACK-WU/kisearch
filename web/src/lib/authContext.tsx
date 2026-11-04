/**
 * authContext.tsx —— 前端身份上下文（REQ-20261103-001 · S-04）
 *
 * - 启动时 GET /api/auth/me；401 事件统一转为匿名（由 RequireAuth 跳登录）；
 * - 页面只判 `can(capability)`，不判 role；
 * - local-admin 也走同一上下文（source='local'）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getMe,
  logout as logoutRequest,
  type AuthUser,
  type MeResponse,
} from '@/api/authApi';
import { AUTH_UNAUTHORIZED_EVENT } from '@/lib/authEvents';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  source: MeResponse['source'];
  localAdminEnabled: boolean;
  user: AuthUser | null;
  permissions: string[];
  error: string | null;
}

export interface AuthContextValue extends AuthState {
  can: (capability: string) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const anonymousState = (error: string | null = null): AuthState => ({
  status: 'anonymous',
  source: 'anonymous',
  localAdminEnabled: true,
  user: null,
  permissions: [],
  error,
});

const initialState: AuthState = {
  status: 'loading',
  source: 'anonymous',
  localAdminEnabled: true,
  user: null,
  permissions: [],
  error: null,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>(initialState);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const me = await getMe();
      setState({
        status: me.authenticated ? 'authenticated' : 'anonymous',
        source: me.source,
        localAdminEnabled: me.localAdminEnabled,
        user: me.user,
        permissions: me.permissions,
        error: null,
      });
    } catch (err) {
      setState(anonymousState(err instanceof Error ? err.message : '无法连接服务'));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = (): void => {
      setState((prev) => anonymousState(prev.error));
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  const can = useCallback(
    (capability: string): boolean => state.permissions.includes(capability),
    [state.permissions],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await logoutRequest();
    } catch {
      /* 登出失败也清本地态；Cookie 由服务端下次校验兜底 */
    }
    setState(anonymousState());
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, can, refresh, signOut }),
    [state, can, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

export function formatRole(role: AuthUser['role'] | undefined): string {
  if (role === 'admin') return '管理员';
  if (role === 'editor') return '读写账号';
  if (role === 'viewer') return '只读账号';
  return '—';
}
