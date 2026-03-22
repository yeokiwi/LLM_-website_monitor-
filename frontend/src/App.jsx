import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import { getHealth } from './api/client';
import styles from './App.module.css';

export default function App() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ status: 'error' }));
  }, []);

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
          </nav>
          {health && (
            <div className={styles.badge}>
              <span className={health.status === 'ok' ? styles.dot : styles.dotErr} />
              {health.llmProvider || 'LLM'} · {health.scraperMethod || 'scraper'}
            </div>
          )}
        </div>
      </header>

      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/history" element={<History />} />
        </Routes>
      </main>
    </div>
  );
}
