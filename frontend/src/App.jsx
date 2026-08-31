import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation, Outlet } from 'react-router-dom';

import Dashboard from './pages/Dashboard';
import History from './pages/History';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import PricingPage from './pages/PricingPage';
import BillingPage from './pages/BillingPage';
import SchedulesPage from './pages/SchedulesPage';
import AdminPage from './pages/AdminPage';
import ReportPage from './pages/ReportPage';
import HelpPage from './pages/HelpPage';

import UpgradeModal from './components/UpgradeModal';
import UsageMeter from './components/UsageMeter';
import { ScanProvider, useScan } from './context/ScanContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { getHealth } from './api/client';
import styles from './App.module.css';

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------

/** Requires a signed-in account; remembers where the user was headed. */
function RequireAuth() {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) return <div className={styles.loading}>Loading…</div>;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;

  return <Outlet />;
}

/** Platform operator only. */
function RequireSuperadmin() {
  const { isSuperadmin } = useAuth();
  if (!isSuperadmin) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Keeps a signed-in user out of the sign-in and sign-up screens. */
function RedirectIfAuthenticated({ children }) {
  const { loading, isAuthenticated } = useAuth();
  if (loading) return <div className={styles.loading}>Loading…</div>;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return children;
}

// ---------------------------------------------------------------------------
// Signed-in shell
// ---------------------------------------------------------------------------
function AppShell({ children }) {
  const { scanning, progress } = useScan();
  const { user, plan, isSuperadmin, logout } = useAuth();
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
            {isSuperadmin && <NavLink to="/admin" className={navClass}>Platform</NavLink>}
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

            <UsageMeter />

            {health && (
              <div className={styles.badge}>
                <span className={health.status === 'ok' ? styles.dot : styles.dotErr} />
                {health.llmProvider || 'LLM'} · {health.scraperMethod || 'scraper'}
              </div>
            )}

            <div className={styles.userInfo}>
              <NavLink to="/account/billing" className={styles.userName}>
                {user?.name || user?.email}
                <span className={styles.roleTag}>{plan?.name || 'Free'}</span>
              </NavLink>
              <button className={styles.logoutBtn} onClick={logout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* `children` is used by the routes that render inside the shell without
          being nested under it — /pricing, which is also reachable signed out. */}
      <main className={styles.main}>{children || <Outlet />}</main>
    </div>
  );
}

/** Minimal chrome for pages a signed-out visitor can reach. */
function PublicLayout({ children }) {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <NavLink to="/login" className={styles.logo}>🔍 Website Monitor</NavLink>
          <div className={styles.right}>
            <NavLink to="/login" className={styles.publicLink}>Sign in</NavLink>
            <NavLink to="/signup" className={styles.publicCta}>Get started</NavLink>
          </div>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

/**
 * Pricing is public, but a signed-in customer should see it with their normal
 * navigation rather than being dropped into a marketing shell.
 */
function PricingRoute() {
  const { loading, isAuthenticated } = useAuth();

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return isAuthenticated ? (
    <AppShell><PricingPage /></AppShell>
  ) : (
    <PublicLayout><PricingPage /></PublicLayout>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <AuthProvider>
      <ScanProvider>
        {/* One shared paywall prompt for every 402 the API returns. */}
        <UpgradeModal />

        <Routes>
          {/* Public */}
          <Route
            path="/login"
            element={<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>}
          />
          <Route
            path="/signup"
            element={<RedirectIfAuthenticated><SignupPage /></RedirectIfAuthenticated>}
          />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/pricing" element={<PricingRoute />} />

          {/* Signed in */}
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/history" element={<History />} />
              <Route path="/schedules" element={<SchedulesPage />} />
              <Route path="/report/:id" element={<ReportPage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="/account/billing" element={<BillingPage />} />

              <Route element={<RequireSuperadmin />}>
                <Route path="/admin" element={<AdminPage />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ScanProvider>
    </AuthProvider>
  );
}
