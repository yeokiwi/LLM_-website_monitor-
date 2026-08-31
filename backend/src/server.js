require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Initialize DB (runs schema migrations on import), then seed plans, the
// platform administrator, and the multi-tenant ownership migration.
require('./db');
const { bootstrap } = require('./bootstrap');

bootstrap();

const websitesRouter = require('./routes/websites');
const scansRouter = require('./routes/scans');
const uploadRouter = require('./routes/upload');
const databaseRouter = require('./routes/database');
const authRouter = require('./routes/auth');
const billingRouter = require('./routes/billing');
const webhooksRouter = require('./routes/webhooks');
const schedulesRouter = require('./routes/schedules');
const adminRouter = require('./routes/admin');

const { requireAuth, requireSuperadmin } = require('./middleware/auth');
const { authLimiter, apiLimiter } = require('./middleware/rateLimit');
const { getLLMInfo } = require('./services/llmService');
const { resolveScraperProvider } = require('./services/scraper');
const billing = require('./services/billing');
const scheduler = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3001;

// Behind Railway's proxy, so the client IP the rate limiter keys on comes from
// X-Forwarded-For rather than the socket.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Webhooks — mounted FIRST, before express.json().
//
// Stripe signs the exact bytes it sent, so the body must reach the signature
// check unparsed. Each webhook route installs its own parser.
// ---------------------------------------------------------------------------
app.use('/api/billing/webhooks', webhooksRouter);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  helmet({
    // The SPA is served from this same origin with inline styles; the default
    // CSP would block it and buys little for a same-origin bundle.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// In production the frontend is served from this same origin, so no browser
// needs a cross-origin grant. APP_URL opens it up for a split deployment.
app.use(
  cors({
    origin:
      process.env.NODE_ENV === 'production'
        ? process.env.APP_URL || false
        : true,
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Public — no token required
app.use('/api/auth', authLimiter, authRouter);

// Public pricing data; the rest of the router requires auth internally.
app.use('/api/billing', apiLimiter, billingRouter);

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
    billingProviders: billing.availableProviders(),
    schedulerEnabled: scheduler.isEnabled(),
  });
});

// Protected — all routes below require a valid JWT. Data is scoped to the
// signed-in account by the repositories, so there is no role gate here;
// /api/admin is the one cross-tenant surface and is operator-only.
app.use('/api/websites', requireAuth, apiLimiter, websitesRouter);
app.use('/api/scans', requireAuth, apiLimiter, scansRouter);
app.use('/api/schedules', requireAuth, apiLimiter, schedulesRouter);
app.use('/api/upload', requireAuth, apiLimiter, uploadRouter);
app.use('/api/database', requireAuth, apiLimiter, databaseRouter);
app.use('/api/admin', requireAuth, requireSuperadmin, adminRouter);

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
  const status = err.status || err.statusCode || 500;

  // Expected, actionable failures (an unconfigured gateway, a rejected upload)
  // are not incidents — only log a stack for the ones we did not anticipate.
  if (status >= 500) console.error(err);
  else console.warn(`${status} ${req.method} ${req.originalUrl}: ${err.message}`);

  res.status(status).json({ error: err.message || 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    const llm = getLLMInfo();
    const scraperLabels = {
      firecrawl: 'Firecrawl API',
      brave: 'Brave Search API',
      serper: 'Serper Search API',
      direct: 'Direct (axios+cheerio)',
    };
    const scraper = scraperLabels[resolveScraperProvider()];
    const gateways = billing.availableProviders();

    console.log(`\n🚀 Website Monitor backend running on http://localhost:${PORT}`);
    console.log(`   LLM provider : ${llm.provider}`);
    console.log(`   LLM model    : ${llm.model}`);
    console.log(`   LLM base URL : ${llm.baseUrl}`);
    console.log(`   Scraper      : ${scraper}`);
    console.log(`   Billing      : ${gateways.length ? gateways.join(', ') : 'not configured'}`);
    console.log(`   Email        : ${require('./services/mailer').isConfigured() ? 'SMTP configured' : 'not configured (logging only)'}`);

    scheduler.start();
    console.log('');
  });
}

module.exports = app;
