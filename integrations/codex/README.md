# Folio for Codex

Codex reads its MCP servers from one `config.toml`, shared by the CLI, the ChatGPT desktop app and the IDE extension. Add Folio once and each of them can search and update your wiki.

Step-by-step page on the site: <https://foliowiki.online/integrations/codex>

Auth: personal access token or OAuth.

## Install with a token

1. In Folio open the user menu, then **API tokens**, and create a token (`write` to edit, `read` for questions).
2. Put it in the environment:

   ```bash
   export FOLIO_TOKEN=folio_pat_...
   ```

3. Add the entry from `config.toml` in this folder to `~/.codex/config.toml`. For one project only, use `.codex/config.toml` in a trusted project. Codex sends the variable's value as a Bearer header.

   ```toml
   [mcp_servers.folio]
   url = "https://your-folio.example.com/mcp"
   bearer_token_env_var = "FOLIO_TOKEN"
   ```

4. Start Codex from the same shell, so it sees the variable, and ask: *Read the Release process page in Folio, then create a page called Release notes under Engineering with the items that are done.*

## Install with OAuth

To sign in with your own account instead of a token, add the server by address and log in. This follows Codex's documentation and has not been run against Folio.

```bash
codex mcp add folio --url https://your-folio.example.com/mcp
codex mcp login folio
```

## Try it on the public demo

The demo does not issue personal tokens. Use the OAuth route and sign in as Sam:

```bash
codex mcp add folio-demo --url https://demo.foliowiki.online/mcp
codex mcp login folio-demo
```

The demo login is shared and its data resets every 24 hours. Do not connect an agent that has a shell or your own keys, and do not enter personal data.

## Notes

The same ChatGPT account does not give you Folio in the ChatGPT chat. That is a separate route with OAuth: see [../chatgpt](../chatgpt/README.md).
