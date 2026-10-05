# Folio on any Linux server

The simplest way to host Folio for a team: one server, Docker, one command.
This is also what the Droplet, cloud-init and Hetzner-style installs use.

## Requirements

- A Linux server (Ubuntu 22.04/24.04 or Debian 12 are what we assume) with
  **2 GB of RAM, 1 vCPU and 10 GB of disk** at least. 4 GB and 2 vCPU for a
  team of about twenty.
- [Docker Engine](https://docs.docker.com/engine/install/) with the Compose
  plugin (`docker compose version` works), and `curl`.
- For HTTPS: a domain whose DNS A record points at the server, and ports 80
  and 443 open.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/evergreen-it-dev/folio/main/deploy/vps/install.sh | bash
```

The script asks for a domain (empty means plain http on the server's IP, for a
trial). To skip the question:

```bash
FOLIO_DOMAIN=wiki.example.com FOLIO_YES=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/evergreen-it-dev/folio/main/deploy/vps/install.sh)"
```

It checks Docker, downloads [`docker-compose.yml`](docker-compose.yml) into
`/opt/folio` (or `~/folio` when you are not root), **generates the database
password and `FOLIO_SECRET`**, writes them to a `.env` readable only by its
owner, starts the stack from the published image, and waits until the app is
healthy. Then open the address it prints; the first account is the
administrator. Running it again keeps your `.env` and secrets.

Read the script before you run it: [`install.sh`](install.sh). Options are
environment variables (`FOLIO_DIR`, `FOLIO_PORT`, `FOLIO_IMAGE`,
`FOLIO_RAW_BASE`); the list is at the top of the file.

Without a domain the address is plain `http://<ip>:4870`. Folio then does not
mark its cookies HTTPS-only, so signing in works, but do not expose such an
instance to the internet.

## Settings

Everything is in `.env` next to the compose file ([`.env.example`](.env.example)
lists them). After editing, apply with `docker compose up -d`.

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | set by the script | The address people open. Must match the browser, including `https`. |
| `POSTGRES_PASSWORD` | generated | Applied when the database is first created. |
| `FOLIO_SECRET` | generated | Encrypts saved Git tokens and personal AI keys. **Never change it.** |
| `FOLIO_DOMAIN` | empty | Domain for the bundled Caddy (automatic HTTPS). |
| `FOLIO_IMAGE` | `ghcr.io/evergreen-it-dev/folio:latest` | Pin a release (`...:v0.1.0`) to update on your terms. |
| `FOLIO_PORT`, `FOLIO_BIND` | `4870`, `0.0.0.0` | Port, and which addresses may reach it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` | empty | "Sign in with Google". |
| `CURSOR_API_KEY` | empty | Shared AI assistant key. |

Your own reverse proxy works too: set `FOLIO_BIND=127.0.0.1`, no domain, and
forward to `127.0.0.1:4870`, passing the `Upgrade` and `Connection` headers.

## Update

```bash
cd /opt/folio && ./install.sh update
```

It takes a backup, pulls the newest image and restarts. The database migrates
itself on start. By hand: `docker compose pull && docker compose up -d`.

## Backup and restore

```bash
cd /opt/folio && ./install.sh backup
```

writes `backups/folio-db-<date>.sql` and `backups/folio-data-<date>.tgz`: the
database and the data volume (the Git repositories and uploads). Both are
needed. Copy them off the server. Restore is described in
[docs/INSTALL.md](../../docs/INSTALL.md#backup-and-restore).

## Check it

```bash
node deploy/smoke.mjs https://wiki.example.com   # fresh instance only
```

## Uninstall

`cd /opt/folio && docker compose down` stops it and keeps the data. Add
`--volumes` to delete every page and account.
