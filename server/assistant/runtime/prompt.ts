/**
 * The assistant prompt, shared by every runtime. Cursor gets one string (the
 * same bytes as before this file existed); the providers driven by agentLoop.ts
 * get the stable part and the volatile part separately, so the part that does
 * not change between requests can sit in front of a prompt-cache breakpoint.
 */
import type { AssistantRunMode } from '../../../shared/contracts.js';
import type { PreparedAssistantWorkspace } from '../workspace.js';

export interface AssistantPromptParts {
  /** Instructions and reference material: the same for every run of a user in a space and mode. */
  stable: string;
  /** Where the user is right now (current page and so on): changes between runs. */
  volatile: string;
  /** The single prompt the Cursor SDK is sent. */
  cursorPrompt: string;
}

type PromptWorkspace = Pick<PreparedAssistantWorkspace, 'systemPrompt' | 'publicSiteNotice' | 'agentRules' | 'folioContext' | 'runtimeContext'>;

export function buildAssistantPromptParts(workspace: PromptWorkspace, runMode: AssistantRunMode, message: string): AssistantPromptParts {
  const head = [
    workspace.systemPrompt,
    '',
    // Public sites: who the "user" is, before anything else can be read as permission to do more.
    ...(workspace.publicSiteNotice ? ['## Public website visitor', '', workspace.publicSiteNotice, ''] : []),
    // Owner spec (21.09.2026): `.agent/**` rules pages, admin-authored
    // per space — prepended right after the base system prompt (before
    // Folio's own reference material) so they read as instructions the
    // model must follow, not background it may skim. Present for Ask
    // AND Agent alike — workspace.agentRules never depends on runMode.
    // Omitted entirely when the space has no `.agent` folder, so a
    // space without rules sees no empty section at all.
    ...(workspace.agentRules ? ['## The .agent rules of this space', '', workspace.agentRules, ''] : []),
    '## Folio context',
    '',
    workspace.folioContext,
    '',
  ];
  const currentContext = [
    '## Current context',
    '',
    workspace.runtimeContext,
    '',
  ];
  const tail = [
    '## Skills',
    '',
    'You have no file or shell access. Working instructions are skills: call the `read_skill` tool with the name the task needs, once per conversation:',
    '- `folio-mcp` — the list of tools and the rules for writing (read before the first change to data);',
    '- `folio-content` — the syntax of Folio pages (before creating or editing markdown);',
    '- `folio-boards` — the `sketch` DSL for whiteboards (before create_board/update_board);',
    '- `folio-tables` — data tables: rows, columns, views (before folio_table_*);',
    '- `folio-forms` — forms and the table their answers go to (before create_form/update_form);',
    '- `folio-bases` — bases, saved queries over pages: YAML syntax and an example (before save_base);',
    '- `folio-artifacts` — interactive pages: dashboards, calculators, filterable reports (before publish_artifact).',
    'Simple read-only questions need no skills — call the tool straight away.',
    '',
    `Mode of this run: ${runMode === 'ask' ? 'ASK — read only, no changes in Folio' : 'AGENT — changes are allowed only when the user asks for them directly'}.`,
    '',
  ];
  return {
    stable: [...head, ...tail].join('\n').trim(),
    volatile: currentContext.join('\n').trim(),
    cursorPrompt: [...head, ...currentContext, ...tail, '---', '', `User: ${message}`].join('\n'),
  };
}
