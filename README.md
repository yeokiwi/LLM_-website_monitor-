# Website Monitor — LLM-Powered Change Tracker

A web application that monitors websites for changes over a user-specified time window (30 days, 60 days, or custom). It stores snapshots of website content, diffs current vs. historical snapshots, and uses an LLM to summarize what changed in plain English.

## Features

- **Add websites** manually (URL + name) or bulk-import via Excel/CSV
- **Select time period** — 30 days, 60 days, 90 days, or custom
- **Brave Search API integration** — uses indexed, clean page content for change detection (with direct scraping fallback)
- **LLM-powered summaries** — Claude (Anthropic) or OpenAI, configurable via environment variable
- **Snapshot history** — all content snapshots stored in SQLite for future comparisons
- **Scan history page** — paginated log of all past scans with results

## Architecture

```
backend/     Node.js + Express  — REST API, scraping, LLM calls, SQLite DB
frontend/    React + Vite       — UI, dashboard, history view
```

## Prerequisites

- Node.js 18+
- An API key for at least one LLM provider (Anthropic or OpenAI)
- (Optional, recommended) A [Brave Search API](https://api.search.brave.com) key

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your API keys
npm run dev      # starts on http://localhost:3001
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev      # starts on http://localhost:5173
```

Open http://localhost:5173 in your browser.

## Environment Variables (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Backend port (default: 3001) |
| `LLM_PROVIDER` | Yes | `claude` or `openai` |
| `ANTHROPIC_API_KEY` | If using Claude | Your Anthropic API key |
| `OPENAI_API_KEY` | If using OpenAI | Your OpenAI API key |
| `BRAVE_API_KEY` | Recommended | Brave Search API key for smarter scraping |
| `DB_PATH` | No | SQLite file path (default: `./data/monitor.db`) |

## How It Works

1. **First scan** — Fetches the website (via Brave API or direct HTTP), stores a snapshot. Reports "first scan recorded."
2. **Subsequent scans** — Fetches current content, finds the oldest snapshot within your chosen period, diffs old vs. new, sends to LLM for summarization.
3. **Scan statuses:**
   - `no_history` — First scan; baseline recorded
   - `no_changes` — Content hash unchanged; no LLM call made
   - `completed` — Changes detected; LLM summary generated
   - `error` — Fetch or LLM call failed

## Excel/CSV Import Format

| URL | Name |
|---|---|
| https://example.com | Example Site |
| https://news.ycombinator.com | Hacker News |

The `URL` column is required. `Name` is optional.

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/websites` | List all monitored websites |
| POST | `/api/websites` | Add a website `{ url, name }` |
| POST | `/api/websites/bulk` | Bulk add `{ websites: [{url, name}] }` |
| DELETE | `/api/websites/:id` | Remove a website |
| POST | `/api/upload` | Upload Excel/CSV, returns parsed website list |
| POST | `/api/scans` | Trigger scan `{ websiteIds[], periodDays }` |
| GET | `/api/scans` | List scan history (paginated) |
| GET | `/api/scans/:id` | Single scan result |
| GET | `/api/health` | Server status + config info |
