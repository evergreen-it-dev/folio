# Installing Folio

Folio runs as three containers: the application, PostgreSQL and Redis. One
command starts all of them.

- [On your computer](#on-your-computer)
- [On a server with HTTPS](#on-a-server-with-https)
- [Settings](#settings)
- [Updating](#updating)
- [Backup and restore](#backup-and-restore)
- [One-click and PaaS](#one-click-and-paas)
- [Other platforms](#other-platforms)
- [When something goes wrong](#when-something-goes-wrong)

## On your computer

1. Install [Docker Desktop](https://docs.docker.com/get-docker/) and
   [Git](https://git-scm.com/downloads), and start Docker.
2. Open a terminal and run:

   ```bash
   git clone https://github.com/evergreen-it-dev/folio.git
   cd folio
   docker compose up -d
   ```

3. Wait for the first build to finish. It takes a few minutes and downloads
   about 1 GB.
4. Open <http://localhost:4870> and fill in the form. The first account
   becomes the administrator of the instance.
5. A short welcome follows: choose what to create first and name your first
   space, or connect a Git repository you already have. "Skip" creates the
   space straight away.

To stop Folio: `docker compose stop`. To start it again: `docker compose up -d`.
Your pages stay where they are.

## On a server with HTTPS

You need a server with Docker, a domain name, and a DNS record for that domain
pointing at the server. Ports 80 and 443 must be open.

```bash
git clone https://github.com/evergreen-it-dev/folio.git
cd folio
cp .env.example .env
```

Edit `.env`:

```bash
PUBLIC_URL=https://wiki.example.com
FOLIO_DOMAIN=wiki.example.com
FOLIO_BIND=127.0.0.1
```

Then start Folio together with the bundled HTTPS proxy:

```bash
docker compose --profile https up -d
```

The proxy ([Caddy](https://caddyserver.com/)) obtains the certificate and
renews it by itself.

**Your own reverse proxy** works too. Skip `--profile https`, keep
`FOLIO_BIND=127.0.0.1`, and forward requests to `127.0.0.1:4870`. The proxy
must pass WebSocket connections through (`Upgrade` and `Connection` headers) —
real-time editing uses them.

**Without HTTPS** (a home or office network), set `PUBLIC_URL` to the exact
address people type, for example `PUBLIC_URL=http://192.168.1.20:4870`. With
an `http://` address Folio does not mark its cookies as HTTPS-only, so signing
in works. Do not expose such an instance to the internet.

## Settings

All settings live in the `.env` file next to `docker-compose.yml`. Copy
`.env.example` to `.env` and change what you need. After editing, apply with
`docker compose up -d`. A setting left empty or unset keeps its default.

| Setting | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:4870` | The address people use to open Folio. Invitation and share links are built from it. |
| `FOLIO_PORT` | `4870` | Port on the host machine. |
| `FOLIO_BIND` | `0.0.0.0` | `127.0.0.1` makes Folio reachable from the same machine only. |
| `FOLIO_DOMAIN` | — | Domain for the bundled HTTPS proxy. |
| `FOLIO_SECRET` | generated | Encrypts saved git tokens and AI keys. See below. |
| `POSTGRES_PASSWORD` | `folio` | Database password, applied when the database is first created. |
| `FOLIO_OIDC_SSO_ISSUER`, `FOLIO_OIDC_SSO_CLIENT_ID`, `FOLIO_OIDC_SSO_CLIENT_SECRET` | — | Single sign-on through an OpenID Connect provider (Keycloak, Authentik, Entra ID, Okta…). More `FOLIO_OIDC_SSO_*` settings below; see [Single sign-on](#single-sign-on-openid-connect). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Turn on "Sign in with Google". |
| `GOOGLE_ALLOWED_DOMAINS` | empty | Email domains allowed to sign in with Google, comma-separated. Empty means nobody new gets in. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | — | Turn on "Connect with GitHub" in "Git access" (a GitHub OAuth App). See below. |
| `FOLIO_SLACK_*`, `FOLIO_TEAMS_*` | — | Link previews in Slack and Microsoft Teams. See [CHAT-PREVIEWS.md](CHAT-PREVIEWS.md). |
| `CURSOR_API_KEY` | — | Server-wide fallback key for the AI assistant, used when neither the person, the space nor the instance has a key of their own. Administrators can also set an instance key and per-space keys in the interface; those win over this variable. |
| `ANTHROPIC_API_KEY` | — | Server-wide fallback key for Claude in the AI assistant, used after the person's, the space's and the instance's keys. Claude runs only on an API key billed by usage, never on a subscription. |
| `FOLIO_CODEX_ENABLED`, `FOLIO_MINIMAX_ENABLED` | off | Optional AI providers, switched off and hidden unless set to `1`. `FOLIO_MINIMAX_ENABLED` adds MiniMax (an API key; `MINIMAX_API_KEY` and `MINIMAX_BASE_URL` set a server-wide key and endpoint). `FOLIO_CODEX_ENABLED` adds Codex through a person's own ChatGPT sign-in, only for a server you run for yourself: OpenAI has not confirmed this use on shared servers, and device-code sign-in must be enabled in the ChatGPT security settings. |
| `PUBLIC_SITES_DOMAIN` | — | Parent domain for the subdomains of public sites, for example `sites.example.com`. See [Public sites](#public-sites). |
| `PUBLIC_EXPORT_PER_MINUTE` | `6` | PDF and DOCX downloads one address may start per minute on public sites. |
| `PUBLIC_ASSISTANT_RUNS_PER_HOUR` | `20` | Questions one address may ask Folio AI per hour across all public sites. |
| `PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR` | `200` | Questions all visitors of one public site together may ask Folio AI per hour. |
| `TRUST_PROXY` | off | Set `true` behind a reverse proxy on the same host or Docker network so the sign-in rate limit is per visitor instead of one shared bucket. Only a proxy on a loopback or private address is believed. |
| `FOLIO_SESSION_TTL_DAYS` | `30` | How long a browser sign-in lasts, in days, counted from sign-in (not extended while the person works). A missing or invalid value keeps 30. |
| `FOLIO_DEMO_MODE` | off | `1` turns on public-demo mode for running your own demo: one-click demo accounts and a banner, and tokens, the assistant, outbound git and import, new spaces, share links and invitations are disabled. The accounts it offers are listed in `FOLIO_DEMO_ACCOUNTS` (a JSON array, in single quotes in `.env`); `FOLIO_DEMO_RESET_HOURS`, `FOLIO_DEMO_MAX_UPLOAD_MB`, `FOLIO_DEMO_MCP_RPM` and `FOLIO_DEMO_MCP_WRITES_PER_HOUR` are optional. See `.env.example`. |
| `FOLIO_DEFAULT_REPO_URL` | empty | Prefilled into the repository field of the "create space" dialog. |
| `CURSOR_AGENT_TIMEOUT_MS`, `CURSOR_AGENT_TIMEOUT_MS_AGENT`, `CURSOR_AGENT_IDLE_TIMEOUT_MS` | `300000`, `1800000`, `600000` | Deadlines of one assistant run in milliseconds: Ask mode, Agent mode, and no activity at all. Empty keeps the default. |

### Link previews

When someone pastes a link to your Folio into LinkedIn, Slack, Telegram or a
similar app, the app reads the first page the server returns and shows a card.
Folio writes the card's tags (`og:*` and `twitter:*`) into that page: a neutral
title and description and a Folio picture by default, or the public-demo text
and picture when `FOLIO_DEMO_MODE=1`. A share link shows the shared page's own
title and excerpt instead.

| Setting | What it does |
|---|---|
| `FOLIO_OG_TITLE` | Title of the card. |
| `FOLIO_OG_DESCRIPTION` | Description under the title. |
| `FOLIO_OG_IMAGE` | Picture, ideally 1200x630: a path under your site (for example `/og/og-folio.png`) or an absolute address. |

Any of them left empty keeps the default. The bundled pictures
(`web/public/og/`) carry the project's own name and address; point
`FOLIO_OG_IMAGE` at your own picture if the card should look like your
installation. Set `PUBLIC_URL` to the public address: the card's links are
built from it, and behind a proxy the address the server sees may be internal.

These cards are the same for everyone. For previews that show the page itself
(title, text, headings) to the people who may read it, connect Folio to Slack or
Microsoft Teams: [CHAT-PREVIEWS.md](CHAT-PREVIEWS.md).

### Optional analytics hook (off by default)

Folio sends no telemetry. Nothing in it contacts the Folio authors or anyone
else about how you use it, and a default install never will.

For people who run a public demo or a showcase instance and want to see how it
is used, there is an opt-in hook for a [PostHog](https://posthog.com) project
that you own. It stays off until you set a project key:

| Setting | What it does |
|---|---|
| `FOLIO_POSTHOG_KEY` | Your PostHog project token (the public `phc_...` key). Empty means off: the browser never loads the analytics library and the server never opens a connection. |
| `FOLIO_POSTHOG_HOST` | Ingestion host, for example `https://eu.i.posthog.com`. Default `https://us.i.posthog.com`. |

When it is on, the web app sends anonymous events only: which kind of page was
opened or edited (document, table, board, form, file), the space slug, whether
a search found anything, and the steps of an AI-app connection. It never sends
page text, titles, search words, names or e-mail addresses. Visitors are not
identified and get no person profile; the visit id is kept in the tab's session
storage, not in a cookie. Session recordings, if you enable them in PostHog,
mask all inputs and the content of pages, tables, boards, forms and files. The
browser's Do Not Track setting turns it off. In PostHog, also enable "Discard
client IP data" for the project.

### Optional error reporting (off by default)

Folio can report its own errors to a [Sentry](https://sentry.io) project that
you own, and show a "Report a problem" item in the user menu that sends a
message (an optional screenshot and, if the person leaves the box ticked, a
masked recording of their recent actions) to the same project. The same dialog
opens from the "Found an issue?" link in a board's help dialog and from a
"Report a problem" button on the error screens, with the crash attached. Nothing is reported to
the Folio authors. It stays off until you set a DSN:

| Setting | What it does |
|---|---|
| `SENTRY_DSN` | The DSN of your Sentry project (a public key). Empty means off: the browser never loads the Sentry library, the server never opens a connection and the menu item is not shown. |
| `SENTRY_ENVIRONMENT` | The environment tag. Default `production` when `NODE_ENV=production`, otherwise `development`. |
| `SENTRY_TRACES_SAMPLE_RATE` | Share of requests traced for performance, 0 to 1. Default `0.1`; `0` turns tracing off. |
| `SENTRY_RELEASE` | The release name shown in Sentry. Default: the build's `FOLIO_RELEASE` (the image tag or short git sha when you build it with `--build-arg FOLIO_RELEASE=...`), or none. |
| `SENTRY_REPLAY` | Session Replay in the browser, with all text hidden (see below). On when `SENTRY_DSN` is set; `0`, `false` or `off` turns it off. |
| `SENTRY_REPLAY_ON_ERROR` | 0 to 1: the share of visits with an error whose last minute of actions is sent with the error. Default `1`. |
| `SENTRY_REPLAY_SESSION_RATE` | 0 to 1: the share of whole visits recorded and sent from the start. Default `0`: nothing is sent unless there is an error or the person attaches it to a report. |
| `SENTRY_PROFILES` | `1` adds CPU profiles to the traced requests. Default off. Uses the optional `@sentry/profiling-node` package; if it cannot load on your platform, profiling is skipped. |

What is sent: unhandled errors in the server and in the browser, server
requests that end in a 5xx, a sample of performance traces, and the internal id
of the signed-in user (no name, no e-mail). When a person uses "Report a
problem": the message they typed, a screenshot only if they attach or paste
one, the page address without its query string, the page id and kind, the
release and the browser.

Recording of recent actions (Session Replay). Unless `SENTRY_REPLAY=0`, the
browser keeps the last minute or so of what a person did in a tab (clicks,
scrolling, which screens opened) in memory only. It leaves the browser in three
cases: an error happens (`SENTRY_REPLAY_ON_ERROR`), the visit is among the
sampled ones (`SENTRY_REPLAY_SESSION_RATE`), or the person leaves "Attach a
recording of recent actions (text hidden)" ticked when sending a report (it is
ticked by default and the person can untick it; unticked, nothing is sent and
the buffer is not attached). Everything is masked by default: all text, form
fields and images are replaced by placeholders, board drawings (canvas) and
embedded frames are not recorded, and no request or response bodies or headers
are captured. Only fixed interface chrome that is explicitly marked (the board
View/Edit switch, the error screens, the report dialog) shows its words. Click
trails keep the element's CSS path (tag, id, classes), never its text or
labels.

What is never sent: page content or titles, search words, text typed in forms
and editors, request bodies, cookies, `Authorization` headers, query strings
(share links and tokens ride in them; a share token in a path is replaced by
`[token]`). Page text, titles and typed text are masked in any recording, not
removed from the page itself, so treat a recording as personal data of your
users and keep the Sentry project private. Expected 4xx answers (not found,
forbidden, validation, rate limits) are not reported. Sentry itself derives a
country from the visitor's IP address when an event arrives; turn on "Prevent
Storing of IP Addresses" in the project's Security & Privacy settings if you do
not want that.

Readable stack traces for the web app need source maps. A build that is given
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_URL` (for a
non-US region, for example `https://de.sentry.io`) and `FOLIO_RELEASE`
uploads them to Sentry and deletes the `.map` files from the output, so they
are never served. Without the token the build makes no source maps at all. In a
Docker build pass the token as a secret, not an argument:

```bash
docker build \
  --build-arg FOLIO_RELEASE=$(git rev-parse --short HEAD) \
  --build-arg SENTRY_ORG=my-org --build-arg SENTRY_PROJECT=my-project \
  --build-arg SENTRY_URL=https://de.sentry.io \
  --secret id=sentry_auth_token,src=./sentry-token.txt \
  -t folio .
```

### The secret

Folio encrypts saved git tokens and AI keys (personal, space and instance
keys) with `FOLIO_SECRET`. If you leave it empty, a random one is generated on first start and stored on the
data volume as `/app/data/.folio-secret`. It is included in the data backup
described below.

If you set your own, never change it afterwards: credentials saved earlier
would stop decrypting and would have to be entered again.

### Single sign-on (OpenID Connect)

People can sign in through your identity provider with OpenID Connect: Keycloak,
Authentik, Microsoft Entra ID, Okta, Google, or any other provider that publishes
`/.well-known/openid-configuration`. Folio uses the authorization code flow with
PKCE and checks the ID token's signature, issuer, audience, expiry and nonce.
For SAML 2.0 see the next section; for provisioning accounts and groups from
the identity provider see [SCIM provisioning](#scim-provisioning).

A provider is set up in one of two ways:

- **In the interface**: an instance administrator opens the account menu →
  **Single sign-on** (`/admin/auth`), adds the provider and presses **Test
  connection**. The test signs in once in a popup and shows the claims the
  provider sent, without creating or linking an account. The client secret is
  stored encrypted with `FOLIO_SECRET` and is never shown again.
- **With environment variables** (read-only in the interface). Each provider
  has a short name, its *slug*; the bundled `docker-compose.yml` passes one
  provider with the slug `sso`:

| Setting | What it does |
|---|---|
| `FOLIO_OIDC_SSO_ISSUER` | Issuer URL, for example `https://sso.example.com/realms/acme`. |
| `FOLIO_OIDC_SSO_CLIENT_ID`, `FOLIO_OIDC_SSO_CLIENT_SECRET` | The client registered at the provider. Without a secret Folio acts as a public client (PKCE only). |
| `FOLIO_OIDC_SSO_NAME` | Button text: "Continue with <name>". |
| `FOLIO_OIDC_SSO_DOMAINS` | Email domains of your organization, comma-separated. Only these may sign in through the provider; the login page sends these emails to it; existing accounts in these domains can be linked. Empty: anyone the provider signs in, no linking. |
| `FOLIO_OIDC_SSO_JIT` | `true`: a person without an account gets one at first sign-in (no password, not an administrator). Otherwise only existing and invited people get in. |
| `FOLIO_OIDC_SSO_JIT_SPACES` | Spaces a new account joins, for example `handbook:viewer,engineering:editor`. |
| `FOLIO_OIDC_SSO_ENFORCE` | `true`: people in those domains cannot use a password at all. Instance administrators keep an emergency password sign-in at `<PUBLIC_URL>/login?local`; every such sign-in is written to the audit log. |
| `FOLIO_OIDC_SSO_SCOPES` | Default `openid email profile`. |
| `FOLIO_OIDC_SSO_GROUP_SYNC`, `_GROUP_SYNC_MODE`, `_GROUP_MAP`, `_GROUP_CREATE`, `_GROUP_ALLOW` | Group sync, see [Syncing groups](#syncing-groups-from-the-identity-provider). |
| `FOLIO_OIDC_SSO_EMAIL_CLAIM`, `_NAME_CLAIM`, `_GROUPS_CLAIM` | Claim names, default `email`, `name`, `groups`. The groups claim feeds group sync, see [Syncing groups](#syncing-groups-from-the-identity-provider). |

Outside the bundled compose file (or to add a second provider) use any slug:
`FOLIO_OIDC_<SLUG>_ISSUER` and so on, for example `FOLIO_OIDC_KEYCLOAK_ISSUER`
(slug `keycloak`). Register this redirect URL at the provider:
`<PUBLIC_URL>/api/auth/oidc/<slug>/callback` (the admin screen shows it with a
copy button). An `http://` issuer is accepted for `localhost` only, or with
`FOLIO_OIDC_ALLOW_HTTP=1`.

How accounts are matched: the provider's account id (`sub`) is linked to one
Folio account. At the first sign-in, an existing Folio account with the same email
is linked only when the provider says the email is verified and its domain is in
the list; otherwise the sign-in is refused with an explanation. An invitation
pinned to an email of an enforced domain is accepted through the provider.

Provider notes:

- **Keycloak**: issuer `https://<host>/realms/<realm>`. Create a confidential
  OpenID Connect client with "Standard flow"; for a groups claim add a "Group
  Membership" mapper with the claim name `groups` (turn off "Full group path"
  for plain names).
- **Authentik**: create an OAuth2/OpenID provider and an application; issuer
  `https://<host>/application/o/<application-slug>/` (with the trailing slash).
- **Microsoft Entra ID**: register an app with a web redirect URI; issuer
  `https://login.microsoftonline.com/<tenant-id>/v2.0` (a tenant id, not
  `common`). Entra does not send `email_verified`, so existing accounts are not
  linked automatically: invite people, let them create accounts with JIT, or
  provision them over [SCIM](#scim-provisioning), which Folio trusts by email
  (see there). Add
  the optional `email` claim, and `groups` if you want it.
- **Okta**: an OIDC web application; issuer `https://<org>.okta.com` (or your
  custom authorization server, `https://<org>.okta.com/oauth2/default`). Add a
  `groups` claim in the authorization server if you want it.
- **Google**: see below.

### Syncing groups from the identity provider

Folio can put people into its [groups](FEATURES.md) according to the groups the
identity provider says they belong to. It works the same for OpenID Connect and
SAML and is off until you turn it on for a provider (provider dialog → **Group
sync**, or the variables below).

At **every** sign-in through the provider (a first sign-in that creates the
account included) Folio reads the groups claim or attribute and:

- adds the person to the matching Folio groups they are not in yet;
- removes them from groups the provider put them in earlier and no longer
  reports.

Only memberships that came from that provider are ever removed. A person added
to a group by hand stays in it, and a manager flag set in Folio is never
changed. Archived groups are skipped. If removing someone would leave a space
without an administrator (the group is the only source of the admin role), the
membership is kept and a warning goes to the audit log; the sign-in is never
refused because of group sync. Changes show up at the next sign-in, not
instantly. Each change is written to the audit log (`group.member_add`,
`group.member_remove` with source `idp`, and one `auth.group_sync` summary per
sign-in); a skipped sync is `auth.group_sync_skipped` with the reason.

| Setting (provider dialog / environment) | What it does |
|---|---|
| **Sync groups at sign-in** / `FOLIO_OIDC_<SLUG>_GROUP_SYNC`, `FOLIO_SAML_<SLUG>_GROUP_SYNC` | `true` turns it on. |
| **Groups claim / attribute** / `_GROUPS_CLAIM`, `_GROUPS_ATTR` | Where the groups are, default `groups`. A dotted path such as `realm_access.roles` works for OpenID Connect. |
| **Match** / `_GROUP_SYNC_MODE` | `name` (default): an IdP group matches the Folio group with the same slug or name (case does not matter). `mapping`: only the table below is used. |
| **Table** / `_GROUP_MAP` | `IdP value=folio-group-slug`, comma-separated: `Engineering=eng,3f2a9c1e-…=admins`. Use it when the provider sends ids (Entra ID sends object ids) or names that differ from yours. Setting a map without a mode means `mapping`. |
| **Create missing groups** / `_GROUP_CREATE` | `true`: an IdP group with no match becomes a new Folio group (marked as coming from OIDC or SAML; its slug is made from the name). |
| **Only these IdP groups** / `_GROUP_ALLOW` | Optional filter applied first: prefixes (`folio-,team-`) or a regular expression between slashes (`/^folio-/`). Use it so that unrelated directory groups do not become Folio groups. |

Groups that came from a provider show a badge on the Groups tab of the Access
page; their provider-sourced members cannot be removed by hand (a person added
manually can).

Per provider:

- **Keycloak**: add the *Group Membership* mapper (OpenID Connect client, claim
  name `groups`, "Full group path" off) or, for SAML, the *Group list* mapper.
  Values are the group names, so `name` matching works as is.
- **Microsoft Entra ID**: *Token configuration → Add groups claim*. Choose
  *Groups assigned to the application* so that the token stays small, and
  prefer *Group ID*: it sends object ids, so use a table
  (`<object id>=folio-group`). With *All groups* or with sAMAccountName names
  the list can grow too long: past 200 groups in a JWT (150 in SAML) Entra sends a
  pointer to Microsoft Graph instead of the list ("overage"). Folio does not
  call Graph: in that case **nothing is added or removed** and
  `auth.group_sync_skipped` with reason `overage` is audited. Restrict the claim
  to the groups assigned to the application to avoid it.
- **Okta**: add a *groups claim* to the authorization server (OpenID Connect) or
  a group attribute statement named `groups` (SAML), with a filter such as
  *Starts with* `folio-` so that only the relevant groups are sent. Values are
  group names.

### Single sign-on (SAML 2.0)

Folio also signs people in through a SAML 2.0 identity provider (IdP): Microsoft
Entra ID, Okta, Keycloak, Google Workspace, ADFS and others. The sign-in starts
at Folio (SP-initiated); the account rules are the same as for OpenID Connect:
allowed domains, JIT, invitations, enforced sign-in with the administrators'
emergency login.

What Folio checks in every response: the assertion is signed with the IdP's
certificate (a signed response around an unsigned assertion is refused), its
issuer is the IdP's entity ID, its audience is Folio's entity ID, it is inside
its validity window (at most 120 seconds of clock difference are tolerated), it
answers the sign-in request this browser started, and it has not been used
before. Documents with a `DOCTYPE` are refused. Encrypted assertions, signed
sign-in requests and single logout are not supported.

**Set up in the interface**: account menu → **Single sign-on** → **Add
provider** → protocol **SAML 2.0**. Give the IdP's metadata URL (Folio re-reads
it every hour, so certificate rollovers are picked up) or paste the metadata XML;
without metadata, fill in the IdP entity ID, SSO URL and signing certificate.
The provider card then shows what to register at the IdP, each with a copy
button:

| At the IdP | Value |
|---|---|
| Entity ID / Identifier / Audience URI | `<PUBLIC_URL>/api/auth/saml/<slug>/metadata` (or your own value in **Folio entity ID**) |
| ACS / Reply / Single sign-on URL | `<PUBLIC_URL>/api/auth/saml/<slug>/acs` (HTTP-POST) |
| SP metadata, if the IdP can import it | `<PUBLIC_URL>/api/auth/saml/<slug>/metadata` |

Then press **Test connection**: it signs in once in a popup and shows the
attributes the IdP sent, without creating or linking an account.

**NameID and email.** Folio identifies a person by the IdP's entity ID plus the
NameID, so ask the IdP for a *persistent* NameID (an email NameID works too, but
the link breaks when the email changes; a transient one is refused). The email
comes from the email attribute or, without one, from an email-format NameID.
Left at their defaults (`email`, `name`, `groups`), the attribute settings also
recognize the usual Entra ID, Okta, Keycloak and Google names, such as
`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`. Folio
reads the groups attribute for group sync, see
[Syncing groups](#syncing-groups-from-the-identity-provider).

**Linking existing accounts.** SAML has no "email verified" flag. An existing
Folio account is linked at the first SAML sign-in only when **The IdP is
authoritative for these domains' emails** is on and the email's domain is in
the allowed domains. Turn it on only when the IdP owns those accounts (your
company directory). Otherwise invite people or let JIT create their accounts.
Without it, a person who already has a Folio account is told the provider
"isn't trusted to confirm email addresses for linking".

**OpenID Connect and SAML for the same domain.** A linked identity belongs to
one provider. Someone linked through one protocol who signs in through the other
goes through the linking rules again: a verified email (OpenID Connect) or an
authoritative IdP (SAML), a domain in the allowed list, and no identity yet at
that provider. We recommend one protocol per domain; if you run both while
migrating, turn on **The IdP is authoritative** on the SAML provider so existing
accounts link on the first sign-in.

**IdP-initiated sign-in** (starting from the IdP's app portal) is off by
default: such a response is not tied to anything the browser started. Turn on
**Accept IdP-initiated sign-in** only if you need it.

**With environment variables** (read-only in the interface), with any slug, for
example `ENTRA`. The bundled `docker-compose.yml` passes the `FOLIO_SAML_SSO_*`
ones (slug `sso`; set either these or `FOLIO_OIDC_SSO_*`):

| Setting | What it does |
|---|---|
| `FOLIO_SAML_<SLUG>_METADATA_URL` | The IdP's metadata URL (`https`; `http` only for `localhost` or with `FOLIO_OIDC_ALLOW_HTTP=1`). |
| `FOLIO_SAML_<SLUG>_METADATA` | The metadata XML itself, instead of the URL. |
| `FOLIO_SAML_<SLUG>_SSO_URL`, `_ENTITY_ID`, `_CERT` | Without metadata: the IdP's SSO URL, entity ID and signing certificate (PEM or base64; `\n` for newlines is fine). They also override the metadata. |
| `FOLIO_SAML_<SLUG>_SP_ENTITY_ID` | Folio's entity ID, if the IdP needs a specific one. |
| `FOLIO_SAML_<SLUG>_NAMEID_FORMAT` | `persistent` (default), `email` or `unspecified`. |
| `FOLIO_SAML_<SLUG>_EMAIL_AUTHORITATIVE` | `true`: emails in the allowed domains count as verified (linking, see above). |
| `FOLIO_SAML_<SLUG>_ALLOW_IDP_INITIATED` | `true`: accept IdP-initiated sign-in. |
| `FOLIO_SAML_<SLUG>_EMAIL_ATTR`, `_NAME_ATTR`, `_GROUPS_ATTR` | Attribute names (defaults above). |
| `FOLIO_SAML_<SLUG>_NAME`, `_DOMAINS`, `_JIT`, `_JIT_SPACES`, `_ENFORCE` | As for OpenID Connect. |
| `FOLIO_SAML_<SLUG>_GROUP_SYNC`, `_GROUP_SYNC_MODE`, `_GROUP_MAP`, `_GROUP_CREATE`, `_GROUP_ALLOW` | Group sync, see [Syncing groups](#syncing-groups-from-the-identity-provider). |

The cookie that ties the IdP's answer to the browser is `SameSite=None; Secure`
when Folio runs on HTTPS, because the IdP posts the answer from its own site. On
plain `http` (local testing) the IdP must be on the same site, such as
`localhost`.

IdP notes:

- **Microsoft Entra ID**: Enterprise applications → New application → Create
  your own → *Integrate any other application* → Single sign-on → SAML. Basic
  SAML configuration: Identifier = Folio's entity ID, Reply URL = the ACS URL.
  Copy the *App Federation Metadata Url* into the metadata URL. Keep *Unique
  User Identifier* as `user.objectid` with a persistent format (or
  `user.userprincipalname`). Entra sends the email as
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` and,
  after *Add a group claim*, groups as
  `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`; both are
  recognized.
- **Okta**: Applications → Create App Integration → SAML 2.0. Single sign-on
  URL = the ACS URL ("Use this for Recipient URL and Destination URL" on),
  Audience URI = Folio's entity ID, Name ID format *Persistent* (or
  *EmailAddress*), Application username *Okta username* or *Email*. Add
  attribute statements `email` → `user.email`, `name` → `user.displayName`, and a
  group attribute statement `groups` if you want it. Use the metadata URL from
  the app's Sign On tab.
- **Keycloak**: Clients → Create client → SAML, Client ID = Folio's entity ID,
  Valid redirect URIs = `<PUBLIC_URL>/*`. Keep "Sign assertions" on, turn
  "Client signature required" off (Folio does not sign requests), Name ID format
  *persistent* with "Force name ID format". Add mappers: *User Property* `email`
  → `email`, `firstName` → `givenName`, `lastName` → `sn`, and *Group list* →
  `groups` ("Single group attribute" on, "Full group path" off). Metadata URL:
  `https://<host>/realms/<realm>/protocol/saml/descriptor`.
- **Google Workspace**: Admin console → Apps → Web and mobile apps → Add app →
  Add custom SAML app. Download the IdP metadata and paste it (Google has no
  metadata URL). ACS URL = the ACS URL, Entity ID = Folio's entity ID, Name ID
  format *EMAIL* with *Basic Information > Primary email*, and set Folio's
  NameID format to `email`. Map *Primary email* to
  `email` and, for groups, *Group membership* to `groups`. Turn the app on for
  the right organizational units.

### SCIM provisioning

An identity provider that already signs people in to Folio (an OpenID Connect or
SAML provider above) can also create, update and deactivate their accounts and
groups over SCIM 2.0: Okta, Microsoft Entra ID, Keycloak (with a SCIM plugin),
OneLogin, JumpCloud and others.

**Turn it on**: account menu → **Single sign-on** → the provider's card →
**SCIM provisioning** → **Generate token**. Copy the token at once: it is shown
only once and stored hashed. Give the identity provider:

| At the IdP | Value |
|---|---|
| SCIM base URL / Tenant URL | `<PUBLIC_URL>/scim/v2` (shown with a copy button) |
| Authentication | HTTP header, `Authorization: Bearer <token>` |

**Rotate token** replaces it (the old one stops working at once); **Revoke
token** turns SCIM off for the provider, leaving provisioned people and groups
as they are. The panel shows the last sync, how many people and groups the
provider manages, and links to the `scim.*` events in the audit log
(`/admin/audit`). Each token can only see and change the people and groups of
its own provider.

What the identity provider can do:

- **Users**: create (an account with no password, never an administrator),
  update the name and email, deactivate (`active: false`, or DELETE) and
  reactivate. Deactivation ends every session, API token and connected app of
  the person at once. DELETE never deletes the account: it is deactivated and
  hidden from SCIM; provisioning the same person again brings it back. The last
  active instance administrator cannot be deactivated.
- **An existing Folio account** with the same email is taken over only when its
  domain is in the provider's allowed domains, it is not an instance
  administrator and it is not linked to another provider; otherwise SCIM gets a
  409 and you link it by hand (the person signs in through the provider once).
- **Groups**: create, rename, set members, add and remove members, and DELETE,
  which archives the group (its space roles stop applying; provisioning a group
  with the same `externalId` again restores it). Groups made over SCIM are
  ordinary Folio groups: give them roles in spaces as usual. A membership added
  by hand in Folio is never removed by SCIM. A change that would leave a space
  without an administrator is refused with a 409 that names the space.
- **No JIT while SCIM is on**: accounts then come only from SCIM, so creating
  accounts at first sign-in is turned off for the provider (for a provider
  defined by environment variables, `_JIT` is ignored while SCIM is on).

How a provisioned person is recognized at their first sign-in through the
provider: the account is linked when the sign-in's subject (OIDC `sub`, SAML
NameID) equals the `externalId` the provider sent over SCIM, or, for SAML, the
SCIM `userName`. Failing that, a provisioned person who has not signed in yet is
also recognized by email: the sign-in email equals, exactly (case aside), the
email or `userName` the same provider sent over SCIM, and its domain is in the
provider's allowed domains (when the list is not empty). This works without
`email_verified`, which Entra ID over OIDC never sends. It applies only to
accounts still waiting for their first sign-in at that provider, never to other
accounts and never across providers; deactivated people are refused. Every
other account follows the usual rule: it is linked when the email counts as
verified (OIDC `email_verified`; SAML: the IdP is marked authoritative) and its
domain is allowed.

Supported: `/Users` and `/Groups` (GET with `filter` on `userName`,
`externalId`, `emails`, `displayName`, `id`, `members` using `eq` and `and`,
paging with `startIndex` / `count` up to 200; POST, PUT, PATCH, DELETE),
`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`. Not supported: bulk
operations, sorting, ETags, passwords (ignored), `or` filters. Requests are
limited per token (`FOLIO_SCIM_RATE_PER_MINUTE`, default 1200 a minute).

IdP notes:

- **Okta**: in the app integration, General → Provisioning: SCIM; Provisioning
  → Integration: SCIM connector base URL = the base URL, unique identifier field
  `userName`, actions *Import New Users and Profile Updates*, *Push New Users*,
  *Push Profile Updates*, *Push Groups*, authentication mode *HTTP Header* with
  the token. Then To App: enable *Create Users*, *Update User Attributes*,
  *Deactivate Users*. Okta sends its user id as `externalId`, which is also the
  OIDC `sub`, so OIDC sign-in matches directly; with SAML, use *Okta username*
  as the NameID.
- **Microsoft Entra ID**: Enterprise application → Provisioning → Automatic;
  Tenant URL = the base URL, Secret Token = the token, **Test Connection**, then
  Mappings (keep `userPrincipalName` → `userName`, `mail` → work email) and
  turn provisioning on. Entra's OIDC `sub` is specific to the app and Entra
  sends no `email_verified`, so with OIDC a provisioned person is recognized at
  first sign-in by email: add the optional `email` claim, and list the domain in
  the provider's allowed domains. With SAML, the NameID `user.userprincipalname`
  equals the SCIM `userName` and matches directly.
- **Keycloak**: Keycloak has no built-in SCIM client; with a SCIM plugin (for
  example `scim-for-keycloak` or `keycloak-scim`), point it at the base URL with
  the token as a bearer token. These plugins send the Keycloak user id as
  `externalId`, which is also the OIDC `sub`.

### Sign in with Google

Create an OAuth client in the Google Cloud Console, register the redirect URI
`<PUBLIC_URL>/api/auth/google/callback`, and set the three `GOOGLE_*` values.
List the email domains that may sign in — with an empty list nobody new gets in
(people already linked to Google keep signing in). Google is an OpenID Connect
provider like the others, with the slug `google`; `GOOGLE_ENFORCE_SSO=true`
makes it mandatory for those domains.

### Connect with GitHub

Lets people link their github.com account in "Git access" with one click
instead of pasting a personal access token. It is not a way to sign in to
Folio: the person must already be signed in.

1. On GitHub, open the settings of your organization (or your own account),
   **Developer settings → OAuth Apps → New OAuth App**. Use an OAuth App, not a
   GitHub App: OAuth App tokens do not expire, so connected spaces keep
   syncing.
2. Homepage URL: your `PUBLIC_URL`. Authorization callback URL:
   `<PUBLIC_URL>/api/auth/github-connect/callback`. Leave "Enable Device Flow"
   off.
3. Generate a client secret and set `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`. `FOLIO_SECRET` must be set too (it always is with
   the bundled compose file).
4. If an organization restricts third-party application access, an owner of
   that organization approves the app once (GitHub shows a "Request" button
   on the consent screen); until then its private repositories do not appear.

Folio asks for the `repo` scope, which gives access to every repository the
person can reach. For narrower access, people can still paste a fine-grained
token (Contents: read and write, Metadata: read) instead. Connecting replaces
a github.com token saved earlier. GitHub Enterprise Server keeps using tokens.

### Public sites

A space can be published as a read-only website that anyone can open without an
account: a space or instance administrator opens the space menu, chooses
"Publish as website" and sets who can read the space to **public**. The first
of the three addresses below needs nothing from the operator; the other two do.

| Address | What the operator does |
|---|---|
| `https://wiki.example.com/public/<space>` | Nothing. It works as soon as the space is public. Set `PUBLIC_URL` to the public address of your Folio. |
| `https://<label>.sites.example.com` | Set `PUBLIC_SITES_DOMAIN=sites.example.com`, then the steps below. A space administrator then picks the label. |
| `https://docs.example.com` (a custom domain) | The domain's owner adds `CNAME docs.example.com` pointing to the host of `PUBLIC_URL`; the reverse proxy routes that host to Folio and holds a certificate for it. The space administrator types the domain into the publishing settings. |

**Subdomains.** Use a domain of its own for sites, such as
`sites.example.com`, not `*.example.com`: a wildcard would catch every other
service you run. A site's host is exactly one label under it.

1. DNS: a wildcard record `*.sites.example.com` pointing at the server (or at
   the reverse proxy).
2. A wildcard certificate for `*.sites.example.com` on the reverse proxy. Wildcard
   certificates need a DNS challenge, so the proxy needs access to your DNS
   provider.
3. The reverse proxy sends those hosts to Folio (port 4870 in the image),
   keeps the original `Host` header and passes WebSocket connections on
   `/collab` through, or data tables on the site will not update live.

**Custom domains** need the same proxy settings for each domain, with an
ordinary certificate. Folio recognizes a site by the `Host` header (behind a
trusted proxy, `X-Forwarded-Host`), so the proxy must not rewrite it. A domain
is typed without a scheme or path, cannot be the host of `PUBLIC_URL` and
cannot lie under `PUBLIC_SITES_DOMAIN` (use the subdomain field for that). A
subdomain or domain belongs to one space.

With the bundled HTTPS proxy, a custom domain is one more block in `Caddyfile`
followed by `docker compose --profile https restart caddy`:

```
docs.example.com {
	encode zstd gzip
	reverse_proxy app:4870
}
```

The bundled Caddy cannot issue a wildcard certificate (that needs a Caddy build
with the module for your DNS provider), so for subdomains most people put their
own reverse proxy in front. With nginx, for example, `server_name
*.sites.example.com;`, the wildcard certificate (certbot with a DNS plugin),
`proxy_pass http://127.0.0.1:4870;`, `proxy_set_header Host $host;` and the same
`Upgrade` and `X-Forwarded-*` headers as on the main host.

**Behind a proxy, set `TRUST_PROXY=true`.** The limits on downloads and on
questions to Folio AI are counted per address; without it every visitor shares
the proxy's address and therefore one budget.

**What to know before publishing.**

- Everything in the space is public except pages with their own access
  restrictions, the `.agent` folder and templates. A restriction is
  **inherited** by child pages: locking a page keeps everything below it closed
  too. The sidebar marks restricted pages with a small lock.
- Search engines may index a public site unless an administrator switches
  "Allow search engines to index this site" off in the publishing dialog. The
  public demo is never indexed.
- A reader on a subdomain or custom domain is always anonymous, even if signed
  in on the main address (the session cookie belongs to one host). "Sign in" on
  the site leads to the main address.
- The limits and the cache of site hosts live in the memory of the server
  process. After you change a site's address or turn publishing off, allow up
  to ten seconds.
- **Ask Folio AI** on a public site is opt-in per space and runs on the key of
  the space, else of the instance, else the key from the server environment
  (`CURSOR_API_KEY` or `ANTHROPIC_API_KEY`); the owner of that key
  pays for visitors' questions. Without any of them the site says that Folio AI
  is not set up.
- In the public demo the Folio Handbook is published at
  <https://demo.foliowiki.online/public/folio-handbook>; you can try the dialog
  there (no subdomain, custom domain or Ask), and everything resets daily.

**Public sites: SEO files in the repository.** Folio answers `robots.txt` and
`sitemap.xml` itself, per host, so there is nothing to place on disk and no new
environment variable. The look of a site (title, description, language,
favicon, logo, social image, stylesheet) and the PDF header and footer are
files in a `.folio/` folder in the repository, at the root of the space's
content (`docs/.folio/` for a space with a root path). Administrators edit
them on the space's **Site & PDF settings** page; each save is a commit that
the usual sync pushes like any page edit, so the files are ordinary repository
content to back up and review. If your reverse proxy answers `/robots.txt` or
`/sitemap.xml` itself, let the hosts of public sites reach Folio instead, and
keep the original `Host` header: the canonical links and the sitemap are built
from the primary address chosen in the publishing dialog.

## Updating

```bash
cd folio
git pull
docker compose up -d --build
```

Database changes are applied automatically when the application starts. Make
a backup first.

## Backup and restore

Folio keeps data in two places, and a backup needs both:

- the **data volume** — the git repositories of the spaces and uploaded files;
- the **database** — accounts, access rights, the search index and the state
  of collaborative editing.

Back up:

```bash
docker compose exec -T postgres pg_dump -U folio folio > folio-db.sql
docker compose exec -T app tar czf - -C /app/data . > folio-data.tgz
```

Restore onto a fresh installation (no accounts created yet):

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres psql -U folio -d folio -q < folio-db.sql
docker compose run --rm -T --no-deps --entrypoint sh app -c 'tar xzf - -C /app/data' < folio-data.tgz
docker compose up -d
```

Spaces connected to a remote Git repository also keep their pages in that
repository after each synchronization.

## One-click and PaaS

Ready-made kits install Folio from the published image
(`ghcr.io/evergreen-it-dev/folio`, for amd64 and arm64) without building
anything. Each kit has its own README with steps, settings, updating and backup.
Prefer to look first? [Try the public demo](https://demo.foliowiki.online) — pick Sam on the sign-in screen. The login is shared and the data resets every 24 hours, so don't enter personal data or API keys.

| Platform | How | Kit |
|---|---|---|
| Any Linux server | one command: `install.sh` | [deploy/vps](../deploy/vps/) |
| Coolify | paste a Compose file (tested: Folio's own production runs on Coolify) | [deploy/coolify](../deploy/coolify/) |
| Railway | [one-click template](https://railway.com/deploy/folio) | [deploy/railway](../deploy/railway/) |
| Render | Blueprint, paid plan (disk) | [deploy/render](../deploy/render/) |
| DigitalOcean | Droplet with cloud-init | [deploy/digitalocean](../deploy/digitalocean/) |
| Dokploy | compose + template files | [deploy/dokploy](../deploy/dokploy/) |
| CapRover | One-Click App | [deploy/caprover](../deploy/caprover/) |
| Easypanel | template files | [deploy/easypanel](../deploy/easypanel/) |
| Portainer | stack | [deploy/portainer](../deploy/portainer/) |
| Fly.io | manual recipe | [deploy/fly](../deploy/fly/) |

Everywhere the sizing is the same: **2 GB of RAM, 1 vCPU and 10 GB of disk** at
least. [`deploy/README.md`](../deploy/README.md) has the overview, and
[`deploy/smoke.mjs`](../deploy/smoke.mjs) checks a fresh installation (sign-up,
a space, a page, real-time editing).

## Other platforms

Folio can run anywhere that runs a container from the `Dockerfile` and
provides all of the following:

- **a long-running process** — not functions that start per request;
- **a persistent disk** mounted at `/app/data`;
- **PostgreSQL** (`DATABASE_URL`) and **Redis** (`REDIS_URL`);
- **WebSocket** connections to the application;
- environment variables `PUBLIC_URL`, `FOLIO_SECRET`, `NODE_ENV=production`,
  `PORT=4870`.

Serverless hosting — Vercel, Netlify, Cloudflare Pages and similar — cannot
run Folio: it has no persistent disk for the Git repositories and does not
keep a process alive for WebSocket connections. DigitalOcean's App Platform
cannot either, because it has no persistent volumes; use a Droplet.

## When something goes wrong

**The page does not open.** Check that the containers are running and look at
the log:

```bash
docker compose ps
docker compose logs app --tail 100
```

**Port 4870 is already in use.** Put `FOLIO_PORT=4880` into `.env`, set
`PUBLIC_URL` to match, and run `docker compose up -d`.

**Signing in does nothing on a server.** The address in the browser and
`PUBLIC_URL` must match, including `http` or `https`.

**A public site's address opens the main Folio, a 404 or a certificate error.**
Check that the host reaches Folio with its original `Host` header, that a
subdomain is exactly one label under `PUBLIC_SITES_DOMAIN`, that a custom
domain's DNS and certificate exist, and that a host is not the host of
`PUBLIC_URL`. A change to a site's settings takes up to ten seconds to apply.

**A table on a public site does not update live.** The reverse proxy does not
pass WebSocket connections on `/collab` for that host.

**Start from scratch.** This deletes every page and account:

```bash
docker compose down --volumes
```
