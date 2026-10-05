# Folio on Easypanel

[Easypanel](https://easypanel.io/) is a server control panel with app templates.
A template is two files, [`meta.yaml`](meta.yaml) (the form and the texts) and
[`index.ts`](index.ts) (which services to create), plus a logo and a screenshot.

**You need:** an Easypanel server with 2 GB of RAM or more.

## Install now (by hand, 3 minutes)

In a project:

1. **+ Service** > **Postgres**. Name it `folio-db`. Note the generated password.
2. **+ Service** > **Redis**. Name it `folio-redis`. Note its password.
3. **+ Service** > **App**. Name it `folio`.
   - **Source** > Docker image: `ghcr.io/evergreen-it-dev/folio:latest`.
   - **Environment**, replacing the words in angle brackets (the project name
     is shown at the top of Easypanel; the database name is the project name):

     ```bash
     NODE_ENV=production
     PORT=4870
     PUBLIC_URL=https://wiki.example.com
     DATABASE_URL=postgresql://postgres:<db password>@<project>_folio-db:5432/<project>
     REDIS_URL=redis://:<redis password>@<project>_folio-redis:6379
     ASSET_BACKEND=local
     FOLIO_SECRET=<run: openssl rand -hex 32>
     ```
   - **Domains**: your domain, port `4870`.
   - **Mounts**: a **Volume** named `data` at `/app/data`.
4. **Deploy**. Open the address; the first account is the administrator.

`FOLIO_SECRET` encrypts saved Git tokens and AI keys. Never change it later.
Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS`
("Sign in with Google"), `CURSOR_API_KEY` (shared AI assistant key).

## The template

`index.ts` does the same steps and generates both passwords and the secret.
Easypanel can test a template before it is published: clone
[easypanel-io/templates](https://github.com/easypanel-io/templates), copy this
folder to `templates/folio/` (the logo as `logo.svg`, plus a `screenshot.png`
such as [`docs/images/document.png`](../../docs/images/document.png)), run
`npm run dev` for the playground, and paste the JSON it produces into
Easypanel's "create a template from JSON" to try the output on a real server. Then run `npm run build` and
`npm run prettier`, and open a pull request. Their checklist asks for a pinned
image version: put the release tag in the default of `appServiceImage` (and
the version in the changelog) once it exists.

## Update

Change the image tag on the `folio` service (or keep `latest`) and **Deploy**.
The database migrates itself on start. Back up first.

## Backup

Easypanel can back up its Postgres service to S3 from the service page. The
volume `data` is the other half: copy `/app/data` from the app's volume
(Easypanel's server path is `/etc/easypanel/projects/<project>/folio/volumes/data`)
or from a shell in the app: `tar czf - -C /app/data .`.

## Limits

- One instance of the app.
- Written after the structure of Easypanel's own templates; not run in a live
  Easypanel yet. Their Redis service is password-protected, which the template
  accounts for.
