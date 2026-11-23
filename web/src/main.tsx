import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyStoredTheme } from './lib/theme';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found in index.html');
}

// 首渲染前落地主题：登录页与「页面不存在」兜底页在 AppShell 之外，拿不到 useTheme
applyStoredTheme();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
