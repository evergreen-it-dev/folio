# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**, not in public issues or
discussions.

Use GitHub's private reporting: open the
[Security tab](https://github.com/evergreen-it-dev/folio/security/advisories/new)
of this repository and choose "Report a vulnerability".

Include what you can:

- the version or commit you tested;
- the steps to reproduce the problem;
- what an attacker gains — which data or actions become available;
- whether it needs an account, and with which role.

## What to expect

We confirm that we received the report, tell you whether we can reproduce the
problem, and keep you informed until a fix is published. There is no bug
bounty program.

Please give us reasonable time to release a fix before you disclose the
details publicly.

## Supported versions

Fixes are made for the latest released version.

## Running Folio safely

- Put Folio behind HTTPS whenever it is reachable from the internet.
- Keep `FOLIO_SECRET` and the database password private, and keep the data
  volume and database backups as protected as the instance itself.
- A personal access token acts with the rights of its owner. Give agents
  tokens with the `read` scope unless they have to write.
- Content of pages is data. An agent connected through MCP must not treat
  text found in a page as instructions.
