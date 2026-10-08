import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { PageMeta } from '@shared/contracts';
import { splitMermaidFences } from './mermaidSplit';
import { splitPagetreeDirectives } from './pagetreeSplit';
import { splitFormDirectives } from './formSplit';
import { renderMarkdownToHtml } from './pipeline';
import { extractHeadings } from './headings';
import { createHeadingIdCursor } from './headingIds';
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
}

/**
 * Reading-view renderer: unified/remark/rehype pipeline for everything
 * except ```mermaid fences (rendered as real <MermaidBlock> islands), GFM
 * alerts, sanitized raw HTML, and relative link/image resolution. Used both
 * for the page reading route and by the editor's "reading" mode.
 */
export function Markdown({ markdown, space, pagePath, pageId, shareToken }: MarkdownProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('markdown');
  const containerRef = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string; zoom: number } | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [collapsedSlugs, setCollapsedSlugs] = useState<Set<string>>(() => (pageId ? readCollapsedSlugs(pageId) : new Set()));
  // Per-table override: indices (tables.ts's TableIndexCursor) for which the
  // reader explicitly chose scroll/natural width over the default fit — see
  // tableFit.ts's own doc comment for the two-pass measure/apply split this
  // feeds into below.
  const [tableScrollOverrides, setTableScrollOverrides] = useState<Set<number>>(() =>
    pageId ? readTableScrollOverrides(pageId) : new Set(),
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
    if (shareToken) return;
    void ensureMentionIndex(space);
    return onMentionsLoaded((loadedSpace) => {
      if (loadedSpace === space) setMentionsVersion((v) => v + 1);
    });
  }, [space, shareToken]);

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
    setCollapsedSlugs(pageId ? readCollapsedSlugs(pageId) : new Set());
  }, [pageId]);

  // Same re-read-on-key-change reasoning as collapsedSlugs above.
  useEffect(() => {
    setTableScrollOverrides(pageId ? readTableScrollOverrides(pageId) : new Set());
  }, [pageId]);

  // Round 13: ::pagetree{depth=N} directives are pulled out the same way
  // ```mermaid fences already are (splitPagetreeDirectives runs on
  // splitMermaidFences's own output) — both need a real React island instead
  // of the string-based rehype pipeline.
  const segments = useMemo(
    () => splitFormDirectives(splitPagetreeDirectives(splitMermaidFences(markdown))),
    [markdown],
  );
  const headings = useMemo(() => extractHeadings(markdown), [markdown]);
  const rendered = useMemo(() => {
    const cursor = createHeadingIdCursor(headings);
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
      if (segment.type === 'mermaid' || segment.type === 'pagetree' || segment.type === 'form-embed') return segment;
      const html = renderMarkdownToHtml(
        segment.value,
        { space, pagePath, shareToken, mentionLookup, origin },
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
  }, [segments, headings, space, pagePath, shareToken, mentionsVersion, linksVersion, i18n.language]);

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
      if (pageId) writeCollapsedSlugs(pageId, next);
      return next;
    });
  }

  function toggleTableFit(index: number) {
    setTableScrollOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      if (pageId) writeTableScrollOverrides(pageId, next);
      return next;
    });
  }

  async function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;

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
    const navAnchor = target.closest<HTMLAnchorElement>('a[data-folio-nav]');
    if (navAnchor) {
      event.preventDefault();
      navigate(navAnchor.getAttribute('data-folio-nav') ?? '/');
      return;
    }

    const anchor = target.closest<HTMLAnchorElement>('a[data-folio-link]');
    if (!anchor) return;
    event.preventDefault();
    const relPath = anchor.getAttribute('data-folio-link') ?? '';

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
      showHint(t('link.notFound', { path: relPath }));
    }
  }

  return (
    <div className="folio-markdown" ref={containerRef} onClick={handleClick}>
      {rendered.map((segment, index) =>
        segment.type === 'mermaid' ? (
          <div className="folio-mermaid-segment" key={index}>
            <MermaidBlock code={segment.code} />
          </div>
        ) : segment.type === 'pagetree' ? (
          <div className="folio-pagetree-segment" key={index}>
            {/* No pageId: same contexts that hide backlinks (a history-version
                preview, a synthetic folder listing, or the public share route
                — see this prop's own doc comment) have no "whose subtree"
                to fetch either. Shows the same empty-state copy rather than
                attempting a fetch against a blank id. */}
            {pageId ? <PageTree pageId={pageId} depth={segment.depth} /> : (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('pagetree.empty')}</p>
            )}
          </div>
        ) : segment.type === 'form-embed' ? (
          <div className="folio-form-embed-segment" key={index}>
            <FormEmbed pageId={segment.pageId} />
          </div>
        ) : segment.html.trim() === '' ? null : (
          <div className="folio-md-segment" key={index} dangerouslySetInnerHTML={segment.innerHtmlProp} />
        ),
      )}
      {pageId && <Backlinks pageId={pageId} />}
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
