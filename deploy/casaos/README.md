# Folio on CasaOS and ZimaOS

[CasaOS](https://casaos.io/) and ZimaOS are home-server operating systems with
an app store built on Docker Compose. This directory holds the Compose file
with the store metadata (`x-casaos`) and the icon, thumbnail and screenshots
the store needs.

**You need:** a CasaOS or ZimaOS machine with 2 GB RAM or more. The image
supports amd64 and arm64.

## Install now (without the store)

1. In the CasaOS dashboard click **+** (top right of the app grid) >
   **Install a customized app** > **Import**, and paste
   [`docker-compose.yml`](docker-compose.yml).
2. Before installing, set these values:
   - `PUBLIC_URL`: the address you open Folio at, for example
     `http://192.168.1.10:4870` (your server's IP and the web UI port). Keep
     `http://` unless Folio is behind an HTTPS proxy.
   - `POSTGRES_PASSWORD` of `foliowiki-db` and the password inside
     `DATABASE_URL` of `foliowiki`: pick one password and use it in both.
3. **Install**, wait a minute, open the app. The first account you create is
   the administrator.

`FOLIO_SECRET` (it encrypts saved Git tokens and AI keys) is not in the file.
The container generates it on the first start and keeps it in
`/app/data/.folio-secret`, inside the data folder. Never delete that file; it
is part of the backup.

If you leave `PUBLIC_URL` as `http://localhost:4870`, sign-in works from any
address, but invite and share links will point to `localhost`. With an image
newer than 0.4.6 you can delete `PUBLIC_URL` instead: links then use the
address you opened Folio at.

## From the app store

Once Folio is accepted into the
[CasaOS-AppStore](https://github.com/IceWhaleTech/CasaOS-AppStore), search for
**Folio Wiki** under the **AI** category. The same `PUBLIC_URL` advice applies:
open the app's settings before the first start and set it.

## Update

Change the image tag (`v0.4.6`) to the new release in the app's settings, or
install the newer store version. The database migrates itself on start.

## Backup

Everything is under `/DATA/AppData/<app id>/`: `data` (spaces, files, the
secret) and `pgdata` (the database). Stop the app and copy the folder, or:

```bash
docker exec foliowiki-db pg_dump -U folio folio > folio-db.sql
tar czf folio-data.tgz -C /DATA/AppData/<app id> data
```

## Limits

- Default ports and passwords are fixed in the file; the database and Redis
  are not published outside the app's own Docker network.
- One instance of the app (the disk is local).
- Tested with Docker Compose on a desktop machine, over plain http; not
  installed on a live CasaOS or ZimaOS box.
