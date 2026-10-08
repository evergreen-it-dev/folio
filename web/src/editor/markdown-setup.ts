/**
 * The non-collaborative half of the editor configuration: markdown language,
 * highlighting, keymaps, completions and the CodeMirror theme.
 *
 * Colors come from CSS custom properties defined in editor.css so light/dark
 * follow `prefers-color-scheme` without rebuilding the theme.
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { FolioHighlight } from './highlight-syntax';
import { FolioUnderline } from './underline-syntax';
import { FolioStatus } from './status-syntax';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  placeholder,
  rectangularSelection,
  tooltips,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';
import {
  fenceLanguages,
  folioAddToOptions,
  folioOptionClass,
  folioTooltipClass,
  slashMenu,
} from './slash-menu';
import { emojiClosingColon, emojiCompletions } from './emoji-complete';
import { formatting } from './format-toolbar';
import { listIndentKeymap } from './list-indent';
import { pinToolbar } from './pin-toolbar';
import { t as translate } from './i18n';
import { mentionCompletions } from './mentions';
import { pasteLinkOverSelection } from './paste-link';
import { wikilinkCompletions } from './wikilink';

/**
 * No setext headings (`text` over `---` / `===`) while editing. The first `-`
 * typed on the line right under a paragraph is a valid CommonMark setext h2
 * underline, so the parser re-read the whole paragraph above it as a heading
 * the moment one dash was typed (`-` is also the start of `- ` / `---`, so it
 * is typed constantly). ATX `#` headings are the only ones this editor writes;
 * the reading view (remark) still understands setext in pasted or imported
 * markdown. Without the block, `---` is a thematic break and `-` plain text.
 */
export const noSetextHeadings: MarkdownConfig = { remove: ['SetextHeading'] };

const folioHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.65em', fontWeight: '650', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.38em', fontWeight: '650', lineHeight: '1.3' },
  { tag: t.heading3, fontSize: '1.18em', fontWeight: '650' },
  { tag: t.heading4, fontSize: '1.05em', fontWeight: '650' },
  { tag: [t.heading5, t.heading6], fontWeight: '650', color: 'var(--folio-ed-muted)' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--folio-ed-muted)' },
  { tag: t.link, color: 'var(--folio-ed-accent)' },
  { tag: t.url, color: 'var(--folio-ed-muted)' },
  // The variable lets a callout line (editor.css) opt its body text back out of
  // the muted quote colour; nothing else defines it, so a plain quote is muted.
  { tag: t.quote, color: 'var(--folio-ed-quote-fg, var(--folio-ed-muted))' },
  { tag: t.monospace, fontFamily: 'var(--folio-ed-mono)', fontSize: '0.92em', color: 'var(--folio-ed-code)' },
  { tag: t.labelName, fontFamily: 'var(--folio-ed-mono)', fontSize: '0.92em', color: 'var(--folio-ed-muted)' },
  { tag: t.processingInstruction, color: 'var(--folio-ed-marker)' },
  { tag: t.contentSeparator, color: 'var(--folio-ed-marker)' },
  { tag: t.atom, color: 'var(--folio-ed-accent)' },
  { tag: t.escape, color: 'var(--folio-ed-marker)' },

  // Embedded code inside fenced blocks.
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--folio-ed-syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--folio-ed-syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--folio-ed-syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--folio-ed-syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--folio-ed-syn-func)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--folio-ed-syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--folio-ed-syn-prop)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--folio-ed-muted)' },
  { tag: t.invalid, color: 'var(--folio-ed-danger)' },
]);

