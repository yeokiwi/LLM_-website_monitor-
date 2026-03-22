import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// ── Websites ──────────────────────────────────────────────────────────────
export const getWebsites = () => api.get('/websites').then((r) => r.data);

export const addWebsite = (url, name) =>
  api.post('/websites', { url, name }).then((r) => r.data);

export const bulkAddWebsites = (websites) =>
  api.post('/websites/bulk', { websites }).then((r) => r.data);

export const deleteWebsite = (id) =>
  api.delete(`/websites/${id}`).then((r) => r.data);

// ── Upload ────────────────────────────────────────────────────────────────
export const uploadExcel = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

// ── Scans ─────────────────────────────────────────────────────────────────
export const triggerScan = (websiteIds, periodDays) =>
  api.post('/scans', { websiteIds, periodDays }).then((r) => r.data);

export const getScans = (limit = 20, offset = 0) =>
  api.get('/scans', { params: { limit, offset } }).then((r) => r.data);

export const getScan = (id) =>
  api.get(`/scans/${id}`).then((r) => r.data);

export const getWebsiteScans = (websiteId) =>
  api.get(`/scans/website/${websiteId}`).then((r) => r.data);

// ── Health ────────────────────────────────────────────────────────────────
export const getHealth = () => api.get('/health').then((r) => r.data);
