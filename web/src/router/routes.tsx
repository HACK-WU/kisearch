import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { BrowsePage } from '@/pages/BrowsePage';
import { SearchPage } from '@/pages/SearchPage';
import { WritePage } from '@/pages/WritePage';
import { TasksPage } from '@/pages/TasksPage';
import { DataSourcePage } from '@/pages/DataSourcePage';
import { ChatPage } from '@/pages/ChatPage';
import { ResourcesPage } from '@/pages/ResourcesPage';
import { LoginPage } from '@/pages/LoginPage';
import { UsersPage } from '@/pages/UsersPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { useAuth } from '@/lib/authContext';

function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return <div className="ki-auth-loading">正在加载…</div>;
  }
  if (status === 'anonymous') {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }
  return <>{children}</>;
}

function RequireCapability({ cap, children }: { cap: string; children: ReactNode }): JSX.Element {
  const { can } = useAuth();
  if (!can(cap)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RequireUsersManage({ children }: { children: ReactNode }): JSX.Element {
  const { can } = useAuth();
  if (!can('users.manage')) return <Navigate to="/profile" replace />;
  return <>{children}</>;
}

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="browse" element={<BrowsePage />} />
        <Route path="search" element={<SearchPage />} />
        {/* 导入页由 AppShell 内联渲染（importVisible），路由本身只做能力门禁 */}
        <Route
          path="import"
          element={<RequireCapability cap="knowledge.write">{null}</RequireCapability>}
        />
        <Route
          path="write"
          element={<RequireCapability cap="knowledge.write"><WritePage /></RequireCapability>}
        />
        <Route path="tasks" element={<TasksPage />} />
        {/* 任务详情抽屉（REQ-20261022-002）：URL 可分享 / 刷新可恢复 */}
        <Route path="tasks/:id" element={<TasksPage />} />
        {/* 数据源（REQ-20261020-001）：列表 + 详情（URL 可分享/刷新可恢复） */}
        <Route
          path="datasource"
          element={<RequireCapability cap="datasource.read"><DataSourcePage /></RequireCapability>}
        />
        <Route
          path="datasource/:scope"
          element={<RequireCapability cap="datasource.read"><DataSourcePage /></RequireCapability>}
        />
        {/* 独立对话页（REQ-20261008-001）；:convId 为会话深链（URL 契约 §2.4） */}
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:convId" element={<ChatPage />} />
        {/* 资源：接入（MCP / Skill / LLM）+ 常用功能手册 */}
        <Route path="resources" element={<ResourcesPage />} />
        {/* :topic 为目录深链（/resources/import 等），刷新与分享可复原 */}
        <Route path="resources/:topic" element={<ResourcesPage />} />
        {/* 个人中心（REQ-20261104-001）：所有登录账号 */}
        <Route path="profile" element={<ProfilePage />} />
        {/* 用户管理（REQ-20261103-001）：仅完整管理员 */}
        <Route
          path="users"
          element={<RequireUsersManage><UsersPage /></RequireUsersManage>}
        />
      </Route>
    </Routes>
  );
}
