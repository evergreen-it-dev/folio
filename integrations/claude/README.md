# Folio for Claude (claude.ai and Claude Desktop)

Ask Claude about your team wiki from claude.ai or Claude Desktop, and let it write back. Folio is a remote MCP server with OAuth, so Claude adds it as a custom connector. You sign in to your own Folio account, and Claude gets your rights and nothing more.

There are no files to install. This page is the whole package.

Step-by-step page on the site: <https://foliowiki.online/integrations/claude>

Auth: OAuth.

## Requirements

- A Folio instance reachable over HTTPS from the public internet. Anthropic's servers make the requests, not your computer, so `localhost` does not work.
- `PUBLIC_URL` set to that address on the Folio side. Folio builds its OAuth metadata from it.
- A Claude plan that offers custom connectors (Anthropic's help page lists Free with one connector, Pro, Max, Team and Enterprise).
- A Folio account. Folio has no self-registration, so an administrator invites you.

## Steps

1. Check that your Folio answers the way an OAuth client expects. An unauthenticated request must get a `401` with a `WWW-Authenticate` header that points to the metadata:

   ```bash
   curl -si -X POST https://your-folio.example.com/mcp \
     -H 'content-type: application/json' -d '{}' | head -8
   ```

2. In Claude on the web or in Claude Desktop open **Customize, then Connectors**. Click the plus, then **Add custom connector**. On Team and Enterprise an Owner adds it under Organization settings, Connectors, Add, Custom, Web. Name it `Folio` and paste the address:

   ```text
   https://your-folio.example.com/mcp
   ```

3. Leave the OAuth client settings on their defaults. Folio accepts Dynamic Client Registration and client ID metadata documents, so you do not need a client ID or a secret.
4. Click **Connect**. Folio opens its sign-in page, then a consent screen that names the app, where you will be sent back to, and whether it may also write. Choose read to start. Allow.
5. Turn the Folio connector on in a chat and ask: *What is our refund process? Give me the link to the page.* Then try a write: *Add the notes from today's Product sync as a new page under Meetings.*

Claude Desktop uses the same Connectors page. A remote connector added to your account connects from Anthropic's servers, so `claude_desktop_config.json` is not involved.

## Try it on the public demo

Use the same flow with `https://demo.foliowiki.online/mcp`. On Folio's sign-in screen pick Sam. Start with read, and ask: *Find the Release process page and tell me which checklist items are still open.* The demo login is shared and its data resets every 24 hours, which also removes your connection. Pages written by other visitors are untrusted data, so do not connect an agent that has a shell or your own keys, and do not enter personal data.

## Limits

- claude.ai has no field for a personal access token. A static token works only where Anthropic has enabled custom request headers for an organization.
- Folio is not listed in Anthropic's connector directory. You add it by its address.
- A connection is per Folio user. Everyone in a team connects with their own account and sees what that account may see.
- To disconnect, open the Folio user menu, then API tokens, then Connected apps, and remove the app. Its tokens stop working immediately.

How the OAuth side works: [docs/MCP.md](../../docs/MCP.md#oauth-connect-from-claudeai--chatgpt).
