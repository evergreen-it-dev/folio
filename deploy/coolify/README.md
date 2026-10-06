# Folio on Coolify

[Coolify](https://coolify.io/) is a self-hosted PaaS you run on your own server.
This kit gives Coolify a Docker Compose file; Coolify adds the domain, HTTPS
and the proxy.

**You need:** a Coolify v4 instance with a server attached and a wildcard or
custom domain (see Coolify's docs on [domains](https://coolify.io/docs/knowledge-base/domains)),
and 2 GB of RAM or more on that server.

## Install

1. In Coolify open **Projects**, pick a project and environment, then
   **+ New** > **Docker Compose Empty**
   ([how this path works](https://coolify.io/docs/knowledge-base/docker/compose)).
2. Paste the whole of [`docker-compose.yaml`](docker-compose.yaml) and **Save**.
3. Open the `folio` service and set **Domains** to the address you want, for
   example `https://wiki.example.com` (Coolify may already have filled one in).
   Point its DNS record at the server.
4. **Deploy**. The first start pulls the image and takes a few minutes. The
   service turns healthy when `/api/health` answers.
5. Open the address. The first account you create becomes the administrator.

Coolify generates `SERVICE_PASSWORD_POSTGRES` and
`SERVICE_PASSWORD_64_FOLIOSECRET` itself (these are Coolify's
[magic variables](https://coolify.io/docs/knowledge-base/docker/compose#coolifys-magic-environment-variables))
and keeps them across redeploys. `PUBLIC_URL` follows the domain you set.

## Settings

Set these in the service's **Environment Variables** tab; empty ones are
already listed there.

| Variable | Default | What it does |
|---|---|---|
| `FOLIO_TAG` | `latest` | Image tag. Pin a release such as `v0.1.0` to update only when you choose. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Turn on "Sign in with Google". Register `<your address>/api/auth/google/callback`. |
| `GOOGLE_ALLOWED_DOMAINS` | empty | Email domains allowed to sign in with Google. Empty means nobody. |
| `CURSOR_API_KEY` | empty | Shared key for the AI assistant. Without it each person adds their own. |
| `CURSOR_AGENT_MODEL` | `auto` | Model the assistant uses. |

`FOLIO_SECRET` (`SERVICE_PASSWORD_64_FOLIOSECRET`) encrypts saved Git tokens and
AI keys. Do not change or delete it after people have saved credentials.

## Update

With `FOLIO_TAG=latest`, press **Redeploy** (Coolify pulls the image again).
With a pinned tag, change `FOLIO_TAG` first. Database changes are applied by
the app on start. Back up before a big jump.

## Backup

Two things: the database and the `folio-data` volume. On the Coolify server,
with the container names from `docker ps | grep folio`:

```bash
docker exec <postgres-container> pg_dump -U folio folio > folio-db.sql
docker exec <folio-container> tar czf - -C /app/data . > folio-data.tgz
```

Coolify can also schedule S3 backups for its own database resources, but not
for a database inside a Compose file, so schedule the commands above (cron on
the server) or snapshot the server's disk.

## Limits

- One instance of the app only (the disk is local to the container).
- Redeploys restart the app; open pages reconnect by themselves.
- Tested: Folio's own production runs on Coolify. If something differs on
  your instance, please open an issue.

## The official Coolify catalog

[`catalog/`](catalog/) holds a draft of the template for Coolify's service
catalog. The catalog requires 1,000 GitHub stars, so it is submitted later.
