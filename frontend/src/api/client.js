import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// ── Token helpers ─────────────────────────────────────────────────────────────
const TOKEN_KEY = 'wm_token';
const USER_KEY  = 'wm_user';

export const getStoredToken    = () => localStorage.getItem(TOKEN_KEY);
export const getStoredUser     = () => localStorage.getItem(USER_KEY);

export const storeSession = (token, username) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
};

export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

// ── Request interceptor — attach JWT to every request ────────────────────────
api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor — on 401, clear session and reload to force login ───
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && error.config?.url !== '/auth/login') {
      clearSession();
      window.location.href = '/';
    }
    return Promise.reject(error);
  }
);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then((r) => r.data);

export const getMe = () =>
  api.get('/auth/me').then((r) => r.data);

// ── Websites ──────────────────────────────────────────────────────────────────
export const getWebsites = () => api.get('/websites').then((r) => r.data);

export const addWebsite = (url, name, domain, srms_owner) =>
  api.post('/websites', { url, name, domain, srms_owner }).then((r) => r.data);

export const bulkAddWebsites = (websites) =>
  api.post('/websites/bulk', { websites }).then((r) => r.data);

export const updateWebsite = (id, fields) =>
  api.patch(`/websites/${id}`, fields).then((r) => r.data);

export const deleteWebsite = (id) =>
  api.delete(`/websites/${id}`).then((r) => r.data);

export const bulkDeleteWebsites = (ids) =>
  api.post('/websites/bulk-delete', { ids }).then((r) => r.data);

// ── Upload ────────────────────────────────────────────────────────────────────
export const uploadExcel = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

// ── Scans ─────────────────────────────────────────────────────────────────────
export const triggerScan = (websiteIds, periodDays) =>
  api.post('/scans', { websiteIds, periodDays }).then((r) => r.data);

export const getScans = (limit = 20, offset = 0) =>
  api.get('/scans', { params: { limit, offset } }).then((r) => r.data);

export const getScan = (id) =>
  api.get(`/scans/${id}`).then((r) => r.data);

export const updateScanRemark = (id, remark) =>
  api.patch(`/scans/${id}`, { remark }).then((r) => r.data);

export const getWebsiteScans = (websiteId) =>
  api.get(`/scans/website/${websiteId}`).then((r) => r.data);

// ── Health ────────────────────────────────────────────────────────────────────
export const getHealth = () => api.get('/health').then((r) => r.data);
