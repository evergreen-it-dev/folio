# Contributing to Folio

Thank you for your interest. Bug reports, fixes and documentation
improvements are all welcome.

## Build it with agents

Folio is vibe-coded: almost every line here was written by AI coding agents
under human direction. That is also how we expect you to contribute. Do not
hand-craft a feature for a week — point your agent (Claude Code, Cursor,
Codex or any other) at this repository, describe the scenario, let it read
[AGENTS.md](AGENTS.md) and [docs/HANDOFF.md](docs/HANDOFF.md), review what
it produces, check it in the browser and send the pull request. You stay
responsible for the result: you read the diff, you run the checks below, and
you can explain what changed.

Never worked this way? Watch our webinars on agentic development at
<https://evergreen.team/events/webinars>, then pick an issue and go for it.

## Before you start

- **A bug** — open an issue with the steps to reproduce it.
- **A small fix** — a pull request is enough.
- **A new feature or a change in behavior** — please open an issue first and
  describe the scenario. It saves you from writing code that cannot be
  accepted.
- **A vulnerability** — do not open an issue; see [SECURITY.md](SECURITY.md).

## How changes reach this repository

Folio is developed in an upstream repository, and this one is updated from it.
An accepted pull request is applied upstream with your authorship preserved
and then arrives here with the next update — so your pull request may be
closed rather than merged, with a link to the commit that carries the change.

## Development setup

You need Node.js 22.12 or newer (22.13 or newer for the AI assistant), Docker
and Git.

```bash
cp .env.dev.example .env
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL, Redis, MinIO
npm install
npm run dev
```

The interface is at <http://localhost:4871>, the API at
<http://localhost:4870>.

## Checks

```bash
npm run typecheck
npm run build
npx vitest run path/to/changed.test.ts
```

Most server tests need the development PostgreSQL and Redis to be running.
The full suite (`npm test`) takes about ten minutes; run at least the tests
next to the code you changed.

## Layout

- `server/` — Fastify REST API, authentication and access, Git
  synchronization, import and export, MCP, collaborative editing.
- `web/` — React interface: editor, tables, whiteboards, administration.
- `shared/` — contracts and the table codec shared by both sides.
- `db/migrations/` — forward-only migrations, applied at startup.

## Rules that are easy to break

- Content in `.md`, `.table.md` and `.excalidraw.svg` files is the source of
  truth. The database holds operational state and a derived index.
- The instance administrator does not get access to private spaces
  automatically.
- MCP works with personal access tokens only. Administrative and access
  operations stay cookie-only.
- Migrations are forward-only: a fix is a new numbered file.

## Pull requests

- One topic per pull request.
- Add or update a test for changed behavior.
- Describe what changed for the user, not only what changed in the code.
- Use neutral examples in code and tests (`example.com`, invented names) — no
  real addresses, people or company data.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
