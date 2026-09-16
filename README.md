# Website Monitor

A self-hosted tool that uses an LLM to monitor websites for changes over a user-defined time period. It stores snapshots of website content, diffs historical against current snapshots, and summarises what changed in plain English. Supports Claude (Anthropic), OpenAI, and **any OpenAI-compatible endpoint** — including local models via Ollama or LM Studio, and hosted services such as Groq, Together AI, Mistral AI, DeepSeek, and Perplexity.

One shared username and password, set in the server's environment, protect one shared set of monitored sites. There are no accounts to manage and nothing to bill.

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
  - [Production mode (Docker)](#production-mode-docker)
- [Deploying to Railway](#deploying-to-railway)
  - [1. Push your repo to GitHub](#1-push-your-repo-to-github)
  - [2. Create a new Railway project](#2-create-a-new-railway-project)
  - [3. Add a persistent volume for SQLite](#3-add-a-persistent-volume-for-sqlite)
  - [4. Set environment variables](#4-set-environment-variables)
  - [5. Deploy](#5-deploy)
- [Environment Variables](#environment-variables)
- [Scheduled Scans & Email](#scheduled-scans--email)
- [Testing](#testing)
- [Using the Application](#using-the-application)
  - [Signing in](#signing-in)
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

It runs as a single-team tool: one shared username and password, set in the server's environment, protect one shared set of monitored sites. There is no signup and no per-user separation — anyone with the password sees everything.

---

## Features

- **Manual or bulk website entry** — add sites one by one, or upload an Excel/CSV file containing a list of URLs
- **Flexible time periods** — 30 days, 60 days, 90 days, or any custom number of days
- **Pluggable scraping providers** — choose Firecrawl (full-page clean markdown), the Brave Search API or Serper (Google Search) for indexed content/snippets, or direct HTTP scraping; selected via `SCRAPER_PROVIDER` with automatic fallback based on which API key is configured
- **Any OpenAI-compatible LLM** — works with Claude, OpenAI, Ollama, LM Studio, Groq, Together AI, Mistral AI, DeepSeek, Perplexity, and any other endpoint that speaks the OpenAI chat completions API; configured entirely via environment variables
- **Persistent snapshot storage** — every scan stores a content snapshot in SQLite so future scans always have a baseline to compare against
- **Intelligent scan statuses** — skips LLM calls when content is unchanged; handles first-time scans gracefully
- **Scan history page** — paginated log of all past scans with expandable LLM summaries
- **One shared login** — a username and password from the environment, with no accounts to manage, no signup and nothing to reset
- **Scheduled scans** — hourly, daily or weekly background scans with an email when something changes
- **Per-scan cost record** — LLM token counts and duration are stored on every scan row, so API spend can be totalled from the database
- **PDF report export** — export every structured report on the scan history page to a single PDF file

---

## How It Works

```
Add websites  →  Choose period  →  Trigger scan
                                        │
                          ┌─────────────▼──────────────┐
                          │  1. Fetch current content   │
                          │  (Firecrawl/Brave/direct)   │
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

**Subsequent scans:** The app takes the most recent snapshot at or before the start of the chosen period as its baseline, falling back to the oldest snapshot inside the period when there is nothing older. It diffs that against today's content and sends both versions plus the diff to the LLM. If the content hash is identical, the LLM call is skipped and "No changes detected" is returned.

Snapshots store the **full** page or document content, gzip-compressed, and the content hash covers all of it — a change in the later sections of a long Act or PDF is detected like any other.

**Detector engines vs. supplementary engines.** Firecrawl, the direct scraper and the PDF reader are *detectors*: they read the monitored page itself and decide whether it changed. Brave and Serper are *supplementary*: they query a search index, so their results appear in the report as related news and announcements but never set the scan's verdict on their own. A website configured with search engines only is given the direct scraper as well, so something is always reading the page. Search queries are scoped to the monitored URL's path (`inurl:`), so two pages on the same host do not receive identical results.

**Failures are failures, not content.** A scrape that cannot produce trustworthy content — an exhausted search quota, an empty Firecrawl response, an unreachable page — records that engine as an error and writes no snapshot. Nothing is stored that would diff against the real page once the site recovers.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 18+ |
| Backend framework | Express 4 |
| Database | SQLite via `better-sqlite3` (no server required) |
| Web scraping | Firecrawl API · Brave Search API · Serper Search API · axios + cheerio (fallback) |
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
├── .github/workflows/ci.yml    ← backend tests, frontend build, Docker build
├── backend/
│   ├── .env.example            ← copy to .env and fill in keys
│   ├── package.json
│   ├── vitest.config.mjs
│   ├── tests/                  ← auth, access, migration, scheduler, scraper,
│   │                             snapshot, diff and scan-service suites
│   └── src/
│       ├── server.js           ← Express entry point
│       ├── bootstrap.js        ← account seed, ownership migration
│       ├── db/
│       │   ├── index.js        ← SQLite connection and pragmas
│       │   └── migrations.js   ← schema + the one-time ownership rebuild
│       ├── middleware/
│       │   ├── auth.js         ← requireAuth
│       │   └── rateLimit.js    ← per-IP caps; the login limit matters most
│       ├── repositories/       ← all owner-scoped SQL lives here; the single
│       │   │                     place a Postgres move would land
│       │   ├── userRepo.js         websiteRepo.js    scanRepo.js
│       │   └── scheduleRepo.js
│       ├── routes/
│       │   ├── auth.js         ← the shared login
│       │   ├── websites.js     ← CRUD for monitored sites
│       │   ├── scans.js        ← scan results and triggering
│       │   ├── schedules.js    ← automatic scan cadences
│       │   ├── upload.js       ← Excel / CSV upload endpoint
│       │   └── database.js     ← backup and restore
│       └── services/
│           ├── scanService.js      ← scan orchestration
│           ├── scheduler.js        ← background scans and retention pruning
│           ├── accountService.js   ← hashing, JWT, account seed
│           ├── mailer.js           ← SMTP (logs when unconfigured)
│           ├── emails.js           ← the change-alert template
│           ├── scraper.js      ← Firecrawl / Brave / Serper / axios+cheerio
│           ├── snapshotService.js  ← save / retrieve snapshots
│           ├── diffService.js      ← compute line diff
│           ├── reportPdf.js        ← markdown → PDF
│           └── llmService.js       ← Claude / any OpenAI-compatible endpoint
└── frontend/
    ├── index.html
    ├── vite.config.js          ← proxies /api → localhost:3001
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx             ← routing + header
        ├── api/
        │   └── client.js       ← all backend calls; 401 interceptor
        ├── context/
        │   ├── AuthContext.jsx ← is the session valid, and who is signed in
        │   └── ScanContext.jsx ← batch scan progress across navigation
        ├── components/
        │   ├── AddWebsiteForm.jsx   ExcelUpload.jsx    PeriodSelector.jsx
        │   └── WebsiteList.jsx      ScanResultCard.jsx DataBackup.jsx
        └── pages/
            ├── Dashboard.jsx        History.jsx        ReportPage.jsx
            ├── LoginPage.jsx        SchedulesPage.jsx
            └── HelpPage.jsx
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18 or later | https://nodejs.org |
| npm | 8 or later | bundled with Node.js |
| LLM API key | — | One of: Anthropic, OpenAI, Groq, Together AI, Mistral, etc. — or none for local models (Ollama/LM Studio) |
| Firecrawl API key | — | Optional — full-page markdown scraping, https://firecrawl.dev |
| Brave Search API key | — | Optional — indexed search content, https://api.search.brave.com |
| Serper API key | — | Optional — indexed search content (alternative to Brave), https://serper.dev |

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

Open `backend/.env` in a text editor. Pick one of the configuration examples below and fill in your keys.

**Option A — Claude (Anthropic)**
```dotenv
LLM_PROVIDER=claude
LLM_MODEL=claude-opus-4-6          # or claude-sonnet-4-6, etc.
ANTHROPIC_API_KEY=sk-ant-...
```

**Option B — OpenAI**
```dotenv
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o                   # or gpt-4-turbo, gpt-3.5-turbo, etc.
OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=                 # leave blank for OpenAI's default endpoint
```

**Option C — Ollama (local, no API key needed)**
```dotenv
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2                 # any model you have pulled locally
OPENAI_API_KEY=ollama              # placeholder — Ollama does not check it
OPENAI_BASE_URL=http://localhost:11434/v1
```

**Option D — LM Studio (local)**
```dotenv
LLM_PROVIDER=lmstudio
LLM_MODEL=mistral-7b-instruct      # match the model loaded in LM Studio
OPENAI_API_KEY=lm-studio           # placeholder
OPENAI_BASE_URL=http://localhost:1234/v1
```

**Option E — Groq**
```dotenv
LLM_PROVIDER=groq
LLM_MODEL=llama-3.1-70b-versatile  # or mixtral-8x7b-32768, gemma2-9b-it, etc.
OPENAI_API_KEY=gsk_...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
```

**Option F — Mistral AI**
```dotenv
LLM_PROVIDER=mistral
LLM_MODEL=mistral-large-latest
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.mistral.ai/v1
```

**Option G — Together AI**
```dotenv
LLM_PROVIDER=together
LLM_MODEL=meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.together.xyz/v1
```

**Option H — DeepSeek**
```dotenv
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.deepseek.com/v1
```

Choose a scraping provider and add the matching API key, then leave the SQLite path as-is:
```dotenv
# Pick one: firecrawl | brave | serper | auto (default: auto)
SCRAPER_PROVIDER=auto

# Firecrawl — full-page clean markdown (richer diffs)
FIRECRAWL_API_KEY=fc-...

# Brave Search API — indexed content/snippets
BRAVE_API_KEY=BSA...

# Serper (Google Search API) — indexed content/snippets (alternative to Brave)
SERPER_API_KEY=...

DB_PATH=./data/monitor.db
```

> **Tip:** With `SCRAPER_PROVIDER=auto`, the app uses Firecrawl if `FIRECRAWL_API_KEY` is set, otherwise Brave if `BRAVE_API_KEY` is set, otherwise Serper if `SERPER_API_KEY` is set, otherwise it falls back to fetching pages directly with HTTP (axios + cheerio). Some sites may block automated requests in the direct mode.

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
   LLM model    : claude-opus-4-6
   LLM base URL : https://api.anthropic.com
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

### Production mode (Docker)

The included `Dockerfile` performs a multi-stage build: it builds the React app in one stage, then copies the compiled assets into the Express container. Express serves the static files automatically when `NODE_ENV=production`.

```bash
# Build the image
docker build -t website-monitor .

# Run with a local volume for the SQLite database
docker run -p 3001:3001 \
  -v "$(pwd)/data:/data" \
  -e NODE_ENV=production \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=your-password \
  -e JWT_SECRET=your-random-secret \
  -e LLM_PROVIDER=claude \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SCRAPER_PROVIDER=auto \
  -e FIRECRAWL_API_KEY=fc-... \
  -e BRAVE_API_KEY=BSA... \
  website-monitor
```

Open http://localhost:3001 — Express serves both the API and the React frontend on the same port.

---

## Deploying to Railway

Railway runs the `Dockerfile` at the repo root and injects environment variables from the dashboard. The app runs as a single service (API + frontend on one port).

### 1. Push your repo to GitHub

```bash
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### 2. Create a new Railway project

1. Go to [railway.com](https://railway.com) and sign in.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select your repository. Railway detects the `Dockerfile` automatically via `railway.toml`.

### 3. Add a persistent volume for SQLite

SQLite stores data on disk. Without a persistent volume the database resets on every deploy.

1. In your Railway service, go to **Settings** → **Volumes**.
2. Click **Add Volume**.
3. Set **Mount Path** to `/data`.
4. Railway will retain `/data` across deploys and restarts.

### 4. Set environment variables

In your Railway service go to **Variables** and add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `AUTH_USERNAME` | the sign-in name (e.g. `admin`) |
| `AUTH_PASSWORD` | the sign-in password — **required**, nobody can sign in without it |
| `JWT_SECRET` | a long random string (generate with the command below) |
| `JWT_EXPIRES_IN` | `24h` *(or `7d`, `30d`, etc.)* |
| `LLM_PROVIDER` | `claude` *(or your chosen provider)* |
| `LLM_MODEL` | *(optional — uses provider default if omitted)* |
| `ANTHROPIC_API_KEY` | `sk-ant-...` *(if using Claude)* |
| `OPENAI_API_KEY` | `sk-...` *(if using an OpenAI-compatible provider)* |
| `OPENAI_BASE_URL` | *(if using a non-OpenAI endpoint)* |
| `SCRAPER_PROVIDER` | `auto` *(or `firecrawl` / `brave` / `serper`)* |
| `FIRECRAWL_API_KEY` | `fc-...` *(if using Firecrawl)* |
| `BRAVE_API_KEY` | `BSA...` *(if using Brave)* |
| `SERPER_API_KEY` | `...` *(if using Serper)* |
| `DB_PATH` | `/data/monitor.db` |

> `PORT` is set automatically by Railway — do not add it manually.

Generate a secure `JWT_SECRET` locally and paste the output into Railway:
> ```bash
> node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
> ```

### 5. Deploy

Click **Deploy** (or push a new commit — Railway redeploys automatically on every push to the linked branch).

Once the build completes, Railway provides a public URL such as `https://your-app.up.railway.app`. The health check endpoint `/api/health` is used by Railway to confirm the service is ready.

---

## Environment Variables

All variables are set in `backend/.env`.

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `3001` | No | Port the Express server listens on |
| `APP_URL` | `http://localhost:5173` | For email | Public URL of the app. Used for links in change alerts, and the allowed CORS origin in production |
| **`AUTH_USERNAME`** | `admin` | No | The sign-in name |
| **`AUTH_PASSWORD`** | — | **Yes** | The sign-in password. Nobody can sign in until it is set; changing it takes effect on restart |
| **`JWT_SECRET`** | `change-me-in-production` | **Yes** | Secret used to sign session tokens. The server refuses to start in production if this is unset or default |
| **`JWT_EXPIRES_IN`** | `24h` | No | Session duration e.g. `12h`, `7d`, `30d` |
| `DISABLE_RATE_LIMIT` | `false` | No | Turn off request rate limiting. Local development and tests only |
| `ENABLE_SCHEDULER` | on in production | No | Run background scheduled scans |
| `HISTORY_RETENTION_DAYS` | — | No | Delete scans and snapshot bodies older than this, swept daily. Unset keeps everything |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | No | Outgoing mail. Without `SMTP_HOST`, messages are logged instead of sent |
| `LLM_TIMEOUT_MS` | `120000` | No | Give up on an LLM call after this long, so one hung request cannot stall a scheduled batch |
| `LLM_PROVIDER` | `claude` | Yes | `claude` → Anthropic SDK. Any other value → OpenAI-compatible SDK |
| `LLM_MODEL` | see below | No | Model name to use. Defaults to `claude-opus-4-6` (Claude) or `gpt-4o` (all others) |
| `ANTHROPIC_API_KEY` | — | When `LLM_PROVIDER=claude` | API key from https://console.anthropic.com |
| `OPENAI_API_KEY` | — | For hosted services | API key. Set to any non-empty string for local models that don't require auth |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | No | Base URL for the OpenAI-compatible endpoint (see provider table below) |
| `SCRAPER_PROVIDER` | `auto` | No | Scraper to use: `firecrawl`, `brave`, `serper`, or `auto`. `auto` picks Firecrawl, then Brave, then Serper, then direct scraping based on which key is set |
| `FIRECRAWL_API_KEY` | — | No | API key from https://firecrawl.dev — enables full-page markdown scraping |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev/v1` | No | Override the Firecrawl API base (e.g. self-hosted instance) |
| `BRAVE_API_KEY` | — | No | API key from https://api.search.brave.com — enables indexed search content |
| `SERPER_API_KEY` | — | No | API key from https://serper.dev — enables indexed search content (alternative to Brave) |
| `DB_PATH` | `./data/monitor.db` | No | Path to the SQLite database file |

> **Generate a secure `JWT_SECRET`:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
> ```

### Supported LLM Providers

| Provider | `LLM_PROVIDER` | `OPENAI_BASE_URL` | Key required |
|---|---|---|---|
| Anthropic Claude | `claude` | *(N/A)* | Yes — `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | *(omit)* | Yes — `OPENAI_API_KEY` |
| Ollama (local) | any, e.g. `ollama` | `http://localhost:11434/v1` | No (set placeholder) |
| LM Studio (local) | any, e.g. `lmstudio` | `http://localhost:1234/v1` | No (set placeholder) |
| Groq | `groq` | `https://api.groq.com/openai/v1` | Yes |
| Together AI | `together` | `https://api.together.xyz/v1` | Yes |
| Mistral AI | `mistral` | `https://api.mistral.ai/v1` | Yes |
| DeepSeek | `deepseek` | `https://api.deepseek.com/v1` | Yes |
| Perplexity | `perplexity` | `https://api.perplexity.ai` | Yes |
| Azure OpenAI | `azure` | `https://<resource>.openai.azure.com/openai/deployments/<deploy>` | Yes |
| Any other | any label | your endpoint URL | Depends on provider |

---

## Scheduled Scans & Email

### Scheduled scans

Background scans run in-process on a five-minute tick (`node-cron`), enabled by
default in production and off elsewhere so `npm run dev` does not spend API
credit. There is no queue or worker process: the deployment is a single
container, and a broker would be infrastructure without a problem to solve.

Due schedules are claimed by advancing `next_run_at` inside the same transaction
that reads them, so a restart mid-scan **skips** the run rather than repeating
it. A scan costs real money; running one twice is worse than missing one.

Every scan costs real money in LLM and scraper API calls, so pick the slowest
cadence that still catches what you need. The token counts and duration of each
scan are stored on its `scan_results` row, so spend can be totalled from the
database.

A daily job prunes history older than `HISTORY_RETENTION_DAYS`, blanking old
snapshot bodies. Leave it unset to keep everything — but snapshot bodies are the
bulk of the database, so on a long-running instance it is what stops the file
growing without bound.

### Email

Any SMTP provider works (Resend, SendGrid, SES, Postmark, Mailgun). **When
`SMTP_HOST` is unset, messages are logged instead of sent** — scanning keeps
working, it just does not deliver mail. That is also how you turn alerts off.

One message is sent: *changes detected* after a scheduled scan, carrying the
summary and a link to the full report.

---

## Upgrading from the subscription version

If you are coming from the version with per-user accounts and billing, the
change is picked up on first boot and needs no migration:

- Sign-in moves back to `AUTH_USERNAME` / `AUTH_PASSWORD`. Unlike before, these
  now **are** the credentials rather than a seed, so changing `AUTH_PASSWORD`
  and restarting takes effect immediately.
- The account that owned the data keeps owning it; nothing moves. If several
  accounts had data, only the oldest account's is reachable — export the others
  from the old version first if you need them.
- `STRIPE_*`, `PAYPAL_*`, `BILLING_GRACE_DAYS` and `REQUIRE_EMAIL_VERIFICATION`
  are no longer read and can be removed.
- The `plans`, `subscriptions`, `usage_counters`, `payments` and
  `webhook_events` tables are still created but never written to. Dropping
  tables in SQLite is one-way, so they are simply left alone.

---

## Testing

```bash
cd backend
npm test          # vitest, ~110 tests
npm run test:watch
```

Each suite runs against its own throwaway SQLite file. Coverage concentrates on
the things that would be expensive to get wrong:

| Suite | What it pins |
|---|---|
| `tests/auth.test.js` | The shared login: right credentials in, everything else out, and a token required everywhere past `/api/auth` |
| `tests/access.test.js` | Owner-scoped reads, and that no protected route answers without a token |
| `tests/migration.test.js` | The ownership rebuild against a realistic legacy database |
| `tests/scheduler.test.js` | Claiming due work exactly once, and the schedule lifecycle |
| `tests/snapshotService.test.js` | Baseline selection and full-content storage |
| `tests/scraper.test.js` | Search normalisation, page scoping, and failures that throw rather than being snapshotted |
| `tests/scanService.test.js` | Engine resolution and row-level status aggregation |
| `tests/diffService.test.js` | Diff truncation being explicit rather than silent |

CI (`.github/workflows/ci.yml`) runs the backend tests, the frontend build, and
a Docker build of the production image on every push.

---

## Using the Application

### Signing in

There is one login for the whole deployment, set by whoever runs it with
`AUTH_USERNAME` and `AUTH_PASSWORD`. There is no signup, no password reset and
no per-user separation: anyone with the password sees every monitored site and
every report, and can add, scan and delete.

Credentials are compared against the environment, not against anything stored in
the database, so rotating the password is a config change and a restart. The
login endpoint is rate limited per IP — with a single shared password, that is
what makes brute-forcing impractical, so leave `DISABLE_RATE_LIMIT` off in
production.

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

Use **Export reports (PDF)** in the top-right of the page to download all of the structured reports currently in view (the search filter is respected) as a single PDF file.

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
| **Partial** | At least one engine failed while another produced a report. The report is real but incomplete; the failing engine and its error are recorded on the scan. |
| **No Changes** | Content hash is identical to the baseline snapshot; no LLM call was made. |
| **First Scan** | No usable historical snapshot existed for this engine; a baseline has now been stored. Run the scan again later to see changes. |
| **Error** | The website could not be fetched, or the LLM call failed. The error message is displayed. |

Per-engine outcomes are stored as JSON on `scan_results.engine_statuses`, so a **Partial** scan says which engine failed without that being buried in the report text.

### After upgrading

Snapshots taken before this version were truncated at 14,000 characters and stored search results in an unnormalised form, so they cannot be compared against current ones without reporting the whole page as changed. They are not used as baselines. Each website reports **First Scan** once after the upgrade and then resumes normal comparison.

---

## API Reference

All endpoints are prefixed with `/api`. Everything except `/api/health` and
`/api/auth/*` requires a bearer token.

Reads and writes are scoped to the account that owns the data. An id belonging
to another owner returns **404**, never 403 — a 403 would confirm the row
exists.

Status codes worth handling: **401** not signed in · **404** not found.

### Authentication

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | `{ username, password }` | Sign in with the shared credentials |
| `GET` | `/api/auth/me` | — | The signed-in username |
| `POST` | `/api/auth/logout` | — | Client-side only |

### Websites

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/websites` | — | The caller's active websites |
| `POST` | `/api/websites` | `{ url, name?, domain?, srms_owner?, srms? }` | Add a website |
| `POST` | `/api/websites/bulk` | `{ websites: [{url, name?}] }` | Add many; the whole batch is checked up front |
| `PATCH` | `/api/websites/:id` | `{ use_firecrawl?, use_brave?, use_serper?, remark?, name? }` | Update engine flags / remark / name |
| `DELETE` | `/api/websites/:id` | — | Remove (deactivate) a website |
| `POST` | `/api/websites/bulk-delete` | `{ ids: number[] }` | Remove many |
| `POST` | `/api/websites/bulk-update` | `{ ids?, updates }` | Apply engine flags; omitting `ids` targets the caller's own sites |
| `GET` | `/api/websites/export` | — | Export as `.xlsx` **(Business)** |
| `GET` | `/api/websites/:id` | — | One website with its recent scans |

### Scans

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/scans` | `{ websiteIds: number[], periodDays: number }` | Trigger a scan |
| `GET` | `/api/scans` | `?limit=20&offset=0` | Paginated scan history |
| `GET` | `/api/scans/export-pdf` | `?ids=1,2,3` (optional) | Export the caller's reports as one PDF **(Pro)** |
| `GET` | `/api/scans/:id` | — | Single scan result |
| `PATCH` | `/api/scans/:id` | `{ remark }` | Save a remark on a scan |
| `GET` | `/api/scans/website/:websiteId` | — | All scans for one website |

### Schedules

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/schedules` | — | Current schedules and the available cadences |
| `PUT` | `/api/schedules/:websiteId` | `{ frequency, periodDays?, isEnabled? }` | Create or update a schedule **(Pro/Business)** |
| `DELETE` | `/api/schedules/:websiteId` | — | Stop scanning automatically |

### Data

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/upload` | `multipart/form-data` field `file` | Parse an Excel/CSV file **(Business)** |
| `GET` | `/api/database/my-data` | — | Websites and scans as JSON |
| `GET` | `/api/database/export` | — | The whole SQLite file |
| `POST` | `/api/database/import` | `?confirm=replace-all-data` + file | Replace **all** data |

### Utility

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | `{ status, llmProvider, llmModel, llmBaseUrl, scraperMethod, schedulerEnabled }` |

---

## Troubleshooting

**Backend fails to start — `Cannot find module 'better-sqlite3'`**
Run `npm install` inside the `backend/` directory. Native modules require a working C++ build toolchain (`build-essential` on Linux, Xcode CLI tools on macOS).

**`Error: ANTHROPIC_API_KEY is not set`**
Ensure `backend/.env` exists and `LLM_PROVIDER=claude` with a valid `ANTHROPIC_API_KEY`. The `.env` file is never committed — create it from `.env.example`.

**Ollama / LM Studio scan returns an LLM error**
- Confirm the local server is running (`ollama serve` or LM Studio's server tab).
- Verify `OPENAI_BASE_URL` matches the port shown by the local server.
- Ensure `LLM_MODEL` matches a model you have actually downloaded (e.g. `ollama pull llama3.2`).
- `OPENAI_API_KEY` must be set to a non-empty string even if the value is ignored (e.g. `OPENAI_API_KEY=ollama`).

**Groq / Together / Mistral returns a 401 error**
Double-check that `OPENAI_API_KEY` contains the correct API key for that provider, and that `OPENAI_BASE_URL` matches the provider's documented base URL exactly (no trailing slash).

**Scans return `status: error` with a network message**
- The target website may be blocking automated requests. Try enabling Firecrawl (`FIRECRAWL_API_KEY`), which renders the page and returns clean markdown, or a search API — Brave (`BRAVE_API_KEY`) or Serper (`SERPER_API_KEY`) — which uses indexed content rather than direct HTTP fetches.
- Check that the URL includes the `https://` prefix and is publicly accessible.

**Frontend shows "Failed to load websites"**
Confirm the backend is running on port `3001`. The Vite dev server proxies `/api` requests to `http://localhost:3001` automatically.

**`Refusing to start in production — JWT_SECRET is unset or still the default`**
Generate one and set it: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. The check only fails the boot when `NODE_ENV=production`; elsewhere it warns.

**Signup works but no email arrives**
`SMTP_HOST` is probably unset, in which case messages are logged rather than sent — look for `📧 [mail not configured]` in the server output. Confirmation links can also be read straight from the `users.verify_token` column while testing.

**Sign-in returns 500 "Server is not configured for authentication"**
`AUTH_PASSWORD` is not set. The server refuses to let anyone in rather than treating an unset password as a match.

**Sign-in returns 401 with the password you just changed**
The password is read from the environment at request time, but the process has to pick up the new value — restart the server (or redeploy) after changing `AUTH_PASSWORD`.

**Everything returns 429**
The rate limiter is keyed per client IP: 20 sign-in attempts per 15 minutes, 120 API requests per minute. Behind a proxy that does not set `X-Forwarded-For`, every request looks like one client.

**Scheduled scans never run**
`ENABLE_SCHEDULER` defaults to on only in production. Set `ENABLE_SCHEDULER=true` elsewhere. `GET /api/health` reports `schedulerEnabled`.

**Not sure which LLM is active?**
Call `GET /api/health`. The response includes `llmProvider`, `llmModel`, and `llmBaseUrl` so you can confirm the exact configuration that is in use.

**First scan always shows "No Changes" on the next run**
This is expected if the site's content did not change between the two scans. The snapshot from the first run becomes the baseline; a difference will only appear once the site actually updates within your chosen period.
