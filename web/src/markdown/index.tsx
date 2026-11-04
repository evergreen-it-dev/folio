import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { PageMeta } from '@shared/contracts';
import { splitMermaidFences } from './mermaidSplit';
import { stripFrontmatter } from './frontmatter';
import { isMdxPagePath, mdxToMarkdown } from './mdx';
import { splitPagetreeDirectives } from './pagetreeSplit';
import { splitFormDirectives } from './formSplit';
import { renderMarkdownToHtml } from './pipeline';
import { extractHeadings, HEADING_ID_PREFIX } from './headings';
import { createHeadingIdCursor } from './headingIds';
import { EmbedView } from './EmbedView';
import { renderMath } from './math';
import { requestSearch } from './searchEvent';
import {
  cachedPageLinks,
  fetchPageLinks,
  WIKILINKS_PENDING,
  WIKILINKS_UNAVAILABLE,
  wikilinkContextFromLinks,
  wikilinkCreateTarget,
  type WikilinkContext,
  type WikilinkCreateTarget,
} from './wikilinks';
import { applyCollapseState, readCollapsedSlugs, writeCollapsedSlugs } from './collapsible';
import { createTableIndexCursor } from './tables';
import { createNoteIdCursor } from './noteIds';
import {
  applyTableFitState,
  measureWideTables,
  readTableScrollOverrides,
  writeTableScrollOverrides,
} from './tableFit';
import { ensureMentionIndex, mentionName, onMentionsLoaded } from './mentionIndex';
import { onFolioLinkSettled } from './folioLinkIndex';
import { MermaidBlock } from '../diagrams';
import { Backlinks } from './Backlinks';
import { PageTree } from './PageTree';
import { FormEmbed } from './FormEmbed';
// Obsidian Bases: a ```base block runs as a live view; loaded on demand (and no static markdown -> app edge).
const BaseEmbed = lazy(() => import('../bases/BaseEmbed'));
import type { MarkdownPublicSite } from './publicSite';
import './i18n/register';
import './markdown.css';
import './status.css';
import { attachGlossaryTooltips } from './glossaryTooltip';

// Round 13: re-exported here so EDITOR's live block-widget can
// `import { PageTree } from '../../markdown'`, the same path/pattern
// `Markdown` itself is already imported by (see this file's own PageTree
// import above for the underlying component/props).
export { PageTree } from './PageTree';
export type { PageTreeProps } from './PageTree';
export type { MarkdownPublicSite } from './publicSite';

export interface MarkdownProps {
  markdown: string;
  space: string;
  /** Path of the page being rendered, relative to the space root. */
  pagePath: string;
  /**
   * Real page id, when there is one (absent for e.g. a history-version
   * preview or a synthetic folder listing). Gates the backlinks section
   * (Backlinks.tsx) and *persistence* of collapsed-section state and the
   * table fit/scroll toggle (both still work without one, they just won't
   * survive a reload — there's nothing sensible to key localStorage by).
   */
  pageId?: string;
  /**
   * Round 8: set by the public /share/:token route only. Threaded into the
   * rehype pipeline so image/file URLs keep working for a session-less
   * guest (see relativeLinks.ts), and doubles as "we're rendering for an
   * anonymous share guest" — /api/resolve needs a real session and would
   * just 401, so a relative-page-link click shows a hint instead of ever
   * calling it.
   */
  shareToken?: string;
  /** With `shareToken`: the shared page's id, to ask the share's own route for the page's file links (by-name images and files). Not a `pageId`: no backlinks or page tree for a guest. */
  shareLinksPageId?: string;
  /**
   * Set by the public site (a published space read by anonymous visitors, app/public/).
   * Like `shareToken` it means "no session here": no mentionable fetch, no backlinks,
   * no page tree, no form embed (a neutral note instead), no title resolution of pasted
   * Folio URLs. Unlike a share link it can navigate: relative `.md` links resolve
   * through the public resolve route and links to the site's own pages become the
   * site's URLs — see publicSite.ts for the shape.
   */
  publicSite?: MarkdownPublicSite;
  /**
   * The reader may create pages (editor+ on this space): a click on a wikilink
   * to a page that does not exist then offers "Create page “Note”" - which
   * needs `onCreatePage`, the app's own create call (it also refreshes the
   * sidebar; markdown/ does not import app/). Without both, the click only says
   * the page does not exist.
   */
  canCreate?: boolean;
  onCreatePage?: (input: { parentPath: string; title: string; fileStem: string }) => Promise<Pick<PageMeta, 'id' | 'space'>>;
  /**
   * Set by EmbedView when this is a note drawn inside another page
   * (`![[Note]]`): `depth` is the nesting level, `chain` the ids of the pages it
   * is nested in. An embedded note is read-only, keeps no per-page state
   * (collapsed sections, table fit), shows no backlinks and leaves the host's
   * heading and note numbering alone.
   */
  embedded?: { depth: number; chain: readonly string[] };
}

