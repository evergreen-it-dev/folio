/**
 * Pasting the app's own page URL (what the sidebar's "Copy link" puts on the
 * clipboard: `${origin}/s/<space>/p/<id>`) writes a link that reads as the
 * page title, the way Confluence and Notion do, instead of a naked address.
 *
 * Reading mode already shows such a URL as a title (markdown/folioLinks.ts);
 * this is the editor half. The link written is ordinary markdown, identical in
 * live and source mode and inside a table cell:
 *
 *  - a page of the SAME space whose path the page index knows gets the same
 *    shape the `[[` picker writes (wikilink.ts): `[Title](../relative/path.md)`.
 *    It survives a domain change and a move of the instance, and is what every
 *    other tool that reads the files understands.
 *  - any other page of this instance (another space, or a path not found)
 *    keeps the absolute URL as target: `[Title](https://host/s/x/p/id)`.
 *
 * The title may not be known yet (index not loaded). The paste is never held:
 * the bare URL goes in at once, as a plain paste would, and when the title
 * arrives (at most `RESOLVE_TIMEOUT_MS`) that very range is replaced by the
 * link, provided it still reads exactly as the URL. Without a title the bare
 * URL simply stays. The upgrade is its own undo step.
 *
 * Selection + URL stays paste-link.ts's job (it links the selected words).
 */
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { ensurePageIndex, pageIndex } from './page-index';
import { formatLinkTarget, relativePath } from './paths';
import { pastedUrl } from './format';
import { pageContextFacet, type PageContext } from './live-preview';
import { surroundings } from './paste-link';
import { parseFolioLink, type FolioLinkRef } from '../markdown/folioLinks';
import { ensureFolioLinkResolved, folioLinkFailed, onFolioLinkSettled, resolvedFolioLink } from '../markdown/folioLinkIndex';

export const RESOLVE_TIMEOUT_MS = 5000;

type PageRef = Extract<FolioLinkRef, { kind: 'page' }>;
type LinkContext = Pick<PageContext, 'space' | 'pagePath'>;

/** `url` as a reference to a page of THIS instance, or null for anything else. */
export function pageRefOf(url: string): PageRef | null {
  const origin = typeof window === 'undefined' ? undefined : window.location.origin;
  const ref = parseFolioLink(url, origin);
  return ref && ref.kind === 'page' ? ref : null;
}

/** Link text: no brackets or line breaks (they would end the label early). */
function labelOf(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([[\]\\])/g, '\\$1');
}

/** `[title](target)`; `table` also escapes the `|` that would split a row. */
export function pageLinkMarkdown(title: string, target: string, table: boolean): string | null {
  const label = labelOf(title);
  if (!label) return null;
  const out = `[${label}](${formatLinkTarget(target)})`;
  return table ? out.replace(/\|/g, '\\|') : out;
}

export interface PageTarget {
  title: string;
  /** What the link points at: a relative .md path, or the absolute URL. */
  target: string;
}

/** What is known right now, without the network. */
export function knownPageTarget(ref: PageRef, url: string, ctx: LinkContext): PageTarget | null {
  if (ref.space === ctx.space && ctx.pagePath) {
    const entry = pageIndex(ref.space).find((e) => e.id === ref.id);
    if (entry) return { title: entry.title, target: relativePath(ctx.pagePath, entry.path) };
  }
  const resolved = resolvedFolioLink(ref);
  return resolved ? { title: resolved.title, target: url } : null;
}

export function knownPageLink(ref: PageRef, url: string, ctx: LinkContext, table: boolean): string | null {
  const known = knownPageTarget(ref, url, ctx);
  return known ? pageLinkMarkdown(known.title, known.target, table) : null;
}

function settled(ref: PageRef): Promise<void> {
  return new Promise((resolve) => {
    const done = () => Boolean(resolvedFolioLink(ref)) || folioLinkFailed(ref);
    const off = onFolioLinkSettled(() => {
      if (done()) {
        off();
        resolve();
      }
    });
    ensureFolioLinkResolved(ref);
    if (done()) {
      off();
      resolve();
    }
  });
}

/**
 * Title and target for `url`, waiting (briefly) when needed; null when they
 * cannot be had in time.
 */
