require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

// Initialize DB (runs migrations on startup)
require('./db');

const websitesRouter = require('./routes/websites');
const scansRouter = require('./routes/scans');
const uploadRouter = require('./routes/upload');
const databaseRouter = require('./routes/database');
const authRouter = require('./routes/auth');
const { requireAuth, requireAdmin } = require('./middleware/auth');
const { getLLMInfo } = require('./services/llmService');
const { resolveScraperProvider } = require('./services/scraper');

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Public — no token required
app.use('/api/auth', authRouter);

// Health check is public so Railway's healthcheck works without a token
app.get('/api/health', (req, res) => {
  const llm = getLLMInfo();
  const scraper = resolveScraperProvider();
  res.json({
    status: 'ok',
    llmProvider: llm.provider,
    llmModel: llm.model,
    llmBaseUrl: llm.baseUrl,
    scraperMethod: scraper,
  });
});

// Protected — all routes below require a valid JWT. Website management,
// Excel/CSV import and database export/import are further restricted to the
// administrator account (see requireAdmin on the individual website routes and
// the whole upload/database routers below).
app.use('/api/websites', requireAuth, websitesRouter);
app.use('/api/scans',    requireAuth, scansRouter);
app.use('/api/upload',   requireAuth, requireAdmin, uploadRouter);
app.use('/api/database', requireAuth, requireAdmin, databaseRouter);

// Website-specific scans shortcut
app.use('/api/websites/:websiteId/scans', requireAuth, (req, res, next) => {
  req.url = `/website/${req.params.websiteId}`;
  scansRouter(req, res, next);
});

// ---------------------------------------------------------------------------
// Serve built React frontend in production
// (Dockerfile copies frontend/dist → /app/public inside the container)
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../public');
  app.use(express.static(distPath));
  // SPA fallback — let React Router handle all non-API routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  const llm = getLLMInfo();
  const scraperLabels = {
    firecrawl: 'Firecrawl API',
    brave: 'Brave Search API',
    serper: 'Serper Search API',
    direct: 'Direct (axios+cheerio)',
  };
  const scraper = scraperLabels[resolveScraperProvider()];
  console.log(`\n🚀 Website Monitor backend running on http://localhost:${PORT}`);
  console.log(`   LLM provider : ${llm.provider}`);
  console.log(`   LLM model    : ${llm.model}`);
  console.log(`   LLM base URL : ${llm.baseUrl}`);
  console.log(`   Scraper      : ${scraper}\n`);
});
