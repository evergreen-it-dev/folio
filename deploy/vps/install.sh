#!/usr/bin/env bash
# Folio installer for a plain Linux server (or any machine with Docker).
#
#   curl -fsSL https://raw.githubusercontent.com/evergreen-it-dev/folio/main/deploy/vps/install.sh | bash
#
# What it does: checks Docker, downloads docker-compose.yml, generates the
# secrets, writes .env, starts Folio from the published image and waits until
# it answers. Safe to run again: an existing .env (and its secrets) is kept.
#
#   install.sh            install, or re-apply after editing .env
#   install.sh update     back up, pull the newest image and restart
#   install.sh backup     write the database and the data volume to ./backups
#
# Settings (environment variables, all optional):
#   FOLIO_DOMAIN   wiki.example.com  -> automatic HTTPS with Caddy (needs DNS and ports 80/443)
#   FOLIO_DIR      where to install (default: /opt/folio as root, ~/folio otherwise)
#   FOLIO_IMAGE    image to run (default: ghcr.io/evergreen-it-dev/folio:latest)
#   FOLIO_PORT     port without a domain (default: 4870)
#   FOLIO_RAW_BASE where the compose file is downloaded from
#   FOLIO_YES=1    never ask questions
#
# update and backup need the script on disk: after the first run it is saved as
# $FOLIO_DIR/install.sh.
set -euo pipefail

RAW_BASE="${FOLIO_RAW_BASE:-https://raw.githubusercontent.com/evergreen-it-dev/folio/main/deploy/vps}"
if [ -n "${FOLIO_DIR:-}" ]; then DIR="$FOLIO_DIR"
elif [ -f "$0" ] && [ -f "$(cd "$(dirname "$0")" && pwd)/.env" ]; then DIR="$(cd "$(dirname "$0")" && pwd)"
elif [ "$(id -u)" -eq 0 ]; then DIR=/opt/folio
else DIR="$HOME/folio"; fi

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Questions go to the terminal even when the script itself is piped into bash.
ask() { # ask "question" default -> answer
  local answer=''
  if [ "${FOLIO_YES:-0}" != 1 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s [%s]: ' "$1" "$2" > /dev/tty
    read -r answer < /dev/tty || true
  fi
  printf '%s' "${answer:-$2}"
}

random_hex() { # random_hex <bytes>
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

need_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is not installed. Install it first, then run this again:" >&2
    echo "  https://docs.docker.com/engine/install/   (or: curl -fsSL https://get.docker.com | sh)" >&2
    exit 1
  }
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (\`docker compose version\` fails). Update Docker: https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Is it running, and are you in the docker group (or root)?"
}

compose() { (cd "$DIR" && docker compose "$@"); }
get_env() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }

backup() {
  umask 077
  stamp="$(date +%Y%m%d-%H%M%S)"; mkdir -p "$DIR/backups"
  compose exec -T postgres pg_dump -U folio folio > "$DIR/backups/folio-db-$stamp.sql"
  compose exec -T app tar czf - -C /app/data . > "$DIR/backups/folio-data-$stamp.tgz"
  say "Backup written to $DIR/backups ($stamp)"
}

case "${1:-install}" in
  update)
    need_docker; [ -f "$DIR/.env" ] || die "no installation in $DIR (set FOLIO_DIR?)"
    say "Backing up first"; backup || warn "backup failed; continuing"
    say "Pulling the newest image"
    compose pull app
    compose up -d --wait --wait-timeout 300
    say "Updated."; exit 0 ;;
  backup)
    need_docker; [ -f "$DIR/.env" ] || die "no installation in $DIR (set FOLIO_DIR?)"
    backup; exit 0 ;;
  install) ;;
  *) die "unknown command: $1 (use: install, update, backup)" ;;
esac

need_docker
command -v curl >/dev/null 2>&1 || die "curl is required"

if [ -r /proc/meminfo ]; then
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  [ "$mem_mb" -ge 1500 ] || warn "only ${mem_mb} MB of RAM. Folio with its database needs about 2 GB; it may be killed under load."
fi

mkdir -p "$DIR"
say "Installing Folio into $DIR"
curl -fsSL "$RAW_BASE/docker-compose.yml" -o "$DIR/docker-compose.yml" || die "could not download $RAW_BASE/docker-compose.yml"
curl -fsSL "$RAW_BASE/install.sh" -o "$DIR/install.sh" && chmod +x "$DIR/install.sh" || warn "could not save install.sh next to the compose file"

if [ -f "$DIR/.env" ]; then
  say "Found an existing .env - keeping your settings and secrets."
else
  domain="${FOLIO_DOMAIN:-}"
  if [ -z "$domain" ]; then
    domain="$(ask 'Domain for HTTPS (empty = no domain, plain http on this server)' '')"
  fi
  port="${FOLIO_PORT:-4870}"
  (
    umask 077
    {
      echo "# Written by install.sh. Edit, then run: docker compose up -d"
      echo "POSTGRES_PASSWORD=$(random_hex 24)"
      echo "FOLIO_SECRET=$(random_hex 32)"
      [ -z "${FOLIO_IMAGE:-}" ] || echo "FOLIO_IMAGE=$FOLIO_IMAGE"
      if [ -n "$domain" ]; then
        echo "PUBLIC_URL=https://$domain"
        echo "FOLIO_DOMAIN=$domain"
        echo "FOLIO_BIND=127.0.0.1"
        echo "COMPOSE_PROFILES=https"
      else
        host="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
        echo "PUBLIC_URL=http://${host:-localhost}:$port"
        echo "FOLIO_PORT=$port"
        echo "FOLIO_BIND=0.0.0.0"
      fi
    } > "$DIR/.env"
  )
fi
# The compose file mounts ./Caddyfile even when HTTPS is off.
curl -fsSL "$RAW_BASE/Caddyfile" -o "$DIR/Caddyfile" || die "could not download $RAW_BASE/Caddyfile"

say "Starting Folio (the first start downloads a few hundred MB)"
compose up -d --wait --wait-timeout 300

url="$(get_env PUBLIC_URL)"
cat <<DONE

Folio is running.

  Open:     $url
  Sign up:  the first account becomes the administrator.
  Folder:   $DIR   (settings in .env - keep it private and back it up)
  Update:   cd $DIR && ./install.sh update
  Backup:   cd $DIR && ./install.sh backup

DONE
case "$url" in http://*) echo "This address is plain http. Do not expose it to the internet; re-run with FOLIO_DOMAIN=your.domain for HTTPS." ;; esac
