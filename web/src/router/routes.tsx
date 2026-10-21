import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { BrowsePage } from '@/pages/BrowsePage';
import { SearchPage } from '@/pages/SearchPage';
import { WritePage } from '@/pages/WritePage';
import { TasksPage } from '@/pages/TasksPage';
import { DataSourcePage } from '@/pages/DataSourcePage';
import { ChatPage } from '@/pages/ChatPage';

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="browse" element={<BrowsePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="import" element={null} />
        <Route path="write" element={<WritePage />} />
        <Route path="tasks" element={<TasksPage />} />
        {/* 数据源（REQ-20261020-001）：列表 + 详情（URL 可分享/刷新可恢复） */}
        <Route path="datasource" element={<DataSourcePage />} />
        <Route path="datasource/:scope" element={<DataSourcePage />} />
        {/* 独立对话页（REQ-20261008-001）；:convId 为会话深链（URL 契约 §2.4） */}
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:convId" element={<ChatPage />} />
      </Route>
    </Routes>
  );
}
