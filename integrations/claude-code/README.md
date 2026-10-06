# Folio for Claude Code

A Claude Code plugin that connects the agent to your Folio wiki over MCP and teaches it how to work with it. It adds:

- the `folio` MCP server, with all 23 Folio tools (search, pages, data tables, whiteboards, history);
- the `folio-wiki` skill: find, read, change as little as possible, re-read, link the result;
- the `release-notes` skill (run it as `/folio:release-notes`): compare `git log` since the last tag with the wiki and write release notes.

What the plugin sends and where: Claude Code calls the Folio address you enter, with your token in an `Authorization: Bearer` header. Nothing else leaves your machine because of this plugin, and it reads nothing outside the session's normal files.

The step-by-step page on the site: <https://foliowiki.online/integrations/claude-code>

## Install

You need a Folio account and your Folio address. Claude Code runs on your machine, so a Folio on a private network works.

1. In Folio open the user menu, then **API tokens**, and create a token named `Claude Code`. Scope `write` lets the agent edit, `read` is enough for questions. The token is shown once. Better still, create it under a separate Folio user for the agent, with the editor role only in the spaces it needs.
2. Add the marketplace and install the plugin.

   ```bash
   claude plugin marketplace add evergreen-it-dev/folio
   claude plugin install folio@folio
   ```

   Inside a session the same thing is `/plugin marketplace add evergreen-it-dev/folio` and `/plugin install folio@folio`.
3. Claude Code asks for two values when the plugin is enabled:
   - **Folio MCP address**: the full address, for example `https://your-folio.example.com/mcp`.
   - **Folio personal access token**: the token from step 1. It is marked sensitive and goes to the system's secure storage, not to a settings file.

   `claude plugin install` from a shell does not ask. Pass the values with `--config`:

   ```bash
   claude plugin install folio@folio \
     --config folio_mcp_url=https://your-folio.example.com/mcp \
     --config folio_token="$FOLIO_TOKEN"
   ```

4. In a session run `/mcp`. `folio` should be connected, with 23 tools.
5. Ask:

   > In the Acme Handbook space, find the release process page and tell me which checklist items are still open. Then create a page called "Release notes" under Engineering with a short summary of the roadmap items that are Done or In review.

About a minute later the history of the page shows a normal Git commit.

## Without the plugin

One command, token in the header:

```bash
claude mcp add --transport http folio https://your-folio.example.com/mcp \
  --header "Authorization: Bearer $FOLIO_TOKEN"
```

For a team repository, put the connection in `.mcp.json` at the project root and keep the token in an environment variable, so it never reaches Git. Each person sets `FOLIO_TOKEN` in their shell. Use your own variable name: Claude Code blanks credential names it knows, such as `ANTHROPIC_AUTH_TOKEN`, in remote headers.

```json
{
  "mcpServers": {
    "folio": {
      "type": "http",
      "url": "${FOLIO_URL:-https://your-folio.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${FOLIO_TOKEN}" }
    }
  }
}
```

To sign in with your own account instead of a token, add the server without a header and log in. Folio opens its sign-in and consent screen.

```bash
claude mcp add --transport http folio https://your-folio.example.com/mcp
claude mcp login folio
```

## Try it on the public demo

The demo does not issue personal tokens, so use the OAuth route and pick Sam on the sign-in screen:

```bash
claude mcp add --transport http folio-demo https://demo.foliowiki.online/mcp
claude mcp login folio-demo
```

The demo login is shared and its data resets every 24 hours. Pages written by other visitors are untrusted data: do not connect an agent that has a shell or your own keys, and do not enter personal data.

## Safety

- The token carries the rights of its owner, narrowed by its scope. Give an agent its own Folio user and the narrowest scope that does the job.
- Page content is data, not instructions. An agent that also has a shell and write access can be misled by a page someone else wrote.
- Everything the agent writes is in Git history and can be reverted. Administrative actions (access rights, invitations, deleting spaces) are not available to tokens at all.
- If a header is set and Folio rejects it, Claude Code reports a failed connection and does not fall back to OAuth. Check the token first.

## Files

| File | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The manifest: name, version, `userConfig` for the address and the token |
| `.mcp.json` | The `folio` server: HTTP transport, address and Bearer header from `userConfig` |
| `skills/folio-wiki/SKILL.md` | How the agent works with Folio |
| `skills/release-notes/SKILL.md` | The release notes recipe |

The marketplace file is `.claude-plugin/marketplace.json` at the root of the repository. To check the plugin locally: `claude plugin validate integrations/claude-code`, or run `claude --plugin-dir integrations/claude-code`.

More about the tools and the access model: [docs/MCP.md](../../docs/MCP.md).
