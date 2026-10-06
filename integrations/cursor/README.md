# Folio for Cursor

Your team's conventions, decisions and Definition of done live in Folio. Cursor's agent reads them while it works, and a rule in this folder makes it go to Folio on its own. The page is the source: a manager edits it in the browser, and the next task follows the new wording. Nothing changes in the code repository.

Step-by-step page on the site: <https://foliowiki.online/integrations/cursor>

Auth: personal access token.

## Files

| File | Where it goes |
|---|---|
| `.cursor/mcp.json` | `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project |
| `.cursor/rules/folio-wiki.mdc` | `.cursor/rules/folio-wiki.mdc` in your project (the file must end in `.mdc`) |

## Install

1. In Folio open the user menu, then **API tokens**, and create a token. Use `read` when the agent only needs the conventions.
2. Put the address and the token in environment variables **before** you start Cursor, and start Cursor from that shell, for example `cursor .` in the project folder. A Cursor launched from the dock or the Start menu may not see variables from your shell.

   ```bash
   export FOLIO_URL=https://your-folio.example.com
   export FOLIO_TOKEN=folio_pat_...
   ```

3. Copy `.cursor/mcp.json` and `.cursor/rules/folio-wiki.mdc` into your project. Cursor fills in `${env:NAME}` at run time.
4. Open Cursor Settings, then MCP. The `folio` server should show as connected, with its tools listed. By default Cursor asks before each MCP tool call.
5. Ask: *Add an endpoint for exporting invoices. Follow our API conventions from Folio and link the page you used.* The agent calls `search_pages`, reads the page and writes the code to match.

If Cursor cannot see your variables, write the address and the token straight into the global `~/.cursor/mcp.json`. Never put a real token in a file that goes to Git.

## One-click link (Add to Cursor)

Cursor installs an MCP server from a deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the JSON>`. The config is the server entry without the `mcpServers` wrapper. This one carries the token as an environment reference, so no secret is in the link. For your own address:

```bash
node -e '
const url = process.argv[1].replace(/\/$/, "") + "/mcp";
const config = { url, headers: { Authorization: "Bearer ${env:FOLIO_TOKEN}" } };
console.log("cursor://anysphere.cursor-deeplink/mcp/install?name=folio&config=" +
  encodeURIComponent(Buffer.from(JSON.stringify(config)).toString("base64")));
' https://your-folio.example.com
```

Open the printed link (or put it behind a button in your team docs). Cursor shows the server for you to confirm, and you still need `FOLIO_TOKEN` in the environment. Whether the link keeps `${env:...}` untouched until run time is not documented by Cursor. If it misbehaves, copy `.cursor/mcp.json` by hand.

## Try it on the public demo

The demo does not issue personal tokens. Cursor's docs describe OAuth for remote MCP servers, so you can add `https://demo.foliowiki.online/mcp` without a header and sign in as Sam. This route has not been run against Folio yet. The demo login is shared and its data resets every 24 hours: do not connect an agent that has a shell or your own keys, and do not enter personal data.

## Safety

The token carries the rights of the person who created it, narrowed by its scope. Give the agent its own Folio user with the editor role only in the spaces it needs. Page content is data, not instructions: the rule says so, but the real protection is the narrow token.

This is Cursor as an MCP client of Folio. It is not Folio AI, the built-in assistant. Connecting Cursor to Folio needs no key on the Folio side.
