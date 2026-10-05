# Coolify service catalog: draft pull request

Not submitted yet. Coolify's contribution guide
([Adding a service](https://coolify.io/docs/get-started/contribute/service))
requires **at least 1,000 GitHub stars** on the project, so this waits.

## Files for the pull request

| Here | In `coollabsio/coolify` (open the PR against `next`) |
|---|---|
| [`folio.yaml`](folio.yaml) | `templates/compose/folio.yaml` |
| [`folio.svg`](folio.svg) | `svgs/folio.svg` |

And, as a second pull request that Coolify asks to link to the first, in
`coollabsio/coolify-docs`:

| Here | There |
|---|---|
| [`folio.mdx`](folio.mdx) | `content/docs/services/folio.mdx` |
| `folio.svg` or a PNG | `public/images/services/` |

## Before submitting

1. Publish a release so `ghcr.io/evergreen-it-dev/folio` exists and is public.
2. Pin the image tag in `folio.yaml` to that release instead of
   `${FOLIO_TAG:-latest}` if the reviewers ask for it.
3. Test the template the way Coolify asks: in a Coolify instance, **Docker
   Compose Empty**, paste `folio.yaml`, deploy, open the address.
4. Keep the header comments at the top (`documentation`, `slogan`, `category`,
   `tags`, `logo`, `port`).
