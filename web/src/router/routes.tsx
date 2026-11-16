import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { BrowsePage } from '@/pages/BrowsePage';
import { SearchPage } from '@/pages/SearchPage';
import { TasksPage } from '@/pages/TasksPage';
import { DataSourcePage } from '@/pages/DataSourcePage';
import { ChatPage } from '@/pages/ChatPage';
import { ResourcesPage } from '@/pages/ResourcesPage';
import { AiSettingsPage } from '@/pages/AiSettingsPage';
import { LifecyclePage } from '@/pages/LifecyclePage';
import { EventsPage } from '@/pages/EventsPage';
import { TrashPage } from '@/pages/TrashPage';
import { ViewsPage } from '@/pages/ViewsPage';
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
        {/*
          合并页（REQ-20261116-002）：`/import` 与 `/write` 是同一个页面的两个 tab。
          页面本体（ImportPage / WritePage）由 AppShell 常驻渲染，两条路由只做能力门禁
          —— 不能在这里渲染组件，否则离开路由即卸载，在途导入会中断。
        */}
        <Route
          path="import"
          element={<RequireCapability cap="knowledge.write">{null}</RequireCapability>}
        />
        <Route
          path="write"
          element={<RequireCapability cap="knowledge.write">{null}</RequireCapability>}
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
        {/*
          agent 问答只读详情（REQ-20261116-003）。
          ⚠️ 必须排在 `chat/:convId` **之前**：否则 `chat/ask/ka-xxx` 会被 `:convId` 段吞掉
          （v6 虽按具体度排序，但静态段与动态段的边界以显式顺序 + 段数区分最稳）。
        */}
        <Route path="chat/ask/:askId" element={<ChatPage />} />
        <Route path="chat/:convId" element={<ChatPage />} />
        {/* 知识视图（REQ-20261104-004）：团队共享的多库聚合管理页 */}
        <Route
          path="views"
          element={<RequireCapability cap="views.read"><ViewsPage /></RequireCapability>}
        />
        {/* 资源：接入（MCP / Skill / LLM）+ 常用功能手册 */}
        <Route path="resources" element={<ResourcesPage />} />
        {/* :topic 为目录深链（/resources/import 等），刷新与分享可复原 */}
        <Route path="resources/:topic" element={<ResourcesPage />} />
        {/* AI 设置（2026-11-15）：不分 scope 的全局 AI 配置，只读账号也可进入查看 */}
        <Route path="settings/ai" element={<AiSettingsPage />} />
        {/* 知识治理（REQ-20261113-004 · S-07）：分类 / 事件 / 回收站三页 */}
        <Route
          path="governance/lifecycle"
          element={<RequireCapability cap="knowledge.read"><LifecyclePage /></RequireCapability>}
        />
        <Route
          path="governance/events"
          element={<RequireCapability cap="knowledge.read"><EventsPage /></RequireCapability>}
        />
        <Route
          path="governance/trash"
          element={<RequireCapability cap="knowledge.read"><TrashPage /></RequireCapability>}
        />
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
