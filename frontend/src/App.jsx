import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation, Outlet } from 'react-router-dom';

import Dashboard from './pages/Dashboard';
import History from './pages/History';
import LoginPage from './pages/LoginPage';
import SchedulesPage from './pages/SchedulesPage';
import ReportPage from './pages/ReportPage';
import HelpPage from './pages/HelpPage';

import ErrorBoundary from './components/ErrorBoundary';
import { ScanProvider, useScan } from './context/ScanContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { getHealth } from './api/client';
import styles from './App.module.css';

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------

/** Requires a signed-in session; remembers where the user was headed. */
function RequireAuth() {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) return <div className={styles.loading}>Loading…</div>;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;

  return <Outlet />;
}

/** Keeps a signed-in user out of the sign-in screen. */
function RedirectIfAuthenticated({ children }) {
  const { loading, isAuthenticated } = useAuth();
  if (loading) return <div className={styles.loading}>Loading…</div>;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return children;
}

// ---------------------------------------------------------------------------
// Signed-in shell
// ---------------------------------------------------------------------------
function AppShell() {
  const { scanning, progress } = useScan();
  const { username, logout } = useAuth();
  const [health, setHealth] = useState(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: 'error' }));
  }, []);

  const navClass = ({ isActive }) => (isActive ? styles.active : '');

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <span className={styles.logo}>🔍 Website Monitor</span>

          <nav className={styles.nav}>
            <NavLink to="/" end className={navClass}>Dashboard</NavLink>
            <NavLink to="/history" className={navClass}>Scan History</NavLink>
            <NavLink to="/schedules" className={navClass}>Schedules</NavLink>
            <NavLink to="/help" className={navClass}>Help</NavLink>
          </nav>

          <div className={styles.right}>
            {/* Global scan progress indicator — visible on every page while scanning */}
            {scanning && progress && (
              <div className={styles.scanIndicator}>
                <span className={styles.scanPulse} />
                <span className={styles.scanText}>
                  Scanning {progress.current}/{progress.total}
                </span>
                <div className={styles.scanMiniBar}>
                  <div
                    className={styles.scanMiniFill}
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {health && (
              <div className={styles.badge}>
                <span className={health.status === 'ok' ? styles.dot : styles.dotErr} />
                {health.llmProvider || 'LLM'} · {health.scraperMethod || 'scraper'}
              </div>
            )}

            <div className={styles.userInfo}>
              <span className={styles.userName}>
                <span className={styles.userLabel}>{username}</span>
              </span>
              <button className={styles.logoutBtn} onClick={logout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className={styles.main}><Outlet /></main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <AuthProvider>
      <ScanProvider>
        {/* A render error inside any page shows a message rather than
            unmounting the tree and leaving a blank white document. */}
        <ErrorBoundary>
          <Routes>
            {/* Public */}
            <Route
              path="/login"
              element={<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>}
            />

            {/* Signed in */}
            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/history" element={<History />} />
                <Route path="/schedules" element={<SchedulesPage />} />
                <Route path="/report/:id" element={<ReportPage />} />
                <Route path="/help" element={<HelpPage />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </ScanProvider>
    </AuthProvider>
  );
}
