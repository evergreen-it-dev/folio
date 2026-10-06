# Folio for VS Code (GitHub Copilot)

Let Copilot chat in VS Code read your team wiki and write to it. VS Code asks for the token the first time and keeps it out of the file.

Step-by-step page on the site: <https://foliowiki.online/integrations/vscode>

Auth: personal access token.

## Install

1. In Folio open the user menu, then **API tokens**, and create a token.
2. Copy `.vscode/mcp.json` from this folder into your workspace and replace `https://your-folio.example.com/mcp` with your address (it ends in `/mcp`). The `inputs` entry asks for the token once and masks it.
3. Start the server from the **Start** code lens above its entry in the file, or run **MCP: List Servers** from the Command Palette. Enter the token when VS Code asks.
4. Open Copilot chat, switch to agent mode and check that the Folio tools are in the tools list. Ask: *Search Folio for our incident response runbook and summarize the first three steps. Link the page.*

On Copilot Business and Enterprise, an organization policy for MCP servers may be off by default. If the tools do not appear, ask your administrator.

## Notes

- The demo does not issue personal tokens, so this route cannot be tried against it. Use your own Folio.
- OAuth for VS Code against Folio is not documented here. Use a token.
- No one-click install link is offered: the VS Code documentation we checked does not specify the link format.
- The token carries the rights of its owner. Give the agent its own Folio user and the narrowest scope that does the job.

Reference: [VS Code MCP configuration](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).
