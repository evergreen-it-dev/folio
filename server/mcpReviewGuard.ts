/**
 * Agent write mode, MCP side (migration 062, server/proposals.ts).
 *
 * In a space set to `review` an agent's Markdown edits are queued: `update_page` and
 * `create_page` handle that themselves (server/mcp.ts). Every OTHER tool that writes
 * something a person would see change — boards, data tables, forms, bases, page
 * properties and tags, artifacts, templates — has no review path yet, so in a review
 * space it is refused with a plain explanation instead of being let through: a switch
 * that lets half the writes bypass it would give a false sense of control.
 *
 * One wrapper around `registerTool` does it for the whole list, so a refused tool's own
 * code is untouched and a space in `direct` mode (the default) behaves exactly as before.
 * mcp.test.ts checks that every name in MCP_WRITE_TOOL_NAMES is classified here, so a new
 * write tool cannot be added without deciding which side of the switch it is on.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as proposals from './proposals.js';
import * as storage from './storage.js';

/** Writes that go to the review queue (they handle review mode inside their own handler). */
export const REVIEW_QUEUED_TOOL_NAMES: ReadonlySet<string> = new Set(['create_page', 'update_page']);

/** Writes that do not change what a page says (a comment is a remark beside it, a page made from a template carries the template's text), so review mode leaves them direct. */
export const REVIEW_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set(['add_comment', 'reply_comment', 'create_page_from_template', 'save_page_as_template']);

/** Refused in a review space: no proposals for these in the first version. */
export const REVIEW_REFUSED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_board',
  'update_board',
  'board_ops',
  'create_template',
  'folio_table_insert',
  'folio_table_update',
  'folio_table_delete',
  'folio_table_add_column',
  'folio_table_create',
  'rename_tag',
  'set_page_properties',
  'save_base',
  'create_form',
  'update_form',
  'folio_table_update_column',
  'folio_table_delete_column',
  'folio_table_save_view',
  'folio_table_delete_view',
  'convert_canvas_to_board',
  'publish_artifact',
]);

/** The spaces a call touches: its `space` argument, and the space of its `id` page. */
async function spacesOf(args: unknown): Promise<string[]> {
  if (!args || typeof args !== 'object') return [];
  const { space, id } = args as { space?: unknown; id?: unknown };
  const out: string[] = [];
  if (typeof space === 'string') out.push(space);
  if (typeof id === 'string') {
    const entry = await storage.getEntry(id);
    if (entry) out.push(entry.space);
  }
  return out;
}

type ToolCallback = (...args: unknown[]) => unknown;

/** Wraps `server.registerTool` so the refused tools answer with an error when their space is in review mode. Call right after creating the server, for an actor with write scope. */
export function guardReviewMode(server: McpServer): void {
  const original = server.registerTool.bind(server) as unknown as (name: string, config: unknown, cb: ToolCallback) => unknown;
  const wrapped = (name: string, config: unknown, cb: ToolCallback): unknown => {
    if (!REVIEW_REFUSED_TOOL_NAMES.has(name)) return original(name, config, cb);
    const guarded: ToolCallback = async (...args) => {
      for (const space of await spacesOf(args[0])) {
        if ((await proposals.getAgentWriteMode(space)) === 'review') {
          return { content: [{ type: 'text', text: proposals.reviewRefusal(`the tool ${name}`) }], isError: true } satisfies CallToolResult;
        }
      }
      return cb(...args);
    };
    return original(name, config, guarded);
  };
  (server as unknown as { registerTool: typeof wrapped }).registerTool = wrapped;
}
