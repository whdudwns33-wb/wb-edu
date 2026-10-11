import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth.tsx';
import { Layout } from './components/Layout.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { PlansListPage } from './pages/PlansListPage.tsx';
import { TodayPage } from './pages/TodayPage.tsx';
import { TextbooksPage, TextbookEditorPage } from './pages/TextbooksPage.tsx';
import { CurriculaPage, CurriculumEditorPage } from './pages/CurriculaPage.tsx';
import { PlanCreatePage } from './pages/PlanCreatePage.tsx';
import { PlanDetailPage } from './pages/PlanDetailPage.tsx';
import { ObjectivesPage } from './pages/ObjectivesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { PrintPage } from './pages/PrintPage.tsx';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <p className="muted" style={{ padding: 24 }}>불러오는 중…</p>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/print/plans/:id"
        element={
          <RequireAuth>
            <PrintPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/plans" replace />} />
        <Route path="/plans" element={<PlansListPage />} />
        <Route path="/plans/new" element={<PlanCreatePage />} />
        <Route path="/plans/:id" element={<PlanDetailPage />} />
        <Route path="/today" element={<TodayPage />} />
        <Route path="/textbooks" element={<TextbooksPage />} />
        <Route path="/textbooks/:id" element={<TextbookEditorPage />} />
        <Route path="/curricula" element={<CurriculaPage />} />
        <Route path="/curricula/:id" element={<CurriculumEditorPage />} />
        <Route path="/objectives" element={<ObjectivesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/plans" replace />} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>,
);
