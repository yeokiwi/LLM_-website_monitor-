#!/usr/bin/env bash
#
# One-time preparation of a fresh DigitalOcean Basic droplet (Ubuntu LTS) to run
# Website Monitor with Docker Compose. Run it as root:
#
#   sudo bash deploy/digitalocean/setup-droplet.sh
#
# It is safe to run again; each step skips itself when already done.
#
#   1. installs security updates, git and Docker Engine + the Compose plugin
#   2. adds a swap file, so the image build fits in a 1 GB droplet's memory
#   3. turns on the firewall, allowing only SSH, HTTP and HTTPS

set -euo pipefail

SWAP_SIZE="${SWAP_SIZE:-2G}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root (sudo bash $0)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing updates and base packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw

echo "==> Installing Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "    Docker and the Compose plugin are already installed."
else
  # Docker's own apt repository: https://docs.docker.com/engine/install/ubuntu/
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# Let the user who invoked sudo run docker without it.
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  usermod -aG docker "${SUDO_USER}"
  echo "    Added ${SUDO_USER} to the docker group (log out and back in to use it)."
fi

echo "==> Configuring swap"
if swapon --show --noheadings | grep -q .; then
  echo "    Swap is already enabled."
else
  fallocate -l "${SWAP_SIZE}" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer RAM; only spill to swap under pressure (e.g. during the build).
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-website-monitor-swap.conf
  sysctl -p /etc/sysctl.d/99-website-monitor-swap.conf
  echo "    Added a ${SWAP_SIZE} swap file."
fi

echo "==> Configuring the firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
ufw status verbose

echo
echo "Droplet is ready. Next steps (see docs/DEPLOY_DIGITALOCEAN.md):"
echo "  cp .env.production.example .env && nano .env"
echo "  docker compose up -d --build"