const folioTheme = EditorView.theme({
  // `&` also matches the tooltip container CodeMirror appends to <body>
  // (it copies the editor's theme classes). Sizing must therefore stay on
  // `&.cm-editor` only — a 100%-tall body child adds phantom document height,
  // makes the window scrollable and swallows clicks over the app shell.
  '&': {
    color: 'var(--folio-ed-fg)',
    backgroundColor: 'transparent',
    fontSize: '15px',
  },
  '&.cm-editor': { height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--folio-ed-sans)',
    lineHeight: '1.7',
    overflowY: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--folio-ed-caret)',
    padding: '1.5rem 0 40vh',
    maxWidth: 'var(--folio-ed-measure)',
    margin: '0 auto',
    width: '100%',
  },
  '.cm-line': { padding: '0 1.5rem' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--folio-ed-caret)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--folio-ed-selection)',
  },
  // The same color, but with a selector that does not lose to the base
  // CodeMirror theme. @codemirror/view has a rule of its own
  // `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground
  //  { background: #d7d4f0 }`
  // — pale lilac, meant for a light background. It is more specific than the
  // line above, so it won EXACTLY when the editor was focused, that is, at the
  // moment a person selects with the mouse: the unfocused selection was ours
  // and dark, and the focused one theirs and light, with light text on top
  // (the owner's report, 11.09: "in the dark theme the selection is
  // impossible to read"). The editor also always has the `cm-light` class (the
  // theme is not marked as dark), so in the dark theme it was the light branch
  // that was taken. We repeat the structure of their selector so that our
  // color wins in both focus states and in both themes.
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--folio-ed-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--folio-ed-selection-match)' },
  '.cm-placeholder': { color: 'var(--folio-ed-faint)', fontStyle: 'italic' },
  '.cm-panels': {
    backgroundColor: 'var(--folio-ed-panel)',
    color: 'var(--folio-ed-fg)',
    border: 'none',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--folio-ed-border)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontFamily: 'var(--folio-ed-sans)',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input': {
    backgroundColor: 'var(--folio-ed-bg)',
    color: 'var(--folio-ed-fg)',
    border: '1px solid var(--folio-ed-border)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--folio-ed-selection-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--folio-ed-selection)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--folio-ed-panel)',
    border: '1px solid var(--folio-ed-border)',
    borderRadius: '6px',
    fontFamily: 'var(--folio-ed-sans)',
    fontSize: '13px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--folio-ed-selection)',
    color: 'var(--folio-ed-fg)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--folio-ed-selection-match)',
    outline: 'none',
  },
});

/** Everything the editor needs except the Yjs binding and the live-preview mode config. */
export function markdownEditorExtensions(): Extension {
  return [
    // Not the package's own `pasteURLAsLink`: it wraps on any clipboard that
    // merely STARTS with a URL, refuses a selection with formatting in it and
    // writes a `)` into the target unescaped. `pasteLinkOverSelection` below
    // does the same job by the rules in format.ts, shared with table cells.
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [FolioHighlight, FolioUnderline, FolioStatus, noSetextHeadings], pasteURLAsLink: false }),
    syntaxHighlighting(folioHighlight),
    folioTheme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    search({ top: true }),
    autocompletion({
      override: [slashMenu, fenceLanguages, wikilinkCompletions, mentionCompletions, emojiCompletions],
      icons: false,
      optionClass: folioOptionClass,
      addToOptions: folioAddToOptions,
      tooltipClass: folioTooltipClass,
      maxRenderedOptions: 60,
    }),
    // Popups render into <body> with fixed positioning so neither the editor's
    // scroll container nor the app shell can clip them at the viewport edge.
    tooltips(
      typeof document === 'undefined'
        ? { position: 'fixed' }
        : { position: 'fixed', parent: document.body },
    ),
    emojiClosingColon(),
    // Round 21: the floating bar over a selection, plus Mod+B/I/U/Shift+X/E.
    // Both modes get it — source mode writes the same markdown.
    formatting,
    // A URL pasted over selected text links the text instead of replacing it.
    // Before the page-level paste handlers (they come after this list), and it
    // claims nothing but "selection + one URL".
    pasteLinkOverSelection,
    // Round 25: the pinned command strip above the document, and its hotkey.
    pinToolbar,
    // Tab/Shift+Tab nest and un-nest a list item. Prec.high so it beats
    // defaultKeymap below, which has no Tab binding of its own — everywhere
    // that isn't a list line, Tab keeps moving focus on as it always has.
    listIndentKeymap,
    // Function form: CodeMirror builds it when the document is empty, so the
    // current language applies without reconfiguring the extension.
    placeholder(() => {
      const dom = document.createElement('span');
      dom.textContent = translate('placeholder');
      return dom;
    }),
    // Above defaultKeymap so Mod-f/Mod-d reach search and completion first.
    Prec.high(keymap.of([...closeBracketsKeymap, ...searchKeymap, ...completionKeymap])),
    // No history() here on purpose: undo/redo is owned by the Yjs UndoManager.
    keymap.of(defaultKeymap),
  ];
}
