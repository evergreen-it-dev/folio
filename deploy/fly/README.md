# Folio on Fly.io

Fly.io is possible but not a one-click: there is no template format that
creates an app, a volume and a database together, so this is a short recipe
around [`fly.toml`](fly.toml). It has not been run on a live Fly account; it
follows Fly's documentation. Treat it as a starting point and tell us what differs.

## Why it works, and why it is not a kit

Folio needs a disk, and Fly gives one: a [volume](https://docs.fly.io/volumes/overview)
attaches to **one machine** only, lives in one region, and is not synchronised
between machines. So Folio runs as exactly one machine with one volume, and you
cannot scale it out. That fits Folio (one instance is how it is designed), but
it means no zero-downtime deploys and a hardware failure of the host is your
backup's problem: Fly takes daily volume snapshots (kept five days by default),
and Fly itself says snapshots should not be your only backup.

The database is the other cost. Fly's [Managed Postgres](https://docs.fly.io/mpg)
starts around $38 a month for its smallest plan, which is more than the rest of
the stack. The alternative is to run your own PostgreSQL (a second Fly app with
its own volume), or to use an external database such as Neon or Supabase and
set `DATABASE_URL` to its connection string. For a small team, a small VPS
([`../vps/`](../vps/README.md)) is simpler and cheaper.

## Recipe

Install `flyctl` and sign in, then from this directory:

```bash
# 1. Edit fly.toml: app name and region.
fly launch --copy-config --no-deploy

# 2. The volume for the Git repositories, in the same region.
fly volumes create folio_data --size 10 --region ams

# 3. A PostgreSQL database, attached to the app (this sets DATABASE_URL).
fly mpg create
fly mpg attach <cluster> --app <your-app>

# 4. Secrets: the address people open, and the encryption key.
fly secrets set PUBLIC_URL=https://<your-app>.fly.dev FOLIO_SECRET=$(openssl rand -hex 32)

# 5. Deploy and check.
fly deploy
node ../smoke.mjs https://<your-app>.fly.dev   # on a fresh instance only
```

**Redis is optional here.** Folio uses it for rate limits and short locks, and
degrades without it ("in-memory rate limit, unlocked space mutations"), which
is correct for a single machine. If you want it, create an Upstash Redis
(`fly redis create`) and set `REDIS_URL`.

## Update and backup

- Update: `fly deploy` again (the image tag in `fly.toml` decides what you get;
  pin a release for control). The database migrates itself on start.
- Backup: `fly volumes snapshots create <volume-id>` for the data volume, plus
  your database provider's backups (or `pg_dump` over `fly proxy`). Keep a copy
  outside Fly as well.
