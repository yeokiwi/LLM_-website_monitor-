import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import LoginPage from './pages/LoginPage';
import ReportPage from './pages/ReportPage';
import HelpPage from './pages/HelpPage';
import { getHealth, getMe, storeSession, clearSession, getStoredToken, getStoredUser } from './api/client';
import styles from './App.module.css';

export default function App() {
  // null = loading, false = not authenticated, string = username
  const [user, setUser] = useState(null);
  const [health, setHealth] = useState(null);

  // On mount, verify any stored token is still valid
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setUser(false);
      return;
    }
    getMe()
      .then((data) => setUser(data.username))
      .catch(() => {
        clearSession();
        setUser(false);
      });
  }, []);

  // Load health info once authenticated
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

  // Still verifying stored token
  if (user === null) {
    return <div className={styles.loading}>Loading…</div>;
  }

  // Not authenticated — show login page
  if (user === false) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Authenticated — show the app
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
            {health && (
              <div className={styles.badge}>
                <span className={health.status === 'ok' ? styles.dot : styles.dotErr} />
                {health.llmProvider || 'LLM'} · {health.scraperMethod || 'scraper'}
              </div>
            )}
            <div className={styles.userInfo}>
              <span className={styles.userName}>{user}</span>
              <button className={styles.logoutBtn} onClick={handleLogout}>
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
