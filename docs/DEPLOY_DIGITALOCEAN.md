# Deploying to a DigitalOcean Basic Droplet

This guide sets up Website Monitor on a single DigitalOcean **Basic** droplet. You
build it and run it there with Docker Compose. When you're done you have:

- the app (API and React frontend) running in one container, from the repo's
  `Dockerfile`
- [Caddy](https://caddyserver.com) in front of it. Caddy gets a free Let's Encrypt
  HTTPS certificate for your domain and renews it on its own
- the SQLite database stored on the droplet's disk in `data/`, so it survives
  rebuilds and restarts
- a firewall that lets in only SSH, HTTP and HTTPS
- scripts for updates and daily database backups

```
Internet ──► :80 / :443  Caddy (HTTPS) ──► app:3001  Express API + frontend
                                               │
                                               └── ./data/monitor.db  (SQLite on the droplet disk)
```

These files are used:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Runs the `app` and `caddy` services |
| `deploy/Caddyfile` | Reverse proxy and automatic HTTPS |
| `.env.production.example` | Template for the production `.env` |
| `deploy/digitalocean/setup-droplet.sh` | One-time droplet setup: Docker, swap, firewall |
| `deploy/digitalocean/update.sh` | Pull, back up, rebuild, restart |
| `deploy/digitalocean/backup.sh` | Takes a consistent SQLite backup while the app runs |

---

## Contents

1. [Before you start](#1-before-you-start)
2. [Create the droplet](#2-create-the-droplet)
3. [Point your domain at the droplet (optional)](#3-point-your-domain-at-the-droplet-optional)
4. [Connect and get the code](#4-connect-and-get-the-code)
5. [Prepare the droplet](#5-prepare-the-droplet)
6. [Configure the environment](#6-configure-the-environment)
7. [Build and start](#7-build-and-start)
8. [Verify the deployment](#8-verify-the-deployment)
9. [Switch from HTTP to HTTPS later](#9-switch-from-http-to-https-later)
10. [Updating to a new version](#10-updating-to-a-new-version)
11. [Backups and restore](#11-backups-and-restore)
12. [Day-to-day operations](#12-day-to-day-operations)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Before you start

You need:

- A **DigitalOcean account**: https://cloud.digitalocean.com
- An **SSH key** on your computer. Run `ls ~/.ssh/id_*.pub` to check. To create
  one, run `ssh-keygen -t ed25519`.
- An **LLM API key**, for example from Anthropic (https://console.anthropic.com),
  OpenAI or Groq. See the main [README](../README.md#supported-llm-providers).
- *(Optional)* A **domain name** you control, for HTTPS. Without one, the app runs
  over plain HTTP on the droplet's IP address. That is fine for a trial, but don't
  use it for real data: the password is sent unencrypted.
- *(Optional)* Scraper API keys (Firecrawl, Brave or Serper) and SMTP details for
  email alerts.

## 2. Create the droplet

1. In the DigitalOcean control panel, click **Create → Droplets**.
2. **Region**: pick the one closest to you or to the sites you monitor.
3. **Image**: **Ubuntu 24.04 (LTS) x64**. A newer Ubuntu LTS also works.
4. **Size**: **Basic → Regular (SSD)**.
   - **1 GB RAM / 1 vCPU / 25 GB disk** is recommended. It runs the app comfortably.
     The setup script adds 2 GB of swap so the image build fits in memory.
   - The 512 MB plan can work too, thanks to the swap file, but builds are slow.
     It's tight once scans run.
5. **Authentication**: choose **SSH Key** and add your public key
   (`cat ~/.ssh/id_ed25519.pub`). This is safer than a password.
6. *(Recommended)* Turn on **Backups** for automatic weekly droplet snapshots.
7. Give it a hostname, such as `website-monitor`, and click **Create Droplet**.

Write down the droplet's **public IPv4 address** (`203.0.113.10` in the examples
below).

> Port 25 (SMTP) is blocked on droplets by default. Use port **587** or **465**
> with your mail provider. The production `.env` template already does.

## 3. Point your domain at the droplet (optional)

Skip this step if you'll use the IP address for now. You can add a domain later
([step 9](#9-switch-from-http-to-https-later)).

At your DNS provider (or **Networking → Domains** in DigitalOcean), create an
**A record**:

| Type | Hostname | Value |
|---|---|---|
| A | `monitor` (for `monitor.example.com`) or `@` | `203.0.113.10` |

> **No domain?** A free afraid.org subdomain works too. See
> [domain.md](../domain.md).

Check that it resolves **before** you start the stack. Caddy needs the name to
point at the droplet to get a certificate:

```bash
dig +short monitor.example.com     # should print 203.0.113.10
```

## 4. Connect and get the code

From your computer:

```bash
ssh root@203.0.113.10
```

On the droplet:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/yeokiwi/LLM_-website_monitor-.git /opt/website-monitor
cd /opt/website-monitor
```

> **Private repository?** Plain `git clone` over HTTPS will ask for credentials.
> Either use a GitHub
> [personal access token](https://github.com/settings/tokens) (fine-grained,
> read-only *Contents* on this repo) as the password, or add a
> [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys):
> run `ssh-keygen -t ed25519` on the droplet, add `~/.ssh/id_ed25519.pub` to the
> repo under **Settings → Deploy keys**, and clone with
> `git@github.com:yeokiwi/LLM_-website_monitor-.git`.

## 5. Prepare the droplet

Run the one-time setup script. It installs updates, Docker Engine and the Compose
plugin, adds a 2 GB swap file, and turns on the `ufw` firewall (SSH, 80 and 443
only). It's safe to run again.

```bash
bash deploy/digitalocean/setup-droplet.sh
```

To check that the setup worked:

```bash
docker --version && docker compose version
swapon --show
ufw status
```

## 6. Configure the environment

```bash
cd /opt/website-monitor
cp .env.production.example .env
chmod 600 .env
openssl rand -hex 48        # copy the output for JWT_SECRET
nano .env
```

Set at least the following:

| Variable | What to put |
|---|---|
| `DOMAIN` | `monitor.example.com` for HTTPS, or leave it as `:80` for plain HTTP on the IP |
| `APP_URL` | `https://monitor.example.com`, or `http://203.0.113.10` while `DOMAIN=:80`. Links in alert emails use it |
| `AUTH_USERNAME` | The sign-in name, e.g. `admin` |
| `AUTH_PASSWORD` | **Required.** A strong password. Nobody can sign in until it's set |
| `JWT_SECRET` | **Required.** The `openssl rand -hex 48` output. The app won't start without it |
| `LLM_PROVIDER` / `LLM_MODEL` | e.g. `claude` with an empty `LLM_MODEL` for the default, or `openai` and `gpt-4o` |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) | The key for your provider |
| `SCRAPER_PROVIDER` + key | `auto` plus any of `FIRECRAWL_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`. With no key it scrapes directly |
| `SMTP_*` | Optional, for alert emails. Without `SMTP_HOST`, alerts are only logged |
| `HISTORY_RETENTION_DAYS` | Defaults to `180` in the template, so the database doesn't fill the 25 GB disk. Leave it blank to keep everything |

`NODE_ENV`, `PORT` and `DB_PATH` are fixed in `docker-compose.yml`. Don't set them
in `.env`. The full variable reference is in
[`backend/.env.example`](../backend/.env.example) and the
[README](../README.md#environment-variables).

> `.env` is git-ignored and Docker-ignored. It never ends up in a commit or in the
> image. Keep it readable only by root (`chmod 600 .env`).

## 7. Build and start

```bash
cd /opt/website-monitor
docker compose up -d --build
```

The first build takes a few minutes on a 1 GB droplet: it installs npm packages and
builds the frontend. The build downloads from `registry.npmjs.org` and
`cdn.sheetjs.com` (see the README's note on `xlsx`). Both are reachable from a
droplet by default.

Compose starts `app` first and waits for its health check to pass. Then it starts
`caddy`. Both containers restart on their own after a crash or a droplet reboot
(`restart: unless-stopped`).

## 8. Verify the deployment

```bash
docker compose ps                      # app should show "(healthy)"
docker compose logs -f app             # Ctrl+C to stop following
curl -s http://localhost/api/health    # or https://monitor.example.com/api/health
```

The startup log should show your provider, the scraper and `Scheduler : enabled`:

```
🚀 Website Monitor backend running on http://localhost:3001
   LLM provider : claude
   ...
   Scheduler   : enabled (every 5 minutes)
```

Open `https://monitor.example.com` (or `http://203.0.113.10`) in a browser and sign
in with `AUTH_USERNAME` / `AUTH_PASSWORD`. Then:

1. Add a website, or import a spreadsheet.
2. Run a scan to confirm that the LLM and scraper keys work.
3. If you set up SMTP, use **Send test email** on the Schedules page.

## 9. Switch from HTTP to HTTPS later

1. Create the DNS A record ([step 3](#3-point-your-domain-at-the-droplet-optional))
   and wait until `dig +short your.domain` returns the droplet IP.
2. Edit `.env`: set `DOMAIN=monitor.example.com` and
   `APP_URL=https://monitor.example.com`.
3. Apply the change:

   ```bash
   docker compose up -d
   docker compose logs -f caddy   # look for "certificate obtained successfully"
   ```

Caddy redirects HTTP to HTTPS and renews the certificate on its own. Certificates
are kept in the `caddy_data` Docker volume.

## 10. Updating to a new version

```bash
cd /opt/website-monitor
bash deploy/digitalocean/update.sh
```

The script does four things:

1. Runs `git pull --ff-only` on the current branch. To deploy a specific branch,
   run `BRANCH=main bash deploy/digitalocean/update.sh`.
2. Backs up the database, so you have a copy from before the new code runs its
   migrations.
3. Rebuilds the image and restarts the containers (`docker compose up -d --build`).
4. Removes old, unused images to save disk space.

The site is down for a few seconds while the new container starts.

If you changed only `.env`, you don't need a rebuild. Run `docker compose up -d`
to recreate the container with the new values.

## 11. Backups and restore

### Taking backups

```bash
bash deploy/digitalocean/backup.sh          # keeps the newest 14 copies
KEEP=30 bash deploy/digitalocean/backup.sh  # keep more
```

This uses SQLite's online backup API inside the running container. It's safe while
scans are writing, which copying `monitor.db` directly isn't. The copies go to
`data/backups/monitor-<timestamp>.db`.

To run it every night at 03:15, open root's crontab with `crontab -e` and add:

```cron
15 3 * * * cd /opt/website-monitor && bash deploy/digitalocean/backup.sh >> /var/log/website-monitor-backup.log 2>&1
```

These copies are on the same disk as the database. Also copy them off the droplet.
You can turn on droplet **Backups** in the control panel, or download a copy from
your computer:

```bash
scp root@203.0.113.10:/opt/website-monitor/data/backups/monitor-*.db ./
```

The app also has an export and import feature on its **Backup** page. See the
[README](../README.md#backing-up-and-restoring).

### Restoring a backup file

```bash
cd /opt/website-monitor
docker compose stop app
cp data/monitor.db data/monitor.db.before-restore       # just in case
rm -f data/monitor.db-wal data/monitor.db-shm
cp data/backups/monitor-20261025T031500Z.db data/monitor.db
docker compose start app
```

## 12. Day-to-day operations

| Task | Command (run in `/opt/website-monitor`) |
|---|---|
| Status | `docker compose ps` |
| App logs | `docker compose logs -f --tail=200 app` |
| Proxy / TLS logs | `docker compose logs -f caddy` |
| Restart | `docker compose restart app` |
| Stop everything | `docker compose down` (the data in `./data` is kept) |
| Start again | `docker compose up -d` |
| Apply `.env` changes | `docker compose up -d` |
| Disk usage | `df -h /` and `du -sh data` |
| Free Docker space | `docker system prune -f` |
| OS updates | `apt-get update && apt-get upgrade -y`, then `reboot` if asked |

Ubuntu installs security updates on its own (`unattended-upgrades`). After a
reboot, the containers come back up by themselves.

Log files are capped at 3 × 10 MB per container, so they can't fill the disk.

## 13. Troubleshooting

**The build is killed or says `JavaScript heap out of memory`.**
The droplet ran out of memory. Check that swap is on with `swapon --show`. If it
isn't, run `bash deploy/digitalocean/setup-droplet.sh` again. You can also pick a
bigger swap file with `SWAP_SIZE=4G` on a new droplet, or resize the droplet.

**`npm error 403` / `ETIMEDOUT` for `cdn.sheetjs.com` during the build.**
The build needs to reach `cdn.sheetjs.com` as well as the npm registry. Check the
droplet's outbound network or any DigitalOcean Cloud Firewall rules you added.

**`app` keeps restarting with `Refusing to start in production — JWT_SECRET ...`.**
`JWT_SECRET` in `.env` is empty or still the default. Set it with
`openssl rand -hex 48`, then run `docker compose up -d`.

**Sign-in fails with "Server is not configured for authentication".**
`AUTH_PASSWORD` is empty in `.env`. Set it and run `docker compose up -d`.

**The browser can't connect at all.**
- Run `docker compose ps`. Both containers should be `Up`.
- Run `ufw status`. 80/tcp and 443/tcp should be `ALLOW`. If you also added a
  DigitalOcean **Cloud Firewall**, it needs inbound 80 and 443 too.

**HTTPS doesn't work, or Caddy logs say it couldn't get a certificate.**
- `dig +short $DOMAIN` must return this droplet's IP.
- Ports 80 and 443 must be reachable from the internet. Let's Encrypt validates
  over them.
- After several failed attempts Let's Encrypt rate-limits you for a while. Fix
  DNS first, then run `docker compose restart caddy`.

**Every request returns 429.**
The rate limiter keys on the client IP that Caddy forwards. Don't publish the
app's port 3001 directly. Go through Caddy, as `docker-compose.yml` does.

**Alert emails never arrive.**
Port 25 is blocked on droplets. Use `SMTP_PORT=587` (with `SMTP_SECURE=false`) or
`465` (with `SMTP_SECURE=true`). Also see the README's
[Scheduled Scans & Email](../README.md#scheduled-scans--email) section about
recipients.

**The disk is filling up.**
Set `HISTORY_RETENTION_DAYS` in `.env`, then run `docker compose up -d`. Prune old
images with `docker system prune -f` and remove old copies in `data/backups/`.
