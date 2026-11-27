/**
 * The popover behind every "make this a link" gesture: the toolbar buttons,
 * ⇧⌘K, the table cell's bar and its mini-slash. Until now they only wrote
 * `[text]()` and, in live preview, the author saw nothing to type into.
 *
 * One input accepts an address OR searches the pages of the current space
 * (the `[[` picker's ranking over the same page index). Enter on an address
 * writes `[selection](address)`; picking a page writes the same relative `.md`
 * link the `[[` picker does; an address of a page of this instance (what the
 * sidebar's "Copy link" produces) is treated as that page. With nothing
 * selected the link text is the page title, or the address itself.
 *
 * Esc or leaving the input changes nothing. The popover never writes into the
 * document itself: it hands the finished markdown to `onApply`, so the
 * CodeMirror document and a table cell's `<textarea>` share it.
 */
import { t } from './i18n';
import { panel, place } from './emoji-popover';
import { pastedUrl } from './format';
import { pageRefOf, pageLinkMarkdown, resolvePageTarget, knownPageTarget, type PageTarget } from './paste-page-link';
import { ensurePageIndex, pageIndex, type PageEntry } from './page-index';
import { formatLinkTarget, relativePath } from './paths';
import { rankPages } from './wikilink';

export type LinkPopoverClose = 'apply' | 'cancel' | 'blur';

export interface LinkPopoverOptions {
  /** Fixed-position anchor (viewport coordinates): the popover opens below it. */
  x: number;
  y: number;
  space: string;
  pagePath: string;
  /** The selected words the link will wrap; '' when nothing is selected. */
  label: string;
  /** Text the input starts with (a selected address). */
  initial?: string;
  /** Receives the finished `[label](target)`. */
  onApply(markdown: string): void;
  /** Always called once, after `onApply` or when the popover goes away unused. */
  onClose(reason: LinkPopoverClose): void;
}

export interface LinkPopoverHandle {
  close(): void;
}

