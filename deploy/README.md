# Deploying Folio

Folio needs four things from a host: a **long-running process**, **PostgreSQL**,
**Redis**, and a **persistent disk** for the Git repositories of your spaces
(plus WebSocket connections for real-time editing). Everything here installs
exactly that, from the published image `ghcr.io/evergreen-it-dev/folio`
(`linux/amd64` and `linux/arm64`).

| Platform | What you do | Kit | Persistent disk |
|---|---|---|---|
| **Any Linux server (VPS)** | Run one command | [vps/](vps/) | yes |
| **Coolify** | Paste a Compose file | [coolify/](coolify/) | yes |
| **Railway** | Click a button (template) | [railway/](railway/) | yes (volume) |
| **Render** | Click a button (Blueprint) | [render/](render/) and [`render.yaml`](../render.yaml) | paid plans only |
| **DigitalOcean** | Droplet + cloud-init (App Platform is not possible) | [digitalocean/](digitalocean/) | yes (Droplet disk) |
| **Dokploy** | Compose + template files | [dokploy/](dokploy/) | yes |
| **CapRover** | One-Click App YAML | [caprover/](caprover/) | yes |
| **Easypanel** | Template files | [easypanel/](easypanel/) | yes |
| **Portainer** | Paste a stack | [portainer/](portainer/) | yes |
| **Fly.io** | Manual, from `fly.toml` | [fly/](fly/) | yes (volume) |

Serverless hosting (Vercel, Netlify, Cloudflare Pages, AWS Lambda) cannot run
Folio: it needs a disk and a process that stays alive.

## Sizing

Measured on a running instance: the app idles at about 450 MB of RAM, PostgreSQL
at 30 to 120 MB, Redis at about 10 MB. PDF export starts a headless Chromium on
demand and adds a few hundred MB while it runs.

| | Minimum | Comfortable (a team of about 20) |
|---|---|---|
| RAM | 2 GB for the whole stack (1 GB for the app container) | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 10 GB (the image alone is about 1.7 GB unpacked) | 20 GB and growing with your content |

## What every kit sets up

- **Secrets are generated**, never shipped as defaults: the database password
  and `FOLIO_SECRET` (it encrypts saved Git tokens and personal AI keys;
  never change it afterwards).
- **`PUBLIC_URL`** is the address people open. Invitation and share links are
  built from it, and it decides whether cookies are HTTPS-only. It must match
  the address in the browser.
- PostgreSQL and Redis are reachable only from inside the stack.
- Redis holds transient data only (presence, rate limits) and is not persisted.

## Check an installation

```bash
node deploy/smoke.mjs https://wiki.example.com
```

[`smoke.mjs`](smoke.mjs) needs Node 18+ and a **fresh** instance. It creates
the first account, a space and a page, and opens a real-time (WebSocket)
connection to the page. Delete the instance, or that space, afterwards.

## Updating and backups

Every kit's README has its own steps. In short: take a backup, pull the new
image, restart; the database migrates itself on start. A backup is always two
things: the database dump and the data volume (`/app/data`).
Details: [docs/INSTALL.md](../docs/INSTALL.md#backup-and-restore).
