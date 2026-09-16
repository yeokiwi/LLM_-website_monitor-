import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// ── Token helpers ─────────────────────────────────────────────────────────────
const TOKEN_KEY = 'wm_token';

export const getStoredToken = () => localStorage.getItem(TOKEN_KEY);

export const storeToken = (token) => localStorage.setItem(TOKEN_KEY, token);

export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  // Clear the keys older sessions used, so a stale identity is not left behind
  // in the browser after an upgrade.
  ['wm_user', 'wm_role'].forEach((k) => localStorage.removeItem(k));
};

// ── Request interceptor — attach JWT to every request ────────────────────────
api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor ─────────────────────────────────────────────────────
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';

    // A 401 on the login request itself is just a wrong password; anywhere else
    // it means the session died and the form should be shown again.
    if (status === 401 && url !== '/auth/login') {
      clearSession();
      window.location.href = '/login';
    }

    return Promise.reject(error);
  }
);

/** Pull the human-readable message out of an axios error. */
export const errorMessage = (err, fallback = 'Something went wrong') =>
  err?.response?.data?.error || err?.message || fallback;

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then((r) => r.data);

export const getMe = () => api.get('/auth/me').then((r) => r.data);

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

// ── Schedules ─────────────────────────────────────────────────────────────────
export const getSchedules = () => api.get('/schedules').then((r) => r.data);

export const setSchedule = (websiteId, { frequency, periodDays, isEnabled }) =>
  api.put(`/schedules/${websiteId}`, { frequency, periodDays, isEnabled }).then((r) => r.data);

export const removeSchedule = (websiteId) =>
  api.delete(`/schedules/${websiteId}`).then((r) => r.data);

// ── Upload ────────────────────────────────────────────────────────────────────
export const uploadExcel = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

// ── Data export ───────────────────────────────────────────────────────────────
export const exportMyData = () =>
  api.get('/database/my-data', { responseType: 'blob' });

export const exportWebsites = () =>
  api.get('/websites/export', { responseType: 'blob' });

// ── Backup and restore ────────────────────────────────────────────────────────
export const exportDatabase = () =>
  api.get('/database/export', { responseType: 'blob' });

/**
 * Replace every website, scan and schedule on the instance with the uploaded
 * backup. The confirmation is a query parameter the server insists on, so a
 * stray POST cannot wipe the data on its own.
 */
export const importDatabase = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api
    .post('/database/import?confirm=replace-all-data', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
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

/**
 * A blob response can still be an error — axios does not parse the JSON body
 * when responseType is 'blob', so the error arrives as a Blob of JSON. Read it
 * back so the caller gets a real message rather than "[object Blob]".
 */
export async function readBlobError(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text());
    } catch {
      return {};
    }
  }
  return data || {};
}

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

// Export scan reports as a single PDF. Pass an array of scan ids to export a
// specific subset (e.g. the filtered history view); omit to export all.
export const exportScansPdf = (ids) =>
  api.get('/scans/export-pdf', {
    responseType: 'blob',
    params: ids && ids.length ? { ids: ids.join(',') } : undefined,
  });

// ── Health ────────────────────────────────────────────────────────────────────
export const getHealth = () => api.get('/health').then((r) => r.data);

export default api;
