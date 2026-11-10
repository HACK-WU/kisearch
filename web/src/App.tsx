/**
 * App.tsx —— 应用根：QueryClient + ScopeProvider + 路由
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ScopeProvider } from '@/lib/scopeContext';
import { AuthProvider } from '@/lib/authContext';
import { AppRoutes } from '@/router/routes';
import './styles/ki.css';
import './styles/users-v2.css';
/* 知识库多选下拉：视图页与 Token 创建表单共用（全局引入，不随页面懒加载） */
import './styles/scope-picker.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ScopeProvider>
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </ScopeProvider>
    </QueryClientProvider>
  );
}

export default App;
