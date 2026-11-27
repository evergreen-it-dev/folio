# Folio on Umbrel

[umbrelOS](https://umbrel.com/) is a home-server OS where apps are Docker
Compose packages. This directory is the Folio (foliowiki) package for it.

**You need:** an Umbrel (umbrelOS 1.x or 2.x) with about 2 GB of free memory.
The Folio image is about 1.7 GB unpacked, so the first install takes a while.
The image runs on amd64 and arm64.

## What is here

| Path | What it is |
|---|---|
| `foliowiki/umbrel-app.yml` | The app manifest (name, port 4870, category `ai`) |
| `foliowiki/docker-compose.yml` | Folio, PostgreSQL 17 and Redis 7, every image pinned by digest |
| `foliowiki/exports.sh` | Derives the database password and `FOLIO_SECRET` from the Umbrel seed |
| `foliowiki/data/*/.gitkeep` | Empty data folders Umbrel mounts on first start |
| `gallery/` | Five screenshots (2160x1350) and the icon (SVG and 256x256 PNG) |

## Install through the official App Store

Not available yet: the package has not been submitted. The pull request text
is prepared; once the package is merged, install Folio Wiki from the App Store
on your Umbrel.

## Install through a community app store

Umbrel can add any GitHub repository as an extra app store, so you can offer
Folio before (or without) the official listing. The repository needs:

1. `umbrel-app-store.yml` at the root:

   ```yaml
   id: "evergreen"
   name: "Evergreen"
   ```

2. The app folder, with the store id as a prefix: `evergreen-foliowiki/`
   (the copy of `foliowiki/` from here). Inside `umbrel-app.yml` change `id`
   to `evergreen-foliowiki`, and in `docker-compose.yml` change `APP_HOST` and
   the three container names in `DATABASE_URL`, `REDIS_URL` and `APP_HOST` from
   `foliowiki_*_1` to `evergreen-foliowiki_*_1`.
3. In `umbrel-app.yml` add `icon:` and full `gallery:` URLs (a community store
   has no gallery repository; the official store hosts images separately), for
   example raw GitHub links to the files in `gallery/`.

On the Umbrel: **App Store**, the three dots, **Community App Stores**, paste
the repository URL, then install Folio Wiki from the new store.

Not tried on a real Umbrel: these steps follow the community app store
template ([getumbrel/umbrel-community-app-store](https://github.com/getumbrel/umbrel-community-app-store)).

## First start

Open the app from the Umbrel home screen and create the first account: it
becomes the administrator. Umbrel's own login still guards the app, so nobody
on your network can claim that account before you.

### Addresses and links

Folio builds invitation and share links from `PUBLIC_URL`, which the package
sets to `http://<your-umbrel>.local:4870` (the device name and port Umbrel
uses). It must be an `http://` address: otherwise, in production mode, Folio
marks its session cookie `Secure` and sign-in fails on plain http. If you open
the app by IP address, signing in still works, but links people copy will use
the `.local` name. The package does not set a fixed domain for remote access;
to publish Folio under your own HTTPS domain, use one of the other kits in
[`deploy/`](../README.md).

### AI agents and MCP

Umbrel login protects every path except `/mcp`, which is left open so AI
agents can reach Folio's MCP server; it answers 401 without a Folio access
token. Other API paths need the Umbrel session.

### Optional settings

In the app's settings (umbrelOS 2.x) you can set `CURSOR_API_KEY`, a
server-wide fallback key for the built-in assistant. Keys saved inside Folio
win over it.

## Update

Umbrel offers the new version in the App Store once the package is updated;
the database migrates itself on start.

## Backup

Everything Folio keeps is under the app's `data/` folder on the Umbrel
(`folio/` for Git repositories, assets and assistant state, `postgres/` for the
database); Umbrel backups include it. To make a database dump by hand, over SSH:

```bash
docker exec foliowiki_postgres_1 pg_dump -U folio folio > folio-db.sql
```

`FOLIO_SECRET` is derived from your Umbrel seed, so it stays the same across
restarts and updates, and a restore onto the same Umbrel keeps saved Git tokens
and AI keys readable.

## Limits

- One instance of the app (the disk is local).
- Redis holds transient data only and is not persisted on purpose.
- The Folio container runs as root (the image has no `USER`), so files it
  writes under `data/folio/` are owned by root.
- Checked with the Umbrel package linter and `docker compose config`. The
  package has **not** been installed on a real Umbrel or in a local umbrelOS,
  and the stack was not started locally.
