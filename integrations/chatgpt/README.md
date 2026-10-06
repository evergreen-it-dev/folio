# Folio for ChatGPT

Use ChatGPT as the window into your team wiki. Folio is a remote MCP server with OAuth, which is what ChatGPT's custom MCP servers need. You sign in to your own Folio account, and ChatGPT acts with your rights.

There are no files to install. This page is the whole package.

Step-by-step page on the site: <https://foliowiki.online/integrations/chatgpt>

Auth: OAuth.

## Requirements

- A Folio instance reachable over HTTPS from the public internet. For private networks OpenAI offers a Secure MCP Tunnel, which has not been tried with Folio.
- `PUBLIC_URL` set to that address on the Folio side.
- A ChatGPT workspace that allows custom MCP servers. Workspace permissions apply, and which personal plans include the feature is not confirmed, so check the Plugins page in your own account.
- A Folio account, from an administrator's invitation.

## Steps

1. Check that your Folio answers like an OAuth-protected server: a `401` with a `WWW-Authenticate` header.

   ```bash
   curl -si -X POST https://your-folio.example.com/mcp \
     -H 'content-type: application/json' -d '{}' | head -8
   ```

2. In ChatGPT open **Plugins**, click the plus and choose the custom MCP server option. The label reads *Create custom MCP server* or *Add custom MCP server*, depending on the version. Enter a name, an optional description and the server URL:

   ```text
   https://your-folio.example.com/mcp
   ```

3. Set authentication to **OAuth**. Folio supports client ID metadata documents, the method ChatGPT uses, so you do not need a client ID or a secret.
4. Accept the risk warning, then create the server as a plugin and install it. ChatGPT sends you to Folio's sign-in and consent screen. Choose read to start, or read and write if you want it to edit.
5. In a chat, mention the plugin with `@` and ask: *Find our onboarding checklist and tell me what is left for week one. Give me the link.* For a write, ChatGPT asks you to confirm before it runs.

## Try it on the public demo

Add `https://demo.foliowiki.online/mcp` the same way, sign in as Sam, and ask about the Release process page. The demo login is shared and its data resets every 24 hours. Do not enter personal data.

## Limits

- ChatGPT can send what it reads from Folio to OpenAI. Connect only the spaces you are happy to share with it, and use a read-only consent when you only need answers.
- Deep research and company knowledge in ChatGPT accept only two read-only tools named exactly `search` and `fetch`. Folio provides them (alongside `search_pages` and `read_page`, with the same access rules), so these features can use Folio. They have not been run live with Folio yet.
- ChatGPT cannot send a static token or a custom header, so there is no token route here. It is OAuth or nothing. Codex, OpenAI's coding agent, does take a token: see [../codex](../codex/README.md).
- To disconnect, open the Folio user menu, then API tokens, then Connected apps, and remove the app.

How the OAuth side works: [docs/MCP.md](../../docs/MCP.md#oauth-connect-from-claudeai--chatgpt).
