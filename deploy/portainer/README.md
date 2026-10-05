# Folio on Portainer

[Portainer](https://www.portainer.io/) manages Docker hosts from a web UI. A
stack is a Compose file you paste into it.

**You need:** Portainer (Community or Business) connected to a Docker host with
2 GB of RAM or more, and optionally a reverse proxy for HTTPS (Traefik, Nginx
Proxy Manager, Caddy).

## Install

1. **Stacks** > **Add stack**. Name it `folio`. Choose **Web editor**
   ([the four ways to deploy a stack](https://docs.portainer.io/user/docker/stacks/add)).
2. Paste [`stack.yml`](stack.yml).
3. Under **Environment variables** add:

   | Name | Value |
   |---|---|
   | `PUBLIC_URL` | The address people will open, e.g. `https://wiki.example.com` (or `http://<server-ip>:4870` to try it) |
   | `POSTGRES_PASSWORD` | A long random string (`openssl rand -hex 24`) |
   | `FOLIO_SECRET` | Optional. `openssl rand -hex 32`. Empty means the app generates one and keeps it on the data volume. Never change it afterwards. |
   | `FOLIO_PORT` | Optional, default `4870` |
   | `FOLIO_BIND` | Optional, default `0.0.0.0`. Use `127.0.0.1` behind a proxy on the same host. |

   Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_ALLOWED_DOMAINS`, `CURSOR_API_KEY`, `FOLIO_IMAGE` (to pin a
   release, e.g. `ghcr.io/evergreen-it-dev/folio:v0.1.0`).
4. **Deploy the stack**. When `app` shows **healthy**, open the address. The
   first account is the administrator.

For HTTPS point your reverse proxy at the host's port `4870` (or attach the
`app` service to the proxy's network), and make it pass WebSocket connections
(the `Upgrade` and `Connection` headers); real-time editing uses them.
`PUBLIC_URL` must be the `https://` address.

## Deploy from Git instead

Choose **Repository**, repository `https://github.com/evergreen-it-dev/folio`,
Compose path `deploy/portainer/stack.yml`, and set the same variables. Portainer
can then redeploy when the file changes (GitOps updates).

## Update

Open the stack > **Editor** > **Update the stack**, ticking **Re-pull image
and redeploy**. The database migrates itself on start.

## Backup

From the host (or Portainer's console for each container):

```bash
docker exec <folio-postgres-container> pg_dump -U folio folio > folio-db.sql
docker exec <folio-app-container> tar czf - -C /app/data . > folio-data.tgz
```

The container names are shown on the stack page.

## Limits

One instance of the app (the disk is local to the container). The stack was
run locally with the same variables Portainer passes; it has not been deployed
through a live Portainer.