export async function resolvePageTarget(url: string, ctx: LinkContext): Promise<PageTarget | null> {
  const ref = pageRefOf(url);
  if (!ref) return null;
  const now = knownPageTarget(ref, url, ctx);
  if (now) return now;

  const work = (async () => {
    if (ref.space === ctx.space) {
      await ensurePageIndex(ref.space);
      const viaIndex = knownPageTarget(ref, url, ctx);
      if (viaIndex) return viaIndex;
    }
    await settled(ref);
    return knownPageTarget(ref, url, ctx);
  })().catch(() => null);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS));
  return Promise.race([work, timeout]);
}

/** The markdown for `url`, or null when the title cannot be had in time (the caller keeps the bare URL). */
export async function resolvePageLink(url: string, ctx: LinkContext, table: boolean): Promise<string | null> {
  const found = await resolvePageTarget(url, ctx);
  return found ? pageLinkMarkdown(found.title, found.target, table) : null;
}

/** Whether a paste of `url` at the (empty) caret of `state` may become a page link. */
export function mayLinkAtCaret(state: EditorState): boolean {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty || state.readOnly) return false;
  const before = surroundings(state, range.head, -1);
  const after = surroundings(state, range.head, 1);
  return !before.plain && !after.plain;
}

function inTableAtCaret(state: EditorState): boolean {
  const pos = state.selection.main.head;
  return surroundings(state, pos, -1).inTable || surroundings(state, pos, 1).inTable;
}

/**
 * Bare URLs inserted by a paste whose title was not known yet, waiting to be
 * upgraded. The positions ride along every later change of the document, so the
 * upgrade lands on the same text however much was typed in the meantime.
 */
interface Pending {
  id: number;
  from: number;
  to: number;
  url: string;
}

const addPending = StateEffect.define<Pending>();
const dropPending = StateEffect.define<number>();

const pendingField = StateField.define<Pending[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      next = next
        .map((p) => ({ ...p, from: tr.changes.mapPos(p.from, 1), to: tr.changes.mapPos(p.to, -1) }))
        .filter((p) => p.to > p.from);
    }
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next = [...next, effect.value];
      else if (effect.is(dropPending)) next = next.filter((p) => p.id !== effect.value);
    }
    return next;
  },
});

let nextId = 1;

/**
 * Replace the pending bare URL with the link, but only while the text there is
 * still exactly the URL. Its own undo step: one undo gives the bare URL back
 * (the person may prefer it), a second removes the paste.
 */
function upgrade(view: EditorView, id: number, markdown: string | null): void {
  if (!view.dom.isConnected) return;
  const pending = view.state.field(pendingField, false)?.find((p) => p.id === id);
  if (!pending) return;
  const effects = [dropPending.of(id)];
  if (markdown && view.state.doc.sliceString(pending.from, pending.to) === pending.url) {
    const head = view.state.selection.main.head;
    const selection =
      head === pending.to ? EditorSelection.cursor(pending.from + markdown.length) : undefined;
    view.dispatch({
      changes: { from: pending.from, to: pending.to, insert: markdown },
      selection,
      effects,
      annotations: isolateHistory.of('full'),
      userEvent: 'input.paste',
    });
  } else {
    view.dispatch({ effects });
  }
}

export const pastePageLink: Extension = [
  pendingField,
  EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (!data || (data.files && data.files.length > 0)) return false;
      const url = pastedUrl(data.getData('text/plain') ?? '');
      const ref = url ? pageRefOf(url) : null;
      if (!url || !ref) return false;
      if (!mayLinkAtCaret(view.state)) return false;

      const ctx = view.state.facet(pageContextFacet);
      const table = inTableAtCaret(view.state);
      event.preventDefault();

      const range = view.state.selection.main;
      const known = knownPageLink(ref, url, ctx, table);
      const text = known ?? url;
      const id = nextId++;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        effects: known ? [] : [addPending.of({ id, from: range.from, to: range.from + url.length, url })],
        scrollIntoView: true,
        userEvent: 'input.paste',
      });
      // Never held: the URL is already in. The title upgrades it when it arrives.
      if (!known) void resolvePageLink(url, ctx, table).then((md) => upgrade(view, id, md));
      return true;
    },
  }),
];
