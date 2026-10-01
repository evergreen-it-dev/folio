/**
 * The «/» insert menu and the fenced-code language picker.
 *
 * The entries themselves — and the edits they make — live in
 * block-commands.ts, which the pinned toolbar (round 25) shares. Everything
 * here is the completion wrapper around them: matching in any of the three
 * interface languages, the icon/description/hint columns, and the one detail
 * that is specific to a trigger character — an apply has to reach one position
 * back to swallow the «/» itself.
 */
import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import { languages } from '@codemirror/language-data';
import { BLOCK_ITEMS, lineLead, matchText, type BlockItem } from './block-commands';
import { createIcon, type IconName } from './icons';
import { onLanguageChanged, t } from './i18n';
import { emojiOf, findEmojiTrigger } from './emoji-complete';
import { findMentionQuery } from './mentions';
import { findWikilinkQuery } from './wikilink';

interface FolioMeta {
  icon: IconName;
  badge?: string;
  description?: string;
  hint?: string;
}

interface FolioCompletion extends Completion {
  folio?: FolioMeta;
}

/**
 * The completion range starts *after* the «/», so matching sees only what the
 * user typed. Applying therefore has to reach one character back to swallow it.
 *
 * This is the lead-only case: everything before the «/» was already just the
 * line's own container and marker, so the marker IS what the author is
 * replacing — «- /table» means "make this a table", not "put a table after my
 * bullet".
 */
function applyBlock(item: BlockItem): Completion['apply'] {
  return (view, completion, from, to) => {
    // `from` is the first character AFTER the «/», so the slash itself is at
    // from - 1 and everything the author typed is inside [slash, to].
    const slash = from - 1;
    const line = view.state.doc.lineAt(slash);
    // Swallow the marker and keep the CARRY — indent and blockquotes are the
    // container this line lives in, and a heading asked for inside a quote
    // stays inside that quote (see lineLead).
    const { carry } = lineLead(view.state.sliceDoc(line.from, slash));
    item.insert(view, line.from + carry.length, to, completion);
  };
}

/**
 * The after-text case: the "/" followed real prose (owner typed "We make
 * well-known products /" inside a list item and got nothing — the old
 * trigger only ever looked at the line's lead). The author's text is not the
 * marker here, it is content, so it has to survive untouched; the block
 * instead opens on a fresh line below, carrying the same container the
 * current line has. Two dispatches: the first removes the trigger (the space
 * that opened it, the «/», and whatever query followed) and opens that empty
 * line, the second lets the entry insert itself there exactly as the
 * lead-only case does on its own line.
 */
function applyBlockNewLine(item: BlockItem): Completion['apply'] {
  return (view, completion, from, to) => {
    const slash = from - 1;
    const line = view.state.doc.lineAt(slash);
    const { carry } = lineLead(line.text);
    const hasSpaceBefore = slash > line.from && /[ \t]/.test(view.state.sliceDoc(slash - 1, slash));
    const removeFrom = hasSpaceBefore ? slash - 1 : slash;

    view.dispatch({ changes: { from: removeFrom, to, insert: `\n${carry}` } });
    const insertAt = removeFrom + 1 + carry.length;
    item.insert(view, insertAt, insertAt, completion);
  };
}

/** Rebuilt on every query: labels are translated, so nothing may be cached. */
function blockOptions(applyFor: (item: BlockItem) => Completion['apply']): FolioCompletion[] {
  return BLOCK_ITEMS.map((item, index) => ({
    label: matchText(item),
    displayLabel: t(`slash.${item.id}.name`),
    apply: applyFor(item),
    boost: BLOCK_ITEMS.length - index - (item.demote ?? 0),
    folio: {
      icon: item.icon,
      badge: item.badge,
      description: t(`slash.${item.id}.description`),
      hint: item.hint,
    },
  }));
}

const SLASH_QUERY = /\/([\p{L}\p{N}_-]*)$/u;

/**
 * «/» opens the insert menu in two cases:
 *
 *  - **lead-only** (unchanged): nothing but the line's own lead stands before
 *    it — a blank line, an indented line, a blockquote, and a list item all
 *    qualify (owner, 11.09: "/ does not work if I am already in a list — it is
 *    very confusing"). The entry replaces the marker, `applyBlock`.
 *  - **after text**, Notion-style: the "/" follows a space or tab that itself
 *    follows real text — `text /`, or `- text /` inside a list item (owner,
 *    "We make well-known products /" got nothing before this). The
 *    entry lands on a new line below instead, `applyBlockNewLine`, so a
 *    heading or table typed mid-sentence doesn't mangle the sentence.
 *
 * What still doesn't qualify either way: a slash with no space before it and
 * real text right up against it — `web/src`, `and/or`, `see /usr/bin` typed as
 * part of a word — stays a path or a fraction, not a menu.
 */
export function slashMenu(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = SLASH_QUERY.exec(before);
  if (!match) return null;
  const lead = before.slice(0, before.length - match[0].length);
  const { carry, marker } = lineLead(lead);
  const leadOnly = carry.length + marker.length === lead.length;

  let afterText = false;
  if (!leadOnly) {
    const precedingChar = lead.slice(-1);
    afterText = (precedingChar === ' ' || precedingChar === '\t') && lead.slice(0, -1).trim().length > 0;
    if (!afterText) return null;
  }

  return {
    from: context.pos - match[1].length,
    options: rankBlockOptions(match[1], afterText ? applyBlockNewLine : applyBlock),
    // We filter ourselves (see rankBlockOptions), so CodeMirror must not
    // filter again on top — and without `validFor` it re-queries this source
    // on every keystroke, which is what keeps our own ranking current.
    filter: false,
  };
}