/** How many times a wikilink the index had no row for yet is asked about again (the page was edited a moment ago and indexing lags the save). */
const WIKILINK_RETRIES = 2;
const WIKILINK_RETRY_MS = 1500;

/**
 * The page's wikilinks, resolved through its metadata (wikilinks.ts). One
 * request per page, and none for a page that has no `[[` or where no session
 * exists (a share link, a history preview).
 */
function useWikilinkContext(pageId: string | undefined, publicSpace: string | undefined, shareToken: string | undefined, enabled: boolean, retry: number): WikilinkContext {
  const active = enabled && Boolean(pageId);
  const [links, setLinks] = useState(() => (active && pageId ? cachedPageLinks(pageId, publicSpace, shareToken) : undefined));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || !pageId) return;
    let cancelled = false;
    setFailed(false);
    setLinks(cachedPageLinks(pageId, publicSpace, shareToken));
    fetchPageLinks(pageId, publicSpace, shareToken).then(
      (next) => {
        if (!cancelled) setLinks(next);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, pageId, publicSpace, shareToken, retry]);
  return useMemo(() => {
    if (!active || failed) return WIKILINKS_UNAVAILABLE;
    return links ? wikilinkContextFromLinks(links) : WIKILINKS_PENDING;
  }, [active, failed, links]);
}

/** The element a `#fragment` of this page points at: a heading by its slug, a block by its id (`^id`, any case). */
function findAnchor(root: HTMLElement, hash: string): HTMLElement | null {
  let fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    /* keep as written */
  }
  if (!fragment) return null;
  const doc = root.ownerDocument;
  if (!fragment.startsWith('^')) return doc.getElementById(HEADING_ID_PREFIX + fragment);
  const wanted = (HEADING_ID_PREFIX + fragment).toLowerCase();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[id^="user-content-^"]'))) {
    if (el.id.toLowerCase() === wanted) return el;
  }
  return null;
}

/**
 * Reading-view renderer: unified/remark/rehype pipeline for everything
 * except ```mermaid fences (rendered as real <MermaidBlock> islands), GFM
 * alerts, sanitized raw HTML, and relative link/image resolution. Used both
 * for the page reading route and by the editor's "reading" mode.
 */
interface EmbedHost {
  el: HTMLElement;
  pageId: string;
  fragment: string | null;
  label: string;
}

