# Folio on Railway

[Railway](https://railway.com/) runs containers with managed Postgres and Redis
and gives each service a public HTTPS address. A Railway template deploys the
whole stack from one button.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE)

> The button above is a placeholder. A Railway template is created in the
> account of whoever publishes it, so it does not exist until the Folio
> maintainers create it from the specification below. Until then, follow
> "Without the template" to build the same project by hand in about five minutes.

**You need:** a Railway account on the Hobby plan or higher (the free trial's
0.5 GB volume and RAM are too small), and the image
`ghcr.io/evergreen-it-dev/folio` published and public.

## Without the template

1. **New Project** > **Empty project**.
2. **+ Create** > **Database** > **Add PostgreSQL**.
3. **+ Create** > **Database** > **Add Redis**.
4. **+ Create** > **Docker Image** > `ghcr.io/evergreen-it-dev/folio:latest`. Name the service `folio`.
5. In the `folio` service open **Variables** and add the ones from the table below.
6. **Settings** > **Networking** > **Generate Domain**, with port `4870`.
7. Right-click the service (or **Settings** > **Volumes**) > **Attach volume**, mount path `/app/data`.
8. **Settings** > **Deploy** > **Healthcheck Path**: `/api/health`.
9. Deploy. Open the generated domain; the first account is the administrator.

## Template specification

For the maintainer who creates the template
([Railway: create a template](https://docs.railway.com/guides/create)).
Three services, one volume.

| Service | Source | Notes |
|---|---|---|
| `Postgres` | Railway PostgreSQL template | Defaults |
| `Redis` | Railway Redis template | Defaults |
| `folio` | Docker image `ghcr.io/evergreen-it-dev/folio:latest` | Volume `/app/data`; public networking on port `4870`; healthcheck path `/api/health` |

Variables of the `folio` service:

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `4870` | The port the app listens on, and the one Railway routes to |
| `ASSET_BACKEND` | `local` | Uploads go to the volume |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference variable |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | Reference variable |
| `PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Links in invitations and shares; HTTPS-only cookies |
| `FOLIO_SECRET` | `${{secret(64, "abcdef0123456789")}}` | Generated at deploy time ([template functions](https://docs.railway.com/guides/create#dynamic-variables)); never change it afterwards |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` | empty, optional | "Sign in with Google" |
| `CURSOR_API_KEY` | empty, optional | Shared AI assistant key |

Template description (for the marketplace): "Folio: a team wiki whose pages are
Git files. Real-time editing, access rights, AI agents over MCP. Deploys the
app with PostgreSQL, Redis and a volume."

After creating the template: copy its code into the button at the top of this
file and into the site, then submit it to the marketplace and apply to
Railway's [open-source partner program](https://docs.railway.com/guides/templates)
(which pays a kickback on usage).

## Sizing and cost

Railway bills by use. The stack idles at about 0.5 GB of RAM for the app and a
little for each database, plus the volume (billed per GB). Hobby gives a 5 GB
volume per service; Pro allows more. Check Railway's
[pricing](https://docs.railway.com/reference/pricing/plans) for today's numbers.

## Update

Open the `folio` service > **Settings** > **Source** and redeploy, or change
the image tag (pin `v0.1.0` to update on your terms). The app migrates the
database when it starts. A redeploy of a service with a volume causes a brief
downtime; Railway does that on purpose.

## Backup

Railway has [volume backups](https://docs.railway.com/volumes/reference)
(manual and scheduled) for `/app/data`. For the database use the Postgres
service's backups, or from your machine with the Railway CLI:

```bash
railway run --service Postgres sh -c 'pg_dump "$DATABASE_PUBLIC_URL"' > folio-db.sql
```

(`DATABASE_PUBLIC_URL` exists when the Postgres TCP proxy is enabled.)

## Limits and things to know

- One replica only: Railway volumes do not work with replicas.
- Volumes can grow but not shrink.
- If Folio logs `[redis] unavailable` after the first deploy, Railway's private
  network may need IPv6: append `?family=0` to the Redis URL
  (`${{Redis.REDIS_URL}}?family=0`). Folio keeps working without Redis, with
  per-process rate limits, but fix it.
- This kit has not been deployed on Railway yet; it is written from Railway's
  documentation. Please tell us what differs.