/**
 * Our own filtering, because CodeMirror's is wrong for these labels. Its
 * fuzzy matcher has an explicit rule — "for single-character queries, only
 * match when they occur right at the start [of the label]" — and our label is
 * `matchText(item)`: every UI language's name plus the aliases, so it starts
 * with the UKRAINIAN name. `/n` therefore matched nothing at all (measured:
 * 0 options for `/n`, 2 for `/no`), which reads as a broken menu rather than
 * as an empty result (owner, 11.09: "if I type /n it does not fire — it has
 * to search by 1 character too").
 *
 * Matching a WORD start anywhere in the label is both what fixes that and
 * what people actually expect from this kind of menu: `/t` offers table,
 * task, text; `/n` offers note and numbered list. A substring hit still
 * counts, one rank lower, so `/ordered` and `/able` keep working. Ties fall
 * back to the menu's own order, so an empty query renders exactly as before.
 */
export function rankBlockOptions(
  query: string,
  applyFor: (item: BlockItem) => Completion['apply'] = applyBlock,
): FolioCompletion[] {
  const options = blockOptions(applyFor);
  if (!query) return options;
  const needle = query.toLowerCase();
  const ranked: { option: FolioCompletion; rank: number; index: number }[] = [];
  options.forEach((option, index) => {
    const haystack = option.label.toLowerCase();
    const wordStart = haystack.split(/\s+/).some((word) => word.startsWith(needle));
    if (wordStart) ranked.push({ option, rank: 0, index });
    // A substring hit only counts from two characters on. With one, «n»
    // matches the «n» inside "Heading" and half the menu survives the filter,
    // which is no more useful than no filter at all (measured: 19 of 26
    // entries for «/n»). One character means "a word starting with this".
    else if (needle.length > 1 && haystack.includes(needle)) ranked.push({ option, rank: 1, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((entry) => entry.option);
}

/** ~150 entries, so this one is cached and rebuilt only on a language switch. */
let languageOptions: FolioCompletion[] | null = null;
onLanguageChanged(() => {
  languageOptions = null;
});

function fenceOptions(): FolioCompletion[] {
  languageOptions ??= [
    {
      label: 'mermaid diagram',
      displayLabel: 'mermaid',
      apply: 'mermaid',
      boost: 99,
      folio: { icon: 'diagram', description: t('fence.mermaid') },
    },
    ...languages.map((language) => ({
      label: [language.name, ...language.alias].join(' ').toLowerCase(),
      displayLabel: language.name,
      apply: language.name.toLowerCase(),
      folio: { icon: 'code' as IconName },
    })),
  ];
  return languageOptions;
}

/** After ``` on its own line, suggest a language for the fence. */
export function fenceLanguages(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = /^\s*```(\w*)$/.exec(before);
  if (!match) return null;
  return {
    from: context.pos - match[1].length,
    options: fenceOptions(),
    validFor: /^\w*$/,
  };
}

/* ------------------------------------------------------------- rendering -- */

const metaOf = (completion: Completion): FolioMeta | undefined =>
  (completion as FolioCompletion).folio;

export function folioOptionClass(completion: Completion): string {
  return metaOf(completion) ? 'cm-folio-option' : '';
}

export const folioAddToOptions = [
  {
    position: 20,
    render: (completion: Completion): Node | null => {
      const glyph = emojiOf(completion);
      if (glyph) {
        const box = document.createElement('div');
        box.className = 'cm-folio-icon cm-folio-icon--emoji';
        box.textContent = glyph;
        return box;
      }
      const meta = metaOf(completion);
      if (!meta) return null;
      const box = document.createElement('div');
      box.className = 'cm-folio-icon';
      box.appendChild(createIcon(meta.icon, meta.badge));
      return box;
    },
  },
  {
    position: 60,
    render: (completion: Completion): Node | null => {
      const description = metaOf(completion)?.description;
      if (!description) return null;
      const box = document.createElement('div');
      box.className = 'cm-folio-desc';
      box.textContent = description;
      return box;
    },
  },
  {
    position: 90,
    render: (completion: Completion): Node | null => {
      const hint = metaOf(completion)?.hint;
      if (!hint) return null;
      const box = document.createElement('div');
      box.className = 'cm-folio-hint';
      box.textContent = hint;
      return box;
    },
  },
];

/**
 * The panel gets an extra class per context so CSS can widen it and add the
 * header hint: the page picker should read as a small search palette, not a
 * bare autocomplete strip.
 */
export function folioTooltipClass(state: EditorState): string {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);

  // Whichever trigger sits closer to the caret is the one being answered —
  // `[[ ((` is an emoji query, not a page query.
  const wiki = findWikilinkQuery(before, before.length);
  const emoji = findEmojiTrigger(before);
  const mention = findMentionQuery(before);
  const open: { from: number; cls: string }[] = [];
  if (wiki) open.push({ from: wiki.from, cls: 'cm-folio-pages' });
  if (emoji) open.push({ from: emoji.from, cls: 'cm-folio-emoji' });
  if (mention) open.push({ from: mention.at, cls: 'cm-folio-mentions' });
  if (open.length === 0) return 'cm-folio-completions';

  const closest = open.reduce((best, item) => (item.from >= best.from ? item : best));
  return `cm-folio-completions ${closest.cls}`;
}
