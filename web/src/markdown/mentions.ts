/**
 * `@mentions` — reading-mode pill (round 15).
 *
 * Storage is plain text: a mention in a markdown file is the literal string
 * `@username`, so the file stays readable git-native truth and nothing here
 * has to understand a macro dialect to read it. The pill is purely a view
 * detail and is drawn only for handles this space actually knows — an
 * unknown `@foo` is left as the ordinary text it is. Hovering the pill shows
 * the person's full name via the native `title` attribute — that IS this
 * surface's "hover preview", no separate tooltip component needed.
 *
 * Token-boundary rules are a deliberate duplicate of EDITOR's own
 * `editor/mentions.ts` (same handle shape as `usernameSchema` in
 * shared/contracts.ts: 2-32 chars, `[a-z0-9][a-z0-9._-]*`, matched
 * case-insensitively) rather than an import from it — this module has to run
 * standalone wherever `<Markdown>` is mounted, including EDITOR's own
 * detached-root hover-preview card and live html-widget (see mountReact in
 * editor/react-host.ts), which is exactly the kind of cross-zone coupling
 * DEV-PLAN keeps SHELL/MARKDOWN and EDITOR independent to avoid. Keep the
 * two files' boundary behaviour in sync by hand if either one changes.
 */
import type { Element, ElementContent, Root } from 'hast';

/** Handle length bounds, mirroring `usernameSchema` in shared/contracts.ts. */
export const MIN_HANDLE = 2;
export const MAX_HANDLE = 32;

/**
 * What may *not* sit in front of an `@` for it to count as a mention: letters
 * and digits (mid-word), and the characters an e-mail address is made of —
 * `a@b`, `team.lead@folio.dev` and `x-1@y` all land on this rule. Line start,
 * a space or ordinary punctuation (`(@ann)`, `«@ann»`) all pass.
 */
const BLOCKED_BEFORE = /[\p{L}\p{N}_@.+-]/u;

/** Handles as written in text: matched case-insensitively, looked up in lower case. */
const HANDLE_IN_TEXT = /@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** `.`/`-`/`_` at the end of a token is sentence punctuation, not the handle. */
const TRAILING_PUNCTUATION = /[._-]+$/;

/** Tags whose text is never a mention — `` `@types/node` `` is not a person. */
const SKIP_TAGS = new Set(['code', 'pre']);

export interface MentionToken {
  /** Offset of the `@` itself, within the text passed in. */
  from: number;
  /** End of the handle, exclusive. */
  to: number;
  /** The handle without `@`, lower-cased for lookup. */
  handle: string;
}

/**
 * Every `@handle` in `text`. Nothing here decides whether a handle is real —
 * that is `lookup`'s job in `splitMentionText`/`rehypeMentions` below. Works
 * on multi-line text (a hast text node can contain literal `\n` from a soft
 * line break within one paragraph) — `BLOCKED_BEFORE` never matches `\n`, so
 * a handle right after one is correctly treated as "start of line".
 */
export function findMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  HANDLE_IN_TEXT.lastIndex = 0;
  for (let match = HANDLE_IN_TEXT.exec(text); match; match = HANDLE_IN_TEXT.exec(text)) {
    const at = match.index;
    if (at > 0 && BLOCKED_BEFORE.test(text[at - 1])) continue;
    const handle = match[1].replace(TRAILING_PUNCTUATION, '');
    if (handle.length < MIN_HANDLE || handle.length > MAX_HANDLE) continue;
    tokens.push({ from: at, to: at + 1 + handle.length, handle: handle.toLowerCase() });
  }
  return tokens;
}

/** Display name for a known handle; undefined leaves the text plain. */
export type MentionLookup = (handle: string) => string | undefined;

/**
 * Splits `text` around every KNOWN `@handle`, or returns null when nothing in
 * it resolves (the common case — the caller should leave the original text
 * node untouched rather than replace it with an identical copy).
 */
export function splitMentionText(text: string, lookup: MentionLookup): ElementContent[] | null {
  const tokens = findMentionTokens(text);
  if (tokens.length === 0) return null;

  const parts: ElementContent[] = [];
  let cursor = 0;
  let matchedAny = false;
  for (const token of tokens) {
    const name = lookup(token.handle);
    if (name === undefined) continue; // unknown handle: leave as plain text, as stored
    matchedAny = true;
    if (token.from > cursor) parts.push({ type: 'text', value: text.slice(cursor, token.from) });
    const pill: Element = {
      type: 'element',
      tagName: 'span',
      properties: { className: ['folio-mention'], title: name },
      children: [{ type: 'text', value: text.slice(token.from, token.to) }],
    };
    parts.push(pill);
    cursor = token.to;
  }
  if (!matchedAny) return null;
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}

/** Depth-first, in place — same "rebuild this children array" shape as collapsibleSections.ts's groupSiblings, chosen for the same reason: precise control over how many nodes replace the one text node being split. */
function walk(children: ElementContent[], lookup: MentionLookup): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === 'text') {
      const parts = splitMentionText(node.value, lookup);
      if (parts) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1; // resume right after the nodes just inserted
      }
      continue;
    }
    if (node.type === 'element') {
      if (SKIP_TAGS.has(node.tagName)) continue; // never light up code/pre content
      walk(node.children as ElementContent[], lookup);
    }
  }
}

/**
 * Rehype plugin: wraps every known `@handle` in the tree's text with
 * `<span class="folio-mention" title="Full Name">@handle</span>`.
 * `lookup` undefined (space unknown, or the mentionable list hasn't loaded
 * yet — see mentionIndex.ts) is a no-op: the safe default is plain text,
 * exactly what would be shown for an unknown handle anyway.
 */
export function rehypeMentions(lookup: MentionLookup | undefined) {
  return (tree: Root) => {
    if (!lookup) return;
    walk(tree.children as ElementContent[], lookup);
  };
}
