import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import LoginPage from './pages/LoginPage';
import ReportPage from './pages/ReportPage';
import HelpPage from './pages/HelpPage';
import { ScanProvider, useScan } from './context/ScanContext';
import { getHealth, getMe, storeSession, clearSession, getStoredToken } from './api/client';
import styles from './App.module.css';

// ---------------------------------------------------------------------------
// Inner shell — consumes ScanContext for the header indicator
// ---------------------------------------------------------------------------
function AppShell({ user, health, onLogout }) {
  const { scanning, progress } = useScan();

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <span className={styles.logo}>🔍 Website Monitor</span>

          <nav className={styles.nav}>
            <NavLink to="/" end className={({ isActive }) => isActive ? styles.active : ''}>
              Dashboard
            </NavLink>
            <NavLink to="/history" className={({ isActive }) => isActive ? styles.active : ''}>
              Scan History
            </NavLink>
            <NavLink to="/help" className={({ isActive }) => isActive ? styles.active : ''}>
              Help
            </NavLink>
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
              <span className={styles.userName}>{user}</span>
              <button className={styles.logoutBtn} onClick={onLogout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/history" element={<History />} />
          <Route path="/report/:id" element={<ReportPage />} />
          <Route path="/help" element={<HelpPage />} />
        </Routes>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root — handles auth, provides ScanContext
// ---------------------------------------------------------------------------
export default function App() {
  const [user, setUser]     = useState(null); // null=loading, false=unauthed, string=username
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) { setUser(false); return; }
    getMe()
      .then((data) => setUser(data.username))
      .catch(() => { clearSession(); setUser(false); });
  }, []);

  useEffect(() => {
    if (!user) return;
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ status: 'error' }));
  }, [user]);

  function handleLogin(token, username) {
    storeSession(token, username);
    setUser(username);
  }

  function handleLogout() {
    clearSession();
    setUser(false);
    setHealth(null);
  }

  if (user === null) return <div className={styles.loading}>Loading…</div>;
  if (user === false) return <LoginPage onLogin={handleLogin} />;

  return (
    <ScanProvider>
      <AppShell user={user} health={health} onLogout={handleLogout} />
    </ScanProvider>
  );
}