export function Markdown({ markdown, space, pagePath, pageId, shareLinksPageId, shareToken, publicSite, canCreate, onCreatePage, embedded }: MarkdownProps) {
  const navigate = useNavigate();
  const location = useLocation();
  // What belongs to the page being SHOWN: its saved collapse/table state and its backlinks. A note drawn inside another page has neither.
  const isEmbedded = embedded !== undefined;
  const ownPageId = isEmbedded ? undefined : pageId;
  const { t, i18n } = useTranslation('markdown');
  const containerRef = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string; zoom: number } | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [collapsedSlugs, setCollapsedSlugs] = useState<Set<string>>(() => (ownPageId ? readCollapsedSlugs(ownPageId) : new Set()));
  // Per-table override: indices (tables.ts's TableIndexCursor) for which the
  // reader explicitly chose scroll/natural width over the default fit — see
  // tableFit.ts's own doc comment for the two-pass measure/apply split this
  // feeds into below.
  const [tableScrollOverrides, setTableScrollOverrides] = useState<Set<number>>(() =>
    ownPageId ? readTableScrollOverrides(ownPageId) : new Set(),
  );
  // Round 15: bumped once this space's @mentionable list lands, purely to
  // invalidate the `rendered` memo below — mentionName() itself always reads
  // straight from mentionIndex.ts's module cache, this is not the data.
  const [mentionsVersion, setMentionsVersion] = useState(0);
  // Round 22.09.2026: same idea, for a pasted Folio page URL's title/icon
  // (folioLinkIndex.ts) — the rehype plugin that renders it can only ever
  // kick off the resolve, not await it (it runs inside this component's own
  // synchronous `rendered` memo below), so this is what makes the SECOND
  // pass — the one that actually shows the resolved title — happen at all.
  const [linksVersion, setLinksVersion] = useState(0);
  // Obsidian wikilinks: resolved through the page's metadata (wikilinks.ts); `wikilinkRetry` re-asks once or twice for a link the index had no row for yet.
  const [wikilinkRetry, setWikilinkRetry] = useState(0);
  // An image or file link can be resolved by name too (`![](x.png)` -> `Attachments/x.png`), so a page with one asks as well.
  const hasWikilinks = useMemo(() => markdown.includes('[[') || markdown.includes('!['), [markdown]);
  const wikilinks = useWikilinkContext(shareToken ? shareLinksPageId : pageId, publicSite?.space, shareToken, hasWikilinks, wikilinkRetry);
  const [embedHosts, setEmbedHosts] = useState<EmbedHost[]>([]);
  // A click on a link to a page that does not exist: what it would create.
  const [offer, setOffer] = useState<{ name: string; target: WikilinkCreateTarget | null } | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  useEffect(() => {
    if (!lightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null);
      if (event.key === '+' || event.key === '=') {
        setLightbox((current) => current && { ...current, zoom: Math.min(4, current.zoom + 0.25) });
      }
      if (event.key === '-') {
        setLightbox((current) => current && { ...current, zoom: Math.max(0.5, current.zoom - 0.25) });
      }
      if (event.key === '0') setLightbox((current) => current && { ...current, zoom: 1 });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightbox]);

  // Round 15: fetch (or reuse the already-cached) mentionable list for this
  // space so @handles can be highlighted below. Skipped for an anonymous
  // share guest — GET /api/spaces/:space/mentionable needs a real session
  // (viewer+) and would just 401, same reasoning as the resolve() skip in
  // handleClick further down: shareToken's presence IS "no session here".
  useEffect(() => {
    if (shareToken || publicSite) return;
    void ensureMentionIndex(space);
    return onMentionsLoaded((loadedSpace) => {
      if (loadedSpace === space) setMentionsVersion((v) => v + 1);
    });
  }, [space, shareToken, publicSite]);

  // Round 22.09.2026: any Folio-page-URL resolution this render's rehype
  // pass kicked off (folioLinkIndex.ts) can land for ANY space/page, not
  // just this one — so, unlike mentions above, this simply bumps on every
  // settle rather than filtering by space; the memo below is cheap to
  // re-run and the alternative (threading which refs THIS render is
  // waiting on back out of a rehype plugin) is not worth it for a handful
  // of links per page.
  useEffect(() => onFolioLinkSettled(() => setLinksVersion((v) => v + 1)), []);

  // Collapse state is scoped to a page id — re-read (rather than carry
  // over) whenever it changes, same reasoning as useLocalStorage's own
  // re-read-on-key-change in app/hooks.ts.
  useEffect(() => {
    setCollapsedSlugs(ownPageId ? readCollapsedSlugs(ownPageId) : new Set());
  }, [ownPageId]);

  // Same re-read-on-key-change reasoning as collapsedSlugs above.
  useEffect(() => {
    setTableScrollOverrides(ownPageId ? readTableScrollOverrides(ownPageId) : new Set());
  }, [ownPageId]);

  // Round 13: ::pagetree{depth=N} directives are pulled out the same way
  // ```mermaid fences already are (splitPagetreeDirectives runs on
  // splitMermaidFences's own output) — both need a real React island instead
  // of the string-based rehype pipeline.
  // An `.mdx` page is rewritten into plain Markdown first (mdx.ts): ESM lines out, JSX components as labelled boxes.
  const isMdx = isMdxPagePath(pagePath);
  const segments = useMemo(
    () => splitFormDirectives(splitPagetreeDirectives(splitMermaidFences(isMdx ? mdxToMarkdown(stripFrontmatter(markdown)) : markdown))),
    [markdown, isMdx],
  );
  const headings = useMemo(() => extractHeadings(markdown), [markdown]);
  const rendered = useMemo(() => {
    // A note embedded in another page keeps its heading ids to itself: the host's outline and `#heading` links look ids up by slug.
    const cursor = createHeadingIdCursor(
      isEmbedded && pageId ? headings.map((heading) => ({ ...heading, slug: `embed-${pageId}-${heading.slug}` })) : headings,
    );
    // Same reasoning as `cursor` above, for the fit/scroll toggle's
    // per-table index instead of heading ids — see tables.ts's
    // TableIndexCursor doc comment.
    const tableCursor = createTableIndexCursor();
    // Same reasoning again, for the notes panel's data-note-index (noteIds.ts) —
    // a bare counter, so it needs no precomputed list the way `cursor` above does.
    const noteCursor = createNoteIdCursor();
    // Undefined until this space's list has loaded at least once (initial
    // render, or a space with no mentionable users at all) — rehypeMentions
    // treats that as "leave every @handle as plain text", the same thing an
    // unknown handle already gets.
    const mentionLookup = (handle: string) => mentionName(space, handle);
    // window.location.origin — undefined only outside a browser (SSR/most
    // tests), where rehypeFolioPageLinks then only ever matches a
    // root-relative `/s/...` href, never an absolute one (see its own doc
    // comment / parseFolioLink).
    const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
    return segments.map((segment) => {
      if (segment.type === 'mermaid' || segment.type === 'base' || segment.type === 'pagetree' || segment.type === 'form-embed') return segment;
      const html = renderMarkdownToHtml(
        segment.value,
        {
          space,
          pagePath,
          shareToken,
          mentionLookup,
          origin,
          publicSite,
          wikilinks,
          pageUrl: publicSite?.pageUrl,
          embedsEnabled: !shareToken,
          tagsClickable: !shareToken && !publicSite,
          embedded: isEmbedded,
        },
        cursor,
        tableCursor,
        noteCursor,
      );
      return {
        type: 'html' as const,
        html,
        // Built ONCE here rather than inline in the JSX below as
        // `dangerouslySetInnerHTML={{ __html: segment.html }}`, on purpose:
        // react-dom's DOM diff for this prop compares the `{ __html }`
        // wrapper OBJECT by reference (`nextProp !== lastProp`), not the
        // `__html` string inside it by content (checked directly against
        // node_modules/react-dom's update path — the generic per-tag
        // property loop, not a dangerouslySetInnerHTML-specific one). An
        // object literal written inline in JSX is a brand-new object on
        // every evaluation, so React would call `.innerHTML = ...` again on
        // EVERY re-render of <Markdown>, for ANY reason — a table toggle
        // click, a collapse toggle, the mentionable list's fetch finishing —
        // even when the html string is byte-identical, wiping every DOM
        // mutation collapsible.ts/tableFit.ts made after mount. For the
        // table toggle specifically that would also destroy and recreate
        // the very button the reader just clicked/activated, dropping
        // keyboard focus off it entirely. Building this object once here,
        // as part of the SAME memo that produces `html`, keeps its
        // reference stable across any re-render that leaves `rendered`
        // itself untouched — which is what lets React correctly bail.
        innerHtmlProp: { __html: html },
      };
    });
    // mentionsVersion isn't read above (mentionLookup reads mentionIndex.ts's
    // own module cache directly) — it's only in this list to force a re-run
    // once the space's list finishes loading after an already-rendered pass.
    //
    // i18n.language isn't read above either, same reasoning: renderMarkdownToHtml
    // resolves a couple of strings straight from the i18next singleton at call
    // time (alerts.ts's alert labels, round 22; directiveFallback.ts's
    // ::pagetree fallback text) rather than through this component's own `t`,
    // since that pipeline runs as a plain unified transform, not a component —
    // see alerts.ts's own doc comment. Without this dependency, switching the
    // UI language while a page with either is already on screen wouldn't
    // re-run this memo at all (nothing else in the array would have changed),
    // leaving those specific strings stuck in the PREVIOUS language until the
    // next unrelated re-render of this same content.
    //
    // linksVersion, same reasoning as mentionsVersion above: rehypeFolioPageLinks
    // reads folioLinkIndex.ts's own module cache directly (resolvedFolioLink),
    // this is only here to force the SECOND pass that shows a title once it lands.
    //
    // wikilinks, same reasoning: the page's link answers arrive after the first render.
  }, [segments, headings, space, pagePath, shareToken, publicSite, mentionsVersion, linksVersion, wikilinks, isEmbedded, pageId, i18n.language]);

  // The collapsible wrapper/body/stub structure is baked into `rendered`'s
  // HTML by the pipeline's rehypeCollapsibleSections — this only ever
  // toggles one class on elements living inside a dangerouslySetInnerHTML
  // region, safe from React's own reconciliation (see collapsible.ts).
  useEffect(() => {
    if (containerRef.current) applyCollapseState(containerRef.current, collapsedSlugs);
  }, [collapsedSlugs, rendered]);

  // Hover cards for glossary terms. Re-attached whenever `rendered` produces
  // fresh DOM — the handlers are delegated on the container, so this is one
  // listener pair per render, not one per term.
  useEffect(() => {
    if (!containerRef.current) return;
    return attachGlossaryTooltips(containerRef.current);
  }, [rendered]);

  // Embedded notes (`![[Note]]`): rehypeOfmLinks leaves a placeholder per resolvable embed; each gets an <EmbedView> portal. Hosts that belong to a note embedded further down are theirs (that <Markdown> collects them), hence the closest() check.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const hosts: EmbedHost[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-folio-embed]'))) {
      if (el.closest('.folio-markdown') !== root) continue;
      hosts.push({
        el,
        pageId: el.dataset.folioEmbed ?? '',
        fragment: el.dataset.embedFragment ?? null,
        label: el.dataset.embedLabel ?? '',
      });
      el.textContent = ''; // the label was only for the moment before the note arrives
    }
    setEmbedHosts(hosts);
  }, [rendered]);

  // Formulas (`$x$`): KaTeX, loaded the first time a page has one (math.ts).
  useEffect(() => {
    if (containerRef.current) void renderMath(containerRef.current);
  }, [rendered]);

  // A wikilink the index has no row for yet (the page was edited a moment ago): ask again, a couple of times.
  useEffect(() => {
    if (wikilinks.status !== 'ready' || wikilinkRetry >= WIKILINK_RETRIES) return;
    const root = containerRef.current;
    if (!root || !root.querySelector('.folio-wikilink--static:not([data-wikilink=""]), .folio-embed--static[data-wikilink]')) return;
    const timer = setTimeout(() => setWikilinkRetry((n) => n + 1), WIKILINK_RETRY_MS);
    return () => clearTimeout(timer);
  }, [rendered, wikilinks, wikilinkRetry]);

  // `/s/<space>/p/<id>#heading` (a `[[Note#Heading]]` from another page, a copied link): scroll to the heading or block once it is drawn.
  const scrolledFor = useRef('');
  useEffect(() => {
    const root = containerRef.current;
    if (isEmbedded || !root || !location.hash) return;
    const key = `${pageId ?? ''}${location.hash}`;
    if (scrolledFor.current === key) return;
    const target = findAnchor(root, location.hash);
    if (!target) return;
    scrolledFor.current = key;
    target.scrollIntoView?.({ block: 'start' });
  }, [rendered, location.hash, pageId, isEmbedded]);

  // Fit/scroll toggle (tableFit.ts): measure THEN apply, always together, in
  // ONE effect, even though `rendered`'s own `innerHtmlProp` fix (see that
  // memo's comment above) means a click no longer forces react-dom to reset
  // this region's innerHTML behind our backs. Splitting these into two
  // effects with different dependency arrays (measure only when `rendered`
  // produced fresh DOM, apply on every override change) is the more
  // "obviously correct" design and was the first one tried — but it depends
  // on that innerHTML-stability invariant holding, which took a real
  // debugging session to even discover was at risk (react-dom compares
  // dangerouslySetInnerHTML's `{ __html }` wrapper by reference, not by the
  // string inside it — an easy thing for a future edit to this file to
  // silently reintroduce, e.g. by building that object inline again). If it
  // ever does regress, a measure-only-on-`rendered`-change effect would
  // simply never re-run to notice the DOM got reset, and the toggle would
  // silently stop doing anything — a much worse failure mode than the
  // redundant-but-harmless extra measurement a combined effect performs on
  // every click. Measuring fresh on every run this effect makes costs
  // nothing a human would notice (a handful of scrollWidth reads on a click)
  // and is always correct regardless: whatever reset would have invalidated
  // a cached measurement also reverts the table to auto layout, so there is
  // never a "measuring while already fixed" case to guard against.
  useEffect(() => {
    if (!containerRef.current) return;
    measureWideTables(containerRef.current);
    applyTableFitState(containerRef.current, tableScrollOverrides, {
      switchToScroll: t('table.switchToScroll'),
      switchToFit: t('table.switchToFit'),
    });
    // i18n.language is listed for the same reason `rendered`'s own memo
    // lists it (see that comment): the button's aria-label is resolved via
    // `t()` at the time this effect runs, not through a binding React would
    // otherwise re-render on its own.
  }, [rendered, tableScrollOverrides, i18n.language]);

  function showHint(message: string) {
    clearTimeout(hintTimer.current);
    setHint(message);
    hintTimer.current = setTimeout(() => setHint(null), 2600);
  }

  function toggleCollapse(slug: string) {
    setCollapsedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      if (ownPageId) writeCollapsedSlugs(ownPageId, next);
      return next;
    });
  }

  function toggleTableFit(index: number) {
    setTableScrollOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      if (ownPageId) writeTableScrollOverrides(ownPageId, next);
      return next;
    });
  }

  async function createFromOffer() {
    if (!offer?.target || !onCreatePage) return;
    setCreating(true);
    try {
      const created = await onCreatePage({ parentPath: offer.target.parentPath, title: offer.target.stem, fileStem: offer.target.stem });
      setOffer(null);
      navigate(`/s/${created.space}/p/${created.id}`);
    } catch {
      setOffer(null);
      showHint(t('wikilink.createFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // A click inside a note embedded further down belongs to that <Markdown> (React bubbles it to us through the portal too).
    if (target.closest('.folio-markdown') !== event.currentTarget) return;

    const toggle = target.closest<HTMLButtonElement>('[data-collapse-toggle]');
    if (toggle) {
      event.preventDefault();
      toggleCollapse(toggle.dataset.collapseToggle ?? '');
      return;
    }

    const tableToggle = target.closest<HTMLButtonElement>('[data-table-toggle]');
    if (tableToggle) {
      event.preventDefault();
      toggleTableFit(Number(tableToggle.dataset.tableToggle));
      return;
    }

    const image = target.closest<HTMLImageElement>('.folio-md-segment img');
    if (image) {
      event.preventDefault();
      setLightbox({ src: image.currentSrc || image.src, alt: image.alt, zoom: 1 });
      return;
    }

    // Round 22.09.2026: a pasted Folio page URL, already resolved to a
    // title by rehypeFolioLinks.ts — the app route is baked into the
    // attribute itself (folioLinkNavPath), so unlike data-folio-link below
    // this needs no /api/resolve round-trip at click time at all.
    // Obsidian constructs (shared/ofm): a `#tag` chip opens the search, `[[#Heading]]` scrolls here, a link to a page that
    // does not exist offers to create it, one whose answer has not come yet does nothing.
    const tagChip = target.closest<HTMLElement>('a[data-folio-tag]');
    if (tagChip) {
      event.preventDefault();
      requestSearch(`tag:${tagChip.dataset.folioTag ?? ''}`);
      return;
    }
    const selfLink = target.closest<HTMLElement>('a[data-wikilink-self]');
    if (selfLink) {
      event.preventDefault();
      const el = containerRef.current ? findAnchor(containerRef.current, selfLink.dataset.wikilinkSelf ?? '') : null;
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      return;
    }
    const wikilink = target.closest<HTMLElement>('a[data-wikilink-state="pending"], a[data-wikilink-state="unresolved"], div.folio-embed--unresolved');
    if (wikilink) {
      event.preventDefault();
      if (wikilink.dataset.wikilinkState === 'unresolved') {
        const name = wikilink.dataset.wikilink ?? '';
        setOffer({ name, target: canCreate && onCreatePage ? wikilinkCreateTarget(pagePath, name) : null });
      }
      return;
    }

    const navAnchor = target.closest<HTMLAnchorElement>('a[data-folio-nav]');
    if (navAnchor) {
      event.preventDefault();
      navigate(navAnchor.getAttribute('data-folio-nav') ?? '/');
      return;
    }

    const anchor = target.closest<HTMLAnchorElement>('a[data-folio-link]');
    if (!anchor) return;
    // An extensionless link (`../getting-started`, `../LICENSE`) may name a page
    // or a plain file: the page wins when one resolves, otherwise the raw-file
    // link the anchor carries (relativeLinks.ts) opens exactly as it always did.
    const fileFallback = anchor.hasAttribute('data-folio-file');
    // A share guest cannot resolve pages at all: the file link, as before.
    if (shareToken && fileFallback) return;
    event.preventDefault();
    const relPath = anchor.getAttribute('data-folio-link') ?? '';
    const notFound = () => {
      if (fileFallback) window.open(anchor.href, '_blank', 'noopener,noreferrer');
      else showHint(t('link.notFound', { path: relPath }));
    };

    // Public site: a relative page link resolves through the anonymous route
    // (the session-only /api/resolve below would 401) and lands on the site's URL
    // for that page, in path or host mode alike.
    if (publicSite) {
      try {
        navigate(publicSite.pageUrl(await publicSite.resolvePath(relPath)));
      } catch {
        notFound();
      }
      return;
    }

    // Round 8: a share link grants access to exactly the ONE page it was
    // created for — /api/resolve requires a real session (server-side
    // session.requireSpaceRole) and would just 401 for an anonymous guest.
    // Never make that call from the public route; shareToken's presence IS
    // "we're rendering on /share/:token" (SharedPageView always passes it).
    if (shareToken) {
      showHint(t('link.shareUnavailable'));
      return;
    }

    try {
      const res = await fetch(`/api/resolve?space=${encodeURIComponent(space)}&path=${encodeURIComponent(relPath)}`);
      if (!res.ok) throw new Error('unresolved');
      const meta = (await res.json()) as PageMeta;
      navigate(`/s/${meta.space}/p/${meta.id}`);
    } catch {
      notFound();
    }
  }

  return (
    <div className="folio-markdown" ref={containerRef} onClick={handleClick}>
      {rendered.map((segment, index) =>
        segment.type === 'mermaid' ? (
          <div className="folio-mermaid-segment" key={index}>
            <MermaidBlock code={segment.code} />
          </div>
        ) : segment.type === 'base' ? (
          <div className="folio-base-segment" key={index}>
            {/* A base lists pages and their properties for a signed-in reader; a share guest or a public visitor gets a note. */}
            {shareToken || publicSite ? (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('base.unavailable')}</p>
            ) : (
              <Suspense fallback={null}>
                <BaseEmbed source={segment.code} space={space} pageId={pageId} />
              </Suspense>
            )}
          </div>
        ) : segment.type === 'pagetree' ? (
          <div className="folio-pagetree-segment" key={index}>
            {/* No pageId: same contexts that hide backlinks (a history-version
                preview, a synthetic folder listing, or the public share route
                — see this prop's own doc comment) have no "whose subtree"
                to fetch either. Shows the same empty-state copy rather than
                attempting a fetch against a blank id. */}
            {pageId && !publicSite ? <PageTree pageId={pageId} depth={segment.depth} /> : (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('pagetree.empty')}</p>
            )}
          </div>
        ) : segment.type === 'form-embed' ? (
          <div className="folio-form-embed-segment" key={index}>
            {/* A form is filled in inside Folio; an anonymous reader of a public site gets a neutral note. */}
            {publicSite ? (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('form.publicUnavailable')}</p>
            ) : (
              <FormEmbed pageId={segment.pageId} />
            )}
          </div>
        ) : segment.html.trim() === '' ? null : (
          <div className="folio-md-segment" key={index} dangerouslySetInnerHTML={segment.innerHtmlProp} />
        ),
      )}
      {ownPageId && !publicSite && <Backlinks pageId={ownPageId} />}
      {embedHosts.map((host, hostIndex) =>
        createPortal(
          <EmbedView
            pageId={host.pageId}
            fragment={host.fragment}
            label={host.label}
            depth={(embedded?.depth ?? 0) + 1}
            chain={embedded ? embedded.chain : pageId ? [pageId] : []}
            publicSite={publicSite}
          />,
          host.el,
          `${hostIndex}|${host.pageId}|${host.fragment ?? ''}`,
        ),
      )}
      {offer && (
        <div className="folio-offer" role="status">
          <span>{t('wikilink.notFound', { name: offer.name })}</span>
          {offer.target && (
            <button type="button" disabled={creating} onClick={() => void createFromOffer()}>
              {creating ? t('wikilink.creating') : t('wikilink.create', { name: offer.target.stem })}
            </button>
          )}
          <button type="button" className="folio-offer__close" aria-label={t('image.close')} onClick={() => setOffer(null)}>
            ×
          </button>
        </div>
      )}
      {hint && (
        <div className="folio-hint" role="status">
          {hint}
        </div>
      )}
      {lightbox && (
        <div
          className="folio-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t('image.viewer')}
          onClick={(event) => {
            if (event.target === event.currentTarget) setLightbox(null);
          }}
        >
          <div className="folio-lightbox__toolbar">
            <button
              type="button"
              aria-label={t('image.zoomOut')}
              title={t('image.zoomOut')}
              onClick={() => setLightbox((current) => current && { ...current, zoom: Math.max(0.5, current.zoom - 0.25) })}
            >−</button>
            <button
              type="button"
              className="folio-lightbox__zoom"
              aria-label={t('image.resetZoom')}
              title={t('image.resetZoom')}
              onClick={() => setLightbox((current) => current && { ...current, zoom: 1 })}
            >{Math.round(lightbox.zoom * 100)}%</button>
            <button
              type="button"
              aria-label={t('image.zoomIn')}
              title={t('image.zoomIn')}
              onClick={() => setLightbox((current) => current && { ...current, zoom: Math.min(4, current.zoom + 0.25) })}
            >+</button>
            <button
              type="button"
              className="folio-lightbox__close"
              aria-label={t('image.close')}
              title={t('image.close')}
              onClick={() => setLightbox(null)}
            >×</button>
          </div>
          <div className="folio-lightbox__viewport">
            <img
              src={lightbox.src}
              alt={lightbox.alt}
              draggable="false"
              style={{ width: `calc((100vw - 64px) * ${lightbox.zoom})` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
