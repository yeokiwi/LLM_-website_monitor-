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

// Apply scraper flag(s) to many websites at once. Omit `ids` to target all.
export const bulkUpdateWebsites = (ids, fields) =>
  api.post('/websites/bulk-update', { ids, updates: fields }).then((r) => r.data);

// ── Upload ────────────────────────────────────────────────────────────────────
export const uploadExcel = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

// ── Database & data export ────────────────────────────────────────────────────
export const exportDatabase = () =>
  api.get('/database/export', { responseType: 'blob' });

export const exportWebsites = () =>
  api.get('/websites/export', { responseType: 'blob' });

export const importDatabase = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/database/import', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

// Trigger a browser download from a blob axios response, using the filename
// from the Content-Disposition header when present.
export const downloadBlob = (response, fallbackName) => {
  const disposition = response.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const filename = match ? match[1] : fallbackName;

  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
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
