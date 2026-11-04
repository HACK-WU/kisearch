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
