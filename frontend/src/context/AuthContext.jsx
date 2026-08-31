/**
 * AuthContext
 *
 * Holds the signed-in account together with its plan, entitlements and current
 * usage — all of which arrive in one `/auth/me` response, so gated UI can be
 * rendered without a second round trip.
 *
 * Components ask `can('pdf_export')` rather than checking a role. Roles no
 * longer decide what a customer may do; their plan does.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  getMe,
  login as loginRequest,
  signup as signupRequest,
  storeToken,
  clearSession,
  getStoredToken,
} from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // null = still checking, false = signed out, object = signed in
  const [account, setAccount] = useState(null);

  const applySession = useCallback((data) => {
    if (data.token) storeToken(data.token);
    setAccount({
      user: data.user,
      plan: data.plan,
      entitlements: data.entitlements || {},
      subscription: data.subscription || null,
      usage: data.usage || null,
    });
  }, []);

  useEffect(() => {
    if (!getStoredToken()) {
      setAccount(false);
      return;
    }
    getMe()
      .then(applySession)
      .catch(() => {
        clearSession();
        setAccount(false);
      });
  }, [applySession]);

  const login = useCallback(
    async (email, password) => {
      applySession(await loginRequest(email, password));
    },
    [applySession]
  );

  const signup = useCallback(
    async (email, password, name) => {
      applySession(await signupRequest(email, password, name));
    },
    [applySession]
  );

  const logout = useCallback(() => {
    clearSession();
    setAccount(false);
  }, []);

  /**
   * Re-read the account. Called after anything that can change entitlements or
   * usage — a completed scan, a plan change, returning from checkout.
   */
  const refresh = useCallback(async () => {
    if (!getStoredToken()) return;
    try {
      applySession(await getMe());
    } catch {
      /* a failed refresh should never sign the user out mid-task */
    }
  }, [applySession]);

  const value = {
    loading: account === null,
    isAuthenticated: Boolean(account),
    user: account ? account.user : null,
    plan: account ? account.plan : null,
    entitlements: account ? account.entitlements : {},
    subscription: account ? account.subscription : null,
    usage: account ? account.usage : null,
    isSuperadmin: account ? account.user?.role === 'superadmin' : false,
    /** Is a boolean feature included in the current plan? */
    can: (feature) => Boolean(account?.entitlements?.[feature]),
    /** The cadences the current plan allows for scheduled scans. */
    allowedSchedules: account?.entitlements?.schedules || [],
    login,
    signup,
    logout,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
