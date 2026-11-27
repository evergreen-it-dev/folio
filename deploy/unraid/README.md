# Folio on Unraid

Folio (foliowiki) needs three containers on Unraid: the Folio container itself,
PostgreSQL and Redis. [`foliowiki.xml`](foliowiki.xml) is the Unraid container
template for the first one (the format Community Applications uses); PostgreSQL
and Redis come from the Apps tab. If you prefer one stack, see
[Compose alternative](#compose-alternative).

**You need:** Unraid with Docker enabled and the Community Applications plugin,
and about 2 GB of free RAM for the whole stack.

## 1. Install PostgreSQL and Redis first

In the **Apps** tab install:

- **postgresql17** (official `postgres:17` image). Set `POSTGRES_USER=folio`,
  `POSTGRES_DB=folio` and a `POSTGRES_PASSWORD` of your choice, keep the data
  path under `/mnt/user/appdata/`, and start it.
- **Redis** (official `redis` image) or **Valkey**. Folio keeps only transient
  data there (presence, rate limits); the defaults are fine.

Several authors publish templates with these names; any of them works as long
as it runs a current PostgreSQL 17 and Redis or Valkey. Note the Unraid IP and
the two ports (5432 and 6379 by default).

## 2. Add the Folio container

Until the template is listed in Community Applications, add it by URL:

1. **Docker** tab > **Add Container**.
2. In **Template**, paste
   `https://raw.githubusercontent.com/evergreen-it-dev/folio/main/deploy/unraid/foliowiki.xml`
   (or choose it from the list once the page has loaded the template) and
   confirm.
3. Fill in the fields:

   | Field | Value |
   |---|---|
   | `DATABASE_URL` | `postgresql://folio:PASSWORD@192.168.1.10:5432/folio` (your Unraid IP and the password from step 1; URL-encode special characters) |
   | `REDIS_URL` | `redis://192.168.1.10:6379` |
   | `PUBLIC_URL` | `http://192.168.1.10:4870`, the exact address you will open in the browser |
   | `FOLIO_SECRET` | output of `openssl rand -hex 32` in the Unraid terminal |

4. **Apply**, then open the WebUI. The first account you create is the
   administrator.

`PUBLIC_URL` matters. With `NODE_ENV=production` the session cookie is marked
`Secure` unless `PUBLIC_URL` is explicitly an `http://` address, and a browser
drops such a cookie on plain http, so sign-in appears to do nothing. Set it to
exactly what is in your address bar, including the port. Behind a reverse proxy
with TLS, set the `https://` address instead. Invite and share links are built
from this value too.

`FOLIO_SECRET` encrypts saved Git tokens and AI keys. Generate it once and
never change it.

Optional (Advanced View): `CURSOR_API_KEY` for the built-in AI assistant,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_ALLOWED_DOMAINS` for
Google sign-in. The other variables are fixed and hidden.

The template uses the `latest` tag, the usual choice for Unraid templates:
Unraid shows an update badge and you update from the Docker tab. To stay on a
version, change the **Repository** field to `ghcr.io/evergreen-it-dev/folio:0.4.6`.

## Update

Docker tab > **Check for Updates** > **apply update** on the Folio container.
The database migrates itself on start. Check the
[release notes](https://github.com/evergreen-it-dev/folio/releases) first for
a major step.

## Backup

Two things hold your data: the Folio appdata folder and the PostgreSQL
database. Back up both (for example with the Appdata Backup plugin plus a dump):

```bash
docker exec <postgres-container> pg_dump -U folio folio > /mnt/user/backups/folio-db.sql
tar czf /mnt/user/backups/folio-data.tgz -C /mnt/user/appdata/foliowiki .
```

Use the PostgreSQL container's real name from the Docker tab. Stop the Folio
container before the file copy if you want a consistent snapshot.

## Compose alternative

If you use a Compose plugin on Unraid (for example **Compose Manager Plus** from
the Apps tab), [`docker-compose.yml`](docker-compose.yml) runs Folio, PostgreSQL
and Redis as one stack, with data under `/mnt/user/appdata/foliowiki/`. Create a
stack, paste the file and set `UNRAID_IP`, `POSTGRES_PASSWORD` and
`FOLIO_SECRET` in the stack's environment (see the comment at the top of the
file). This route does not use the container template or Community
Applications.

## Limits

- One instance of the app (the disk is local).
- Community Applications lists single-container templates, so PostgreSQL and
  Redis are separate containers that you install and keep running yourself.
- The image runs as root, like many Unraid images; it needs no extra
  permissions or devices and the template is not privileged.
- The template and the Compose file were run with plain Docker on a test
  network that mimics this layout (separate PostgreSQL and Redis containers);
  they have not been run on a live Unraid server.
