# Folio for n8n

n8n calls Folio. A workflow turns an event into a row in a table or a draft page, and the people on the team open the page and edit it like any other. This folder has two workflows you can import.

Step-by-step page on the site: <https://foliowiki.online/integrations/n8n>

Auth: personal access token (an n8n Bearer Auth credential).

## Workflows

| File | What it does |
|---|---|
| `github-issue-to-table-row.json` | A GitHub `issues` webhook arrives, a new issue becomes a row in a Folio table (`folio_table_insert`) |
| `weekly-summary-page.json` | Every Monday at 9:00 it reads the rows opened in the last 7 days (`folio_table_query`) and creates a "Weekly summary" page (`create_page`) |

Both use the **MCP Client** node (Streamable HTTP, Bearer authentication). The direction is n8n to Folio. Folio has no webhooks or outgoing events yet, so an edit in Folio cannot start a workflow. To react to changes, poll on a schedule, as the second workflow does.

The files import into n8n 2.41. The MCP Client node needs a version of n8n that has it, and Streamable HTTP in the MCP nodes came in 1.104. Field labels can differ slightly between versions. The workflows were imported, not executed against a live Folio.

## The table

Both workflows use one table. Create it in Folio (a data table named, for example, "GitHub issues") with these columns, and give them exactly these names, because Folio derives the column ids from the names:

| Column name | Type | Column id |
|---|---|---|
| Issue | text | `issue` |
| Link | link | `link` |
| Author | text | `author` |
| Opened | date | `opened` |

Find the table's page id with the `folio_table_list` tool (or from the page's address) and paste it into the first workflow's "Map issue to a row" node and the second one's "Settings" node. If your table has other columns, call `folio_table_schema` first: column ids and the options of `select` and `status` columns cannot be guessed from names.

## Install

1. In Folio create a token (user menu, **API tokens**). For the weekly summary, `write` is needed to create the page. For a workflow that only reads, `read` is enough. Create the token under a separate Folio user with the editor role in one space, not an administrator's.
2. In n8n create a credential of type **Bearer Auth** and paste the token. A Header Auth credential with the name `Authorization` and the value `Bearer folio_pat_...` works too.
3. Import a workflow: **Workflows, Import from file**.
4. In each **MCP Client** node set the endpoint to your Folio address (it ends in `/mcp`) and choose your credential.
5. Fill in the placeholders: `PASTE_THE_FOLIO_TABLE_PAGE_ID`, and for the summary also `space` and `parentPath`.
6. Run the workflow once by hand, then activate it.

n8n must be able to reach Folio. n8n Cloud reaches only a public address. A self-hosted n8n can reach Folio on the same network.

## An AI agent that reads the wiki

To let an n8n AI Agent answer from your wiki, add the **MCP Client Tool** node to the Tool input of an AI Agent node. Set the endpoint to your Folio address, the transport to HTTP Streamable and authentication to Bearer. Under **Tools to Include** choose **Selected** and pick only what the agent needs: `search_pages` and `read_page` for answers, plus `folio_table_insert` if it should log a row. With **All**, the agent sees every tool, including the ones that write.

## Safety

- The token carries the rights of its owner. Keep it in the n8n credential, never in the workflow file. The files here hold only placeholders.
- The webhook in the first workflow is open to whoever knows its address. Use a hard-to-guess path, or check GitHub's signature, before you point it at a table that matters.
- Page and table content is data, not instructions.
