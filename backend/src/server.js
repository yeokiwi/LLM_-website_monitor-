require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Initialize DB (runs migrations on startup)
require('./db');

const websitesRouter = require('./routes/websites');
const scansRouter = require('./routes/scans');
const uploadRouter = require('./routes/upload');
const { getLLMInfo } = require('./services/llmService');

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
app.use('/api/websites', websitesRouter);
app.use('/api/scans', scansRouter);
app.use('/api/upload', uploadRouter);

// Website-specific scans shortcut
app.use('/api/websites/:websiteId/scans', (req, res, next) => {
  req.url = `/website/${req.params.websiteId}`;
  scansRouter(req, res, next);
});

// Health check
app.get('/api/health', (req, res) => {
  const llm = getLLMInfo();
  const scraper = process.env.BRAVE_API_KEY ? 'brave' : 'direct';
  res.json({
    status: 'ok',
    llmProvider: llm.provider,
    llmModel: llm.model,
    llmBaseUrl: llm.baseUrl,
    scraperMethod: scraper,
  });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  const llm = getLLMInfo();
  const scraper = process.env.BRAVE_API_KEY ? 'Brave Search API' : 'Direct (axios+cheerio)';
  console.log(`\n🚀 Website Monitor backend running on http://localhost:${PORT}`);
  console.log(`   LLM provider : ${llm.provider}`);
  console.log(`   LLM model    : ${llm.model}`);
  console.log(`   LLM base URL : ${llm.baseUrl}`);
  console.log(`   Scraper      : ${scraper}\n`);
});
