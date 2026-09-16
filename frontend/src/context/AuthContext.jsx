/**
 * AuthContext
 *
 * There is one shared login for the whole deployment: a username and password
 * set in the server's environment. This holds nothing but whether the session
 * is valid and who it says we are — there are no accounts, roles or plans to
 * reason about.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  getMe,
  login as loginRequest,
  storeToken,
  clearSession,
  getStoredToken,
} from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // null = still checking, false = signed out, string = the signed-in username
  const [username, setUsername] = useState(null);

  useEffect(() => {
    if (!getStoredToken()) {
      setUsername(false);
      return;
    }
    getMe()
      .then((data) => setUsername(data.username))
      .catch(() => {
        clearSession();
        setUsername(false);
      });
  }, []);

  const login = useCallback(async (name, password) => {
    const data = await loginRequest(name, password);
    if (data.token) storeToken(data.token);
    setUsername(data.username);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUsername(false);
  }, []);

  const value = {
    loading: username === null,
    isAuthenticated: Boolean(username),
    username: username || null,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