const MAX_ROWS = 8;
const ADDRESS = /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#|\.{1,2}\/|www\.)\S*$/i;
/** A relative page path (what an existing link to a page holds). */
const PAGE_PATH = /^\S+\.md(?:#\S*)?$/i;
const DOMAIN = /^[^\s/@]+\.[a-z]{2,}(?:[/?#]\S*)?$/i;

/** Whether what was typed is an address rather than a page search. */
export function looksLikeAddress(query: string): boolean {
  return ADDRESS.test(query) || DOMAIN.test(query) || PAGE_PATH.test(query);
}

/** `example.com` and `www.x.y` get their scheme, like a pasted address does. */
export function normalizeAddress(query: string): string {
  if (PAGE_PATH.test(query) && !ADDRESS.test(query)) return query;
  if (/^www\./i.test(query) || (DOMAIN.test(query) && !ADDRESS.test(query))) return `https://${query}`;
  return pastedUrl(query) ?? query;
}

/** `[label](target)`; without a label the title (or the target itself) reads as the text. */
export function linkMarkdown(label: string, title: string, target: string): string {
  if (label) return `[${label}](${formatLinkTarget(target)})`;
  return pageLinkMarkdown(title, target, false) ?? `[${target}](${formatLinkTarget(target)})`;
}

interface Row {
  title: string;
  path: string;
  target: string;
}

let current: LinkPopoverHandle | null = null;

export function openLinkPopover(options: LinkPopoverOptions): LinkPopoverHandle {
  current?.close();

  const dom = panel('folio-link-pop');
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', t('linkPopover.aria'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folio-link-pop__input';
  input.placeholder = t('linkPopover.placeholder');
  input.setAttribute('aria-label', t('linkPopover.placeholder'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = options.initial ?? '';
  const list = document.createElement('div');
  list.className = 'folio-link-pop__list';
  list.setAttribute('role', 'listbox');
  dom.append(input, list);

  let rows: Row[] = [];
  let active = 0;
  let navigated = false;
  let done = false;
  /** An own-instance page address typed or pasted, once its title is known. */
  let ownPage: { url: string; found: PageTarget } | null = null;

  const rowOf = (entry: PageEntry): Row => ({
    title: entry.title || entry.path,
    path: entry.path,
    target: relativePath(options.pagePath, entry.path),
  });

  const compute = () => {
    const query = input.value.trim();
    if (ownPage && ownPage.url === query) {
      rows = [{ title: ownPage.found.title, path: ownPage.found.target, target: ownPage.found.target }];
    } else if (query && looksLikeAddress(query)) {
      rows = [];
    } else {
      const entries = options.space ? pageIndex(options.space) : [];
      rows = (query ? rankPages(query, entries, MAX_ROWS) : entries.slice(0, MAX_ROWS)).map(rowOf);
    }
    active = Math.min(active, Math.max(0, rows.length - 1));
  };

  const draw = () => {
    compute();
    list.replaceChildren();
    const query = input.value.trim();
    rows.forEach((row, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'folio-link-pop__row';
      button.setAttribute('role', 'option');
      if (index === active) button.dataset.active = 'true';
      const title = document.createElement('span');
      title.className = 'folio-link-pop__title';
      title.textContent = row.title;
      const path = document.createElement('span');
      path.className = 'folio-link-pop__path';
      path.textContent = row.path;
      button.append(title, path);
      // The input keeps focus: a click must not blur it (that would cancel).
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        applyRow(row);
      });
      list.appendChild(button);
    });
    if (rows.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'folio-link-pop__hint';
      hint.textContent = !query
        ? t('linkPopover.hint')
        : looksLikeAddress(query)
          ? t('linkPopover.linkTo', { url: query })
          : t('linkPopover.noPages');
      list.appendChild(hint);
    }
  };

  const finish = (reason: LinkPopoverClose) => {
    if (done) return;
    done = true;
    if (current === handle) current = null;
    dom.remove();
    options.onClose(reason);
  };

  const apply = (title: string, target: string) => {
    if (done) return;
    options.onApply(linkMarkdown(options.label, title, target));
    finish('apply');
  };

  const applyRow = (row: Row) => apply(row.title, row.target);

  const commit = async () => {
    const query = input.value.trim();
    if (!query) {
      if (navigated && rows[active]) applyRow(rows[active]);
      return;
    }
    if (!looksLikeAddress(query)) {
      if (rows[active]) applyRow(rows[active]);
      return;
    }
    if (pageRefOf(query)) {
      const found = await resolvePageTarget(query, { space: options.space, pagePath: options.pagePath });
      if (found) return apply(found.title, found.target);
    }
    const target = normalizeAddress(query);
    apply(target, target);
  };

  /** Show an own-instance page address as the page it names. */
  const recognise = () => {
    const query = input.value.trim();
    const ref = query ? pageRefOf(query) : null;
    if (!ref) {
      ownPage = null;
      return;
    }
    const ctx = { space: options.space, pagePath: options.pagePath };
    const known = knownPageTarget(ref, query, ctx);
    if (known) {
      ownPage = { url: query, found: known };
      return;
    }
    void resolvePageTarget(query, ctx).then((found) => {
      if (done || !found || input.value.trim() !== query) return;
      ownPage = { url: query, found };
      draw();
    });
  };

  input.addEventListener('input', () => {
    active = 0;
    navigated = false;
    recognise();
    draw();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish('cancel');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void commit();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      navigated = true;
      active = (active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      draw();
    }
  });
  input.addEventListener('blur', () => finish('blur'));

  const handle: LinkPopoverHandle = { close: () => finish('cancel') };
  current = handle;

  recognise();
  draw();
  document.body.appendChild(dom);
  place(dom, options.x, options.y);
  input.focus();
  input.select();
  if (options.space) {
    void ensurePageIndex(options.space).then(() => {
      if (!done) draw();
    });
  }
  return handle;
}

/**
 * The popover for a table cell's `<textarea>`: writes the link over
 * `[from, to)` of its value. While it is open the field is marked, so that the
 * cell's blur handler does not commit (and rebuild) the cell under it; once it
 * is gone the cell either gets its focus back or, when the author clicked
 * away, the blur it was spared.
 */
export function openFieldLinkPopover(
  field: HTMLTextAreaElement,
  range: { from: number; to: number },
  context: { space: string; pagePath: string },
  options: { label: string; initial?: string; onDone?: () => void },
): LinkPopoverHandle {
  const rect = field.getBoundingClientRect();
  field.dataset.linkPopover = 'open';
  return openLinkPopover({
    x: rect.left,
    y: rect.bottom + 4,
    space: context.space,
    pagePath: context.pagePath,
    label: options.label,
    initial: options.initial,
    onApply: (markdown) => {
      const end = Math.min(range.to, field.value.length);
      field.setRangeText(markdown, Math.min(range.from, end), end, 'end');
      options.onDone?.();
    },
    onClose: (reason) => {
      delete field.dataset.linkPopover;
      if (reason === 'blur') field.dispatchEvent(new FocusEvent('blur'));
      else field.focus();
    },
  });
}
