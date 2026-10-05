# Folio on Dokploy

[Dokploy](https://dokploy.com/) is a self-hosted PaaS. Its templates are three
files: a Compose file, a `template.toml` that says which service gets a domain
and which values to generate, and a `meta.json` for the catalog.

**You need:** a Dokploy instance with a server of 2 GB RAM or more.

## Install now (without the catalog)

1. Create a project, then **Create Service** > **Compose**. Choose the
   **Docker Compose** type.
2. Paste [`docker-compose.yml`](docker-compose.yml) into the editor.
3. Open the **Environment** tab and set:

   ```bash
   PUBLIC_URL=https://wiki.example.com
   POSTGRES_PASSWORD=<run: openssl rand -hex 24>
   FOLIO_SECRET=<run: openssl rand -hex 32>
   ```

   `PUBLIC_URL` is the address people open; `FOLIO_SECRET` encrypts saved Git
   tokens and AI keys and must never change afterwards. Google and Cursor
   settings are optional: add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_ALLOWED_DOMAINS`, `CURSOR_API_KEY` if you use them.
4. In **Domains** add `wiki.example.com`, service `folio`, port `4870`, HTTPS
   on. Point the DNS record at the server.
5. **Deploy**. Open the address; the first account is the administrator.

## Using the template

[`template.toml`](template.toml) is what Dokploy's template format
([Dokploy/templates](https://github.com/Dokploy/templates)) uses to generate the
domain, the password and the secret for you. To try it before it is in the
catalog, use Dokploy's **Import** with the base64 of the compose and toml (the
templates repository's [CONTRIBUTING.md](https://github.com/Dokploy/templates/blob/main/CONTRIBUTING.md)
explains the preview that every pull request gets).

### Submitting to the catalog

Open a pull request to [Dokploy/templates](https://github.com/Dokploy/templates)
with a folder `blueprints/folio/` containing `docker-compose.yml`,
`template.toml`, `meta.json` and `folio.svg` from this directory. Run
`node build-scripts/generate-meta.js --check` first, as their guide asks.
Before submitting, replace `latest` in the compose file with the released
version tag (they ask for pinned versions) and set the same in `meta.json`.

## Update

In the service, change the image tag in the compose file (or keep `latest` and
**Redeploy**), then deploy. The database migrates itself on start. Dokploy can
schedule backups for its own database services; for the database inside this
Compose file, use the commands below.

## Backup

On the server, with the container names from `docker ps | grep folio`:

```bash
docker exec <postgres-container> pg_dump -U folio folio > folio-db.sql
docker exec <folio-container> tar czf - -C /app/data . > folio-data.tgz
```

## Limits

- One instance of the app (the disk is local).
- The Compose file was run locally with the same variables Dokploy would
  provide; it has not been deployed on a live Dokploy instance.
