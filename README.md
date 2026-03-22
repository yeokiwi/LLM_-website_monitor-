# Website Monitor

A web-based application that uses an LLM (Claude or OpenAI) to monitor websites for changes over a user-defined time period. It stores snapshots of website content, diffs historical against current snapshots, and summarises what changed in plain English.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [1. Clone the repository](#1-clone-the-repository)
  - [2. Configure the backend](#2-configure-the-backend)
  - [3. Install dependencies](#3-install-dependencies)
- [Running the Application](#running-the-application)
  - [Development mode](#development-mode)
  - [Production mode](#production-mode)
- [Environment Variables](#environment-variables)
- [Using the Application](#using-the-application)
  - [Adding websites](#adding-websites)
  - [Importing websites from Excel](#importing-websites-from-excel)
  - [Running a scan](#running-a-scan)
  - [Viewing history](#viewing-history)
- [Excel / CSV Import Format](#excel--csv-import-format)
- [Scan Result Statuses](#scan-result-statuses)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Overview

Website Monitor lets you track what changes on any website over time without manual checking. Simply add the URLs you care about, choose a lookback period (e.g. "what changed in the last 30 days"), and trigger a scan. The application fetches current content, compares it against a stored snapshot from the chosen period, and asks an LLM to write a human-readable summary of the differences.

---

## Features

- **Manual or bulk website entry** — add sites one by one, or upload an Excel/CSV file containing a list of URLs
- **Flexible time periods** — 30 days, 60 days, 90 days, or any custom number of days
- **Brave Search API integration** — uses Brave's indexed, clean page content for change detection (direct HTTP scraping fallback when no Brave key is configured)
- **LLM-powered change summaries** — Claude (Anthropic) or OpenAI GPT-4o, selected via a single environment variable
- **Persistent snapshot storage** — every scan stores a content snapshot in SQLite so future scans always have a baseline to compare against
- **Intelligent scan statuses** — skips LLM calls when content is unchanged; handles first-time scans gracefully
- **Scan history page** — paginated log of all past scans with expandable LLM summaries

---

## How It Works

```
Add websites  →  Choose period  →  Trigger scan
                                        │
                          ┌─────────────▼──────────────┐
                          │  1. Fetch current content   │
                          │     (Brave API or direct)   │
                          │  2. Store new snapshot      │
                          │  3. Find baseline snapshot  │
                          │     from N days ago         │
                          │  4. Diff old vs new         │
                          │  5. Ask LLM to summarise    │
                          └─────────────┬──────────────┘
                                        │
                              Display LLM summary
```

**First scan:** A baseline snapshot is recorded. No comparison is possible yet — the app reports "First scan recorded" and waits for the next run.

**Subsequent scans:** The app finds the oldest snapshot within the chosen period, diffs it against today's content, and sends both versions plus the diff to the LLM. If the content hash is identical, the LLM call is skipped and "No changes detected" is returned.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 18+ |
| Backend framework | Express 4 |
| Database | SQLite via `better-sqlite3` (no server required) |
| Web scraping | Brave Search API (primary) · axios + cheerio (fallback) |
| Excel / CSV parsing | SheetJS (`xlsx`) |
| File upload | multer |
| Text diffing | `diff` (line-level) |
| LLM — Claude | `@anthropic-ai/sdk` |
| LLM — OpenAI | `openai` |
| Frontend framework | React 18 + Vite 5 |
| Frontend routing | React Router v6 |
| HTTP client (UI) | axios |

---

## Project Structure

```
.
├── README.md
├── backend/
│   ├── .env.example            ← copy to .env and fill in keys
│   ├── package.json
│   └── src/
│       ├── server.js           ← Express entry point
│       ├── db/
│       │   └── index.js        ← SQLite init & schema migrations
│       ├── routes/
│       │   ├── websites.js     ← CRUD endpoints for monitored sites
│       │   ├── scans.js        ← scan orchestration & results
│       │   └── upload.js       ← Excel / CSV upload endpoint
│       └── services/
│           ├── scraper.js      ← Brave API + axios/cheerio fallback
│           ├── snapshotService.js  ← save / retrieve snapshots
│           ├── diffService.js      ← compute line diff
│           └── llmService.js       ← Claude / OpenAI abstraction
└── frontend/
    ├── index.html
    ├── vite.config.js          ← proxies /api → localhost:3001
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx             ← router + header
        ├── api/
        │   └── client.js       ← all backend API calls
        ├── components/
        │   ├── AddWebsiteForm.jsx
        │   ├── ExcelUpload.jsx
        │   ├── PeriodSelector.jsx
        │   ├── WebsiteList.jsx
        │   └── ScanResultCard.jsx
        └── pages/
            ├── Dashboard.jsx   ← main page
            └── History.jsx     ← paginated scan history
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18 or later | https://nodejs.org |
| npm | 8 or later | bundled with Node.js |
| LLM API key | — | Anthropic **or** OpenAI (at least one required) |
| Brave Search API key | — | Optional but recommended — https://api.search.brave.com |

---

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd LLM_-website_monitor-
```

### 2. Configure the backend

```bash
cd backend
cp .env.example .env
```

Open `backend/.env` in a text editor and fill in your API keys:

```dotenv
PORT=3001

# Choose your LLM provider: "claude" or "openai"
LLM_PROVIDER=claude

# Anthropic key (required when LLM_PROVIDER=claude)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI key (required when LLM_PROVIDER=openai)
OPENAI_API_KEY=sk-...

# Brave Search API key (optional — enables smarter content discovery)
BRAVE_API_KEY=BSA...

# SQLite file location (created automatically on first run)
DB_PATH=./data/monitor.db
```

> **Tip:** If `BRAVE_API_KEY` is not set, the app falls back to fetching pages directly with HTTP. Some sites may block automated requests in this mode.

### 3. Install dependencies

Install backend and frontend dependencies in two steps:

```bash
# From the repo root — install backend
cd backend && npm install

# Install frontend
cd ../frontend && npm install
```

---

## Running the Application

Both the backend and frontend must be running at the same time. Open **two terminal windows**.

### Development mode

**Terminal 1 — backend** (auto-restarts on file changes):

```bash
cd backend
npm run dev
```

Expected output:
```
🚀 Website Monitor backend running on http://localhost:3001
   LLM provider : claude
   Scraper      : Brave Search API
```

**Terminal 2 — frontend** (hot-reload dev server):

```bash
cd frontend
npm run dev
```

Expected output:
```
  VITE v5.x.x  ready in Xms

  ➜  Local:   http://localhost:5173/
```

Open **http://localhost:5173** in your browser.

### Production mode

Build the frontend into static files and serve everything from the backend:

```bash
# Build the frontend
cd frontend
npm run build          # outputs to frontend/dist/

# Start the backend (serves API only; host frontend/dist with any static server)
cd ../backend
npm start
```

To serve the built frontend alongside the backend, copy `frontend/dist` to a web server (nginx, Apache, etc.) or extend `backend/src/server.js` to serve the `dist` folder with `express.static`.

---

## Environment Variables

All variables are set in `backend/.env`.

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `3001` | No | Port the Express server listens on |
| `LLM_PROVIDER` | `claude` | Yes | `claude` or `openai` |
| `ANTHROPIC_API_KEY` | — | When using Claude | API key from https://console.anthropic.com |
| `OPENAI_API_KEY` | — | When using OpenAI | API key from https://platform.openai.com |
| `BRAVE_API_KEY` | — | Recommended | API key from https://api.search.brave.com |
| `DB_PATH` | `./data/monitor.db` | No | Path to the SQLite database file |

---

## Using the Application

### Adding websites

1. Go to the **Dashboard** (default page).
2. In the **Add Websites** panel, type (or paste) a full URL including the protocol, e.g. `https://example.com`.
3. Optionally enter a display name.
4. Click **Add Website**. The site appears in the table below.

### Importing websites from Excel

1. In the **Add Websites** panel, click **Import from Excel / CSV**.
2. Select an `.xlsx`, `.xls`, or `.csv` file.
3. A preview of the parsed rows is shown. Review, then click **Import all N**.
4. All valid URLs are added to the monitored list. Duplicates are silently skipped.

See [Excel / CSV Import Format](#excel--csv-import-format) for the expected file layout.

### Running a scan

1. Tick the checkboxes next to the websites you want to scan (or use the header checkbox to select all).
2. Choose your **Period** — this determines how far back the app looks for a baseline snapshot to compare against.
3. Click **Scan Selected**.
4. Results appear below the table as expandable cards, one per website.

### Viewing history

Click **Scan History** in the navigation bar to see a paginated log of every scan that has ever been run, with statuses and LLM summaries.

---

## Excel / CSV Import Format

The file must have a header row. Column names are case-insensitive.

| URL *(required)* | Name *(optional)* |
|---|---|
| https://example.com | Example Site |
| https://news.ycombinator.com | Hacker News |
| https://github.com/trending | GitHub Trending |

- The `URL` column must contain fully-qualified URLs starting with `http://` or `https://`.
- Rows with missing or invalid URLs are skipped automatically.
- Duplicate URLs (already in the database) are silently ignored.

---

## Scan Result Statuses

| Status | Meaning |
|---|---|
| **Changes Found** | Differences detected between the old and new snapshots; LLM summary is shown. |
| **No Changes** | Content hash is identical to the baseline snapshot; no LLM call was made. |
| **First Scan** | No historical snapshot existed in the chosen period; a baseline has now been stored. Run the scan again later to see changes. |
| **Error** | The website could not be fetched, or the LLM call failed. The error message is displayed. |

---

## API Reference

All endpoints are prefixed with `/api`.

### Websites

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/websites` | — | List all active monitored websites |
| `POST` | `/api/websites` | `{ url, name? }` | Add a single website |
| `POST` | `/api/websites/bulk` | `{ websites: [{url, name?}] }` | Add multiple websites at once |
| `DELETE` | `/api/websites/:id` | — | Remove (deactivate) a website |
| `GET` | `/api/websites/:id` | — | Get a website with its recent scans |

### Scans

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/scans` | `{ websiteIds: number[], periodDays: number }` | Trigger a scan |
| `GET` | `/api/scans` | `?limit=20&offset=0` | Paginated scan history |
| `GET` | `/api/scans/:id` | — | Single scan result |
| `GET` | `/api/scans/website/:websiteId` | — | All scans for one website |

### Upload

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/upload` | `multipart/form-data` field `file` | Parse an Excel/CSV file and return `{ count, websites }` |

### Utility

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Returns `{ status, llmProvider, scraperMethod }` |

---

## Troubleshooting

**Backend fails to start — `Cannot find module 'better-sqlite3'`**
Run `npm install` inside the `backend/` directory. Native modules require a working C++ build toolchain (`build-essential` on Linux, Xcode CLI tools on macOS).

**`Error: ANTHROPIC_API_KEY is not set`**
Ensure `backend/.env` exists and contains a valid key. The `.env` file is not committed to git — you must create it from `.env.example`.

**Scans return `status: error` with a network message**
- The target website may be blocking automated requests. Try enabling the Brave Search API (`BRAVE_API_KEY`) which uses Brave's indexed content rather than direct HTTP fetches.
- Check that the URL includes the `https://` prefix and is publicly accessible.

**`LLM_PROVIDER=openai` but getting Claude errors**
Make sure `OPENAI_API_KEY` is set in `.env` and that `LLM_PROVIDER` is exactly `openai` (lowercase).

**Frontend shows "Failed to load websites"**
Confirm the backend is running on port `3001`. The Vite dev server proxies `/api` requests to `http://localhost:3001` automatically.

**First scan always shows "No Changes" on the next run**
This is expected if the site's content did not change between the two scans. The snapshot from the first run becomes the baseline; a difference will only appear once the site actually updates within your chosen period.
