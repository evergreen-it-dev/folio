# Installing Folio

Folio runs as three containers: the application, PostgreSQL and Redis. One
command starts all of them.

- [On your computer](#on-your-computer)
- [On a server with HTTPS](#on-a-server-with-https)
- [Settings](#settings)
- [Updating](#updating)
- [Backup and restore](#backup-and-restore)
- [One-click and PaaS](#one-click-and-paas)
- [Other platforms](#other-platforms)
- [When something goes wrong](#when-something-goes-wrong)

## On your computer

1. Install [Docker Desktop](https://docs.docker.com/get-docker/) and
   [Git](https://git-scm.com/downloads), and start Docker.
2. Open a terminal and run:

   ```bash
   git clone https://github.com/evergreen-it-dev/folio.git
   cd folio
   docker compose up -d
   ```

3. Wait for the first build to finish. It takes a few minutes and downloads
   about 1 GB.
4. Open <http://localhost:4870> and fill in the form. The first account
   becomes the administrator of the instance.
5. A short welcome follows: choose what to create first and name your first
   space, or connect a Git repository you already have. "Skip" creates the
   space straight away.

To stop Folio: `docker compose stop`. To start it again: `docker compose up -d`.
Your pages stay where they are.

## On a server with HTTPS

You need a server with Docker, a domain name, and a DNS record for that domain
pointing at the server. Ports 80 and 443 must be open.

```bash
git clone https://github.com/evergreen-it-dev/folio.git
cd folio
cp .env.example .env
```

Edit `.env`:

```bash
PUBLIC_URL=https://wiki.example.com
FOLIO_DOMAIN=wiki.example.com
FOLIO_BIND=127.0.0.1
```

Then start Folio together with the bundled HTTPS proxy:

```bash
docker compose --profile https up -d
```

The proxy ([Caddy](https://caddyserver.com/)) obtains the certificate and
renews it by itself.

**Your own reverse proxy** works too. Skip `--profile https`, keep
`FOLIO_BIND=127.0.0.1`, and forward requests to `127.0.0.1:4870`. The proxy
must pass WebSocket connections through (`Upgrade` and `Connection` headers) —
real-time editing uses them.

**Without HTTPS** (a home or office network), set `PUBLIC_URL` to the exact
address people type, for example `PUBLIC_URL=http://192.168.1.20:4870`. With
an `http://` address Folio does not mark its cookies as HTTPS-only, so signing
in works. Do not expose such an instance to the internet.

## Settings

All settings live in the `.env` file next to `docker-compose.yml`. Copy
`.env.example` to `.env` and change what you need. After editing, apply with
`docker compose up -d`.

| Setting | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:4870` | The address people use to open Folio. Invitation and share links are built from it. |
| `FOLIO_PORT` | `4870` | Port on the host machine. |
| `FOLIO_BIND` | `0.0.0.0` | `127.0.0.1` makes Folio reachable from the same machine only. |
| `FOLIO_DOMAIN` | — | Domain for the bundled HTTPS proxy. |
| `FOLIO_SECRET` | generated | Encrypts saved git tokens and AI keys. See below. |
| `POSTGRES_PASSWORD` | `folio` | Database password, applied when the database is first created. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Turn on "Sign in with Google". |
| `GOOGLE_ALLOWED_DOMAINS` | empty | Email domains allowed to sign in with Google, comma-separated. Empty means nobody. |
| `CURSOR_API_KEY` | — | Shared key for the AI assistant. Without it each person adds their own key. |
| `TRUST_PROXY` | off | Set `true` behind a reverse proxy on the same host or Docker network so the sign-in rate limit is per visitor instead of one shared bucket. Only a proxy on a loopback or private address is believed. |
| `FOLIO_DEMO_MODE` | off | `1` turns on public-demo mode for running your own demo: one-click demo accounts and a banner, and tokens, the assistant, outbound git and import, new spaces, share links and invitations are disabled. See `.env.dev.example`. |

### The secret

Folio encrypts saved git tokens and personal AI keys with `FOLIO_SECRET`. If
you leave it empty, a random one is generated on first start and stored on the
data volume as `/app/data/.folio-secret`. It is included in the data backup
described below.

If you set your own, never change it afterwards: credentials saved earlier
would stop decrypting and would have to be entered again.

### Sign in with Google

Create an OAuth client in the Google Cloud Console, register the redirect URI
`<PUBLIC_URL>/api/auth/google/callback`, and set the three `GOOGLE_*` values.
List the email domains that may sign in — with an empty list Google sign-in
lets nobody in.

## Updating

```bash
cd folio
git pull
docker compose up -d --build
```

Database changes are applied automatically when the application starts. Make
a backup first.

## Backup and restore

Folio keeps data in two places, and a backup needs both:

- the **data volume** — the git repositories of the spaces and uploaded files;
- the **database** — accounts, access rights, the search index and the state
  of collaborative editing.

Back up:

```bash
docker compose exec -T postgres pg_dump -U folio folio > folio-db.sql
docker compose exec -T app tar czf - -C /app/data . > folio-data.tgz
```

Restore onto a fresh installation (no accounts created yet):

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres psql -U folio -d folio -q < folio-db.sql
docker compose run --rm -T --no-deps --entrypoint sh app -c 'tar xzf - -C /app/data' < folio-data.tgz
docker compose up -d
```

Spaces connected to a remote Git repository also keep their pages in that
repository after each synchronization.

## One-click and PaaS

Ready-made kits install Folio from the published image
(`ghcr.io/evergreen-it-dev/folio`, for amd64 and arm64) without building
anything. Each kit has its own README with steps, settings, updating and backup.
Prefer to look first? [Try the public demo](https://demo.foliowiki.online) — pick Sam on the sign-in screen. The login is shared and the data resets every 24 hours, so don't enter personal data or API keys.

| Platform | How | Kit |
|---|---|---|
| Any Linux server | one command: `install.sh` | [deploy/vps](../deploy/vps/) |
| Coolify | paste a Compose file | [deploy/coolify](../deploy/coolify/) |
| Railway | template (specification inside) | [deploy/railway](../deploy/railway/) |
| Render | Blueprint, paid plan (disk) | [deploy/render](../deploy/render/) |
| DigitalOcean | Droplet with cloud-init | [deploy/digitalocean](../deploy/digitalocean/) |
| Dokploy | compose + template files | [deploy/dokploy](../deploy/dokploy/) |
| CapRover | One-Click App | [deploy/caprover](../deploy/caprover/) |
| Easypanel | template files | [deploy/easypanel](../deploy/easypanel/) |
| Portainer | stack | [deploy/portainer](../deploy/portainer/) |
| Fly.io | manual recipe | [deploy/fly](../deploy/fly/) |

Everywhere the sizing is the same: **2 GB of RAM, 1 vCPU and 10 GB of disk** at
least. [`deploy/README.md`](../deploy/README.md) has the overview, and
[`deploy/smoke.mjs`](../deploy/smoke.mjs) checks a fresh installation (sign-up,
a space, a page, real-time editing).

## Other platforms

Folio can run anywhere that runs a container from the `Dockerfile` and
provides all of the following:

- **a long-running process** — not functions that start per request;
- **a persistent disk** mounted at `/app/data`;
- **PostgreSQL** (`DATABASE_URL`) and **Redis** (`REDIS_URL`);
- **WebSocket** connections to the application;
- environment variables `PUBLIC_URL`, `FOLIO_SECRET`, `NODE_ENV=production`,
  `PORT=4870`.

Serverless hosting — Vercel, Netlify, Cloudflare Pages and similar — cannot
run Folio: it has no persistent disk for the Git repositories and does not
keep a process alive for WebSocket connections. DigitalOcean's App Platform
cannot either, because it has no persistent volumes; use a Droplet.

## When something goes wrong

**The page does not open.** Check that the containers are running and look at
the log:

```bash
docker compose ps
docker compose logs app --tail 100
```

**Port 4870 is already in use.** Put `FOLIO_PORT=4880` into `.env`, set
`PUBLIC_URL` to match, and run `docker compose up -d`.

**Signing in does nothing on a server.** The address in the browser and
`PUBLIC_URL` must match, including `http` or `https`.

**Start from scratch.** This deletes every page and account:

```bash
docker compose down --volumes
```
