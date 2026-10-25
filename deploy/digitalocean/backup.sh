#!/usr/bin/env bash
#
# Write a consistent copy of the SQLite database to data/backups/ while the app
# keeps running, and keep the newest KEEP copies (default 14).
#
#   bash deploy/digitalocean/backup.sh
#
# Schedule it daily with cron (crontab -e, as root):
#
#   15 3 * * * cd /opt/website-monitor && bash deploy/digitalocean/backup.sh >> /var/log/website-monitor-backup.log 2>&1
#
# The copies live on the droplet's own disk; download them, or enable droplet
# backups, so that losing the droplet does not lose them too.

set -euo pipefail

KEEP="${KEEP:-14}"

cd "$(dirname "$0")/../.."

# Runs inside the app container, which owns data/: SQLite's online backup API
# through the better-sqlite3 module already in the image is safe while scans
# are writing, unlike copying the file.
docker compose exec -T -e KEEP="${KEEP}" app node -e "
  const fs = require('fs');
  const path = require('path');
  const Database = require('better-sqlite3');

  const dir = '/data/backups';
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(dir, 'monitor-' + stamp + '.db');
  const db = new Database('/data/monitor.db', { readonly: true, fileMustExist: true });

  db.backup(target)
    .then(() => {
      db.close();
      console.log('Backed up the database to data/backups/' + path.basename(target));

      const keep = Number(process.env.KEEP);
      const old = fs.readdirSync(dir)
        .filter((f) => /^monitor-.*\.db$/.test(f))
        .sort()
        .reverse()
        .slice(keep);
      for (const f of old) fs.unlinkSync(path.join(dir, f));
      if (old.length) console.log('Removed ' + old.length + ' older backup(s).');
    })
    .catch((err) => { console.error(err); process.exit(1); });
"
