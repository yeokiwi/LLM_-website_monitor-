import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// ── Token helpers ─────────────────────────────────────────────────────────────
const TOKEN_KEY = 'wm_token';

export const getStoredToken = () => localStorage.getItem(TOKEN_KEY);

export const storeToken = (token) => localStorage.setItem(TOKEN_KEY, token);

export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  // Clear the keys the previous username/role session used, so an upgrade does
  // not leave stale identity behind in the browser.
  ['wm_user', 'wm_role'].forEach((k) => localStorage.removeItem(k));
};

// ── Paywall events ────────────────────────────────────────────────────────────
// A 402 from any endpoint means "your plan does not cover this". Rather than
// every caller handling it, the interceptor publishes it and the app shows one
// shared upgrade prompt.
const paywallListeners = new Set();

export function onPaywall(listener) {
  paywallListeners.add(listener);
  return () => paywallListeners.delete(listener);
}

function emitPaywall(detail) {
  paywallListeners.forEach((listener) => listener(detail));
}

// ── Request interceptor — attach JWT to every request ────────────────────────
api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor ─────────────────────────────────────────────────────
const PUBLIC_AUTH_PATHS = [
  '/auth/login',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/verify-email',
];

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';

    if (status === 401 && !PUBLIC_AUTH_PATHS.includes(url)) {
      clearSession();
      window.location.href = '/login';
    }

    if (status === 402) {
      emitPaywall(error.response.data || {});
    }

    return Promise.reject(error);
  }
);

/** Pull the human-readable message out of an axios error. */
export const errorMessage = (err, fallback = 'Something went wrong') =>
  err?.response?.data?.error || err?.message || fallback;

// ── Auth ──────────────────────────────────────────────────────────────────────
export const signup = (email, password, name) =>
  api.post('/auth/signup', { email, password, name }).then((r) => r.data);

export const login = (email, password) =>
  api.post('/auth/login', { email, password }).then((r) => r.data);

export const getMe = () => api.get('/auth/me').then((r) => r.data);

export const verifyEmail = (token) =>
  api.post('/auth/verify-email', { token }).then((r) => r.data);

export const resendVerification = () =>
  api.post('/auth/resend-verification').then((r) => r.data);

export const forgotPassword = (email) =>
  api.post('/auth/forgot-password', { email }).then((r) => r.data);

export const resetPassword = (token, password) =>
  api.post('/auth/reset-password', { token, password }).then((r) => r.data);

export const changePassword = (currentPassword, newPassword) =>
  api.post('/auth/change-password', { currentPassword, newPassword }).then((r) => r.data);

export const updatePreferences = (prefs) =>
  api.patch('/auth/me', prefs).then((r) => r.data);

// ── Billing ───────────────────────────────────────────────────────────────────
export const getPlans = () => api.get('/billing/plans').then((r) => r.data);

export const getSubscription = () =>
  api.get('/billing/subscription').then((r) => r.data);

export const startCheckout = (planSlug, provider) =>
  api.post('/billing/checkout', { planSlug, provider }).then((r) => r.data);

export const openBillingPortal = () =>
  api.post('/billing/portal').then((r) => r.data);

export const activatePaypal = (subscriptionId) =>
  api.post('/billing/paypal/activate', { subscriptionId }).then((r) => r.data);

export const cancelSubscription = () =>
  api.post('/billing/cancel').then((r) => r.data);

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
 * when responseType is 'blob', so a 402 arrives as a Blob of JSON. Read it back
 * so the paywall handler gets real data rather than "[object Blob]".
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

// ── Admin (platform operator) ─────────────────────────────────────────────────
export const getAdminStats = () => api.get('/admin/stats').then((r) => r.data);

export const getAdminUsers = (limit = 50, offset = 0) =>
  api.get('/admin/users', { params: { limit, offset } }).then((r) => r.data);

export const getAdminSubscriptions = (limit = 50, offset = 0) =>
  api.get('/admin/subscriptions', { params: { limit, offset } }).then((r) => r.data);

// ── Health ────────────────────────────────────────────────────────────────────
export const getHealth = () => api.get('/health').then((r) => r.data);

export default api;
