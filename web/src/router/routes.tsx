import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { BrowsePage } from '@/pages/BrowsePage';
import { SearchPage } from '@/pages/SearchPage';
import { ImportPage } from '@/pages/ImportPage';
import { WritePage } from '@/pages/WritePage';

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="browse" element={<BrowsePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="write" element={<WritePage />} />
      </Route>
    </Routes>
  );
}
