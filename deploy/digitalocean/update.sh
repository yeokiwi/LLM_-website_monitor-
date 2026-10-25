#!/usr/bin/env bash
#
# Deploy the latest code: pull, back up the database, rebuild the image and
# restart the containers. Run from anywhere on the droplet:
#
#   bash deploy/digitalocean/update.sh            # current branch
#   BRANCH=main bash deploy/digitalocean/update.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ -n "${BRANCH:-}" ]]; then
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
fi

echo "==> Pulling the latest code"
git pull --ff-only

# Snapshot the database before the new code runs its migrations.
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  bash deploy/digitalocean/backup.sh
fi

echo "==> Rebuilding and restarting"
docker compose up -d --build

echo "==> Removing old images"
docker image prune -f

docker compose ps
