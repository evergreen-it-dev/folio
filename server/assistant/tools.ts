/**
 * AI assistant (Cursor SDK) — turns Folio's own MCP server (server/mcp.ts)
 * into in-process Cursor SDK custom tools, so the assistant calls the exact
 * same RBAC-checked tool implementations a PAT-authenticated MCP client
 * would, instead of a parallel hand-rolled tool surface (a sibling project's
 * tools.ts talks to its own REST API over `fetch`; Folio's MCP server already
 * IS the right abstraction, so this file wires directly to it instead).
 *
 * Wiring: buildFolioMcpServer(actor) <-> a Client, connected via the MCP
 * SDK's own InMemoryTransport (same mechanism server/mcp.test.ts uses to
 * exercise the server) — no HTTP round trip, no separate process. The
 * client's listTools() result (name/description/inputSchema, already a JSON
 * Schema) is turned into one SDKCustomTool per tool; execute() calls
 * client.callTool and unwraps the first text content block into the string
 * result the Cursor SDK expects (or an `{content,isError}` shape on error).
 *
 * ask mode gets read-only tools only: write tools are filtered out by name
 * BEFORE the model ever sees them (never relying solely on the MCP server's
 * own scope check, which is the second line of defense) — the actor's own
 * scopes are set to ['read'] for ask, ['read','write'] for agent, so even a
 * name that slipped through the filter would still be rejected server-side.
 */
import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AssistantRunMode } from '../../shared/contracts.js';
import type { User } from '../../shared/contracts.js';
import { buildFolioMcpServer } from '../mcp.js';

const MAX_TOOL_RESPONSE_CHARS = 120_000;

/** Names hidden from the model entirely in `ask` mode — the same set the MCP server itself would refuse for a read-scoped token, kept here too so the model never even sees them as an option. */
const WRITE_ONLY_TOOL_NAMES = new Set([
  'create_page',
  'update_page',
  'create_board',
  'update_board',
  'folio_table_insert',
  'folio_table_update',
  'folio_table_delete',
  'folio_table_add_column',
  'folio_table_create',
]);

export interface AssistantToolsHandle {
  tools: Record<string, SDKCustomTool>;
  close: () => Promise<void>;
}

function truncate(text: string): { truncated: boolean; body: string } {
  if (text.length <= MAX_TOOL_RESPONSE_CHARS) return { truncated: false, body: text };
  return { truncated: true, body: `${text.slice(0, MAX_TOOL_RESPONSE_CHARS)}\n…[truncated]` };
}

/** Builds the assistant's in-process tool set for one run, and a close() to tear the client/server pair down again once the run is over. */
export async function buildAssistantTools(user: User, runMode: AssistantRunMode): Promise<AssistantToolsHandle> {
  const server = buildFolioMcpServer({
    user,
    scopes: runMode === 'agent' ? ['read', 'write'] : ['read'],
    tokenId: 'assistant',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'folio-assistant', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools: mcpTools } = await client.listTools();
  const tools: Record<string, SDKCustomTool> = {};
  for (const tool of mcpTools) {
    if (runMode === 'ask' && WRITE_ONLY_TOOL_NAMES.has(tool.name)) continue;
    tools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Record<string, SDKJsonValue>,
      async execute(args) {
        try {
          const result = await client.callTool({ name: tool.name, arguments: args });
          const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
          const text = content.find((c) => c.type === 'text')?.text ?? '';
          const { truncated, body } = truncate(text);
          const finalText = truncated ? body : text;
          if (result.isError) return { content: [{ type: 'text' as const, text: finalText }], isError: true };
          return finalText;
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'tool call failed' }],
            isError: true,
          };
        }
      },
    };
  }

  return {
    tools,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

