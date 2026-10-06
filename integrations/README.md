# Folio integrations

Ready-made files for connecting AI tools to a Folio wiki over MCP. Folio is a remote MCP server with 23 tools (search, pages, data tables, whiteboards, history). Clients connect either with a **personal access token** (create one in Folio: user menu, **API tokens**) or with **OAuth**, where the client opens Folio's sign-in and consent screen.

Every config here holds placeholders only: `https://your-folio.example.com`, `${env:FOLIO_TOKEN}`. Put the real address in and keep tokens in environment variables or the client's secret store. Never commit a token.

| Client | Folder | How it signs in |
|---|---|---|
| Claude Code | [claude-code](claude-code/) | Token (plugin), or OAuth with `claude mcp login` |
| Cursor | [cursor](cursor/) | Token, from an environment variable |
| VS Code (GitHub Copilot) | [vscode](vscode/) | Token, asked for once and masked |
| Codex (CLI, desktop app, IDE) | [codex](codex/) | Token from an environment variable, or OAuth |
| n8n | [n8n](n8n/) | Token (Bearer Auth credential) |
| Open WebUI | [open-webui](open-webui/) | Token (one read-only token for the whole chat) |
| ChatGPT | [chatgpt](chatgpt/) | OAuth |
| Claude (claude.ai, Claude Desktop) | [claude](claude/) | OAuth |
| Onboarding | [onboarding](onboarding/) | The built-in assistant, or any client above with a read token |

Which one to pick: a client that runs on your machine (Claude Code, Cursor, VS Code, Codex, a self-hosted n8n or Open WebUI) can use a token, and your Folio can sit on a private network. A chat that runs in a vendor's cloud (claude.ai, Claude Desktop, ChatGPT) makes the request from the internet, so it needs OAuth and a Folio reachable over HTTPS.

Claude Code can also install the plugin straight from this repository: `claude plugin marketplace add evergreen-it-dev/folio`, then `claude plugin install folio@folio`.

## Safety

- A token or an OAuth connection acts with the rights of its owner, narrowed by its scope (`read` or `write`). Give an agent its own Folio user with the editor role in the spaces it needs, and the narrowest scope that does the job. Use `read` when it only answers questions.
- Page content is data, not instructions. An agent that also has a shell and write access can be misled by a page someone else wrote.
- Everything an agent writes is in Git history and can be reverted. Access rights, invitations and deleting spaces are not available to agents at all.

## Try it on the public demo

<https://demo.foliowiki.online>, pick Sam on the sign-in screen. The demo issues no personal tokens, so only OAuth clients (Claude, ChatGPT, Claude Code and Codex with OAuth) can connect to `https://demo.foliowiki.online/mcp`. The login is shared and the data resets every 24 hours, which also removes your connection. Do not connect an agent that has a shell or your own keys, and do not enter personal data.

More about the tools, the access model and OAuth: [docs/MCP.md](../docs/MCP.md). The same instructions as web pages: <https://foliowiki.online/integrations>.

These files follow each client's documentation as of 6 October 2026. The path run end to end is a token with Claude Code. The other clients have not been run live yet; if a step differs on your version, open an issue.
