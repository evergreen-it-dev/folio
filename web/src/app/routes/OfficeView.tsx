import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OfficeFormat } from '@shared/contracts';
import { api } from '../api';
import '../i18n/register';

export interface OfficeViewProps {
  pageId: string;
  title: string;
  /** docx/xlsx/pptx — derived by the caller from the page's path (shared/contracts.ts's officeFormat). */
  format: OfficeFormat;
}

type ViewState = 'loading' | 'ready' | 'error';

/** The subset of @silurus/ooxml's three viewer classes this component actually calls. */
interface DestroyableViewer {
  load(source: ArrayBuffer): Promise<void>;
  destroy(): void;
}

/**
 * Read-only docx/xlsx/pptx page view — @silurus/ooxml's client-side Rust/WASM
 * + Canvas 2D viewer, no server-side conversion, no LibreOffice, no iframe to
 * a third party (owner's pick). Mirrors PdfView's shell: no editor, no
 * live-edit toggle, no outline/notes panel — «open in a new tab» / «download»
 * live in the page header (Header.tsx, `fileActions` prop) exactly like a
 * pdf's.
 *
 * The library is lazy-loaded: `import('@silurus/ooxml/docx' | '/xlsx' |
 * '/pptx')` runs inside this effect, never at module scope, and only the ONE
 * format entry this page actually needs is fetched — it is Rust/WASM and
 * must never land in the main bundle (verify with the build output: each
 * entry becomes its own chunk).
 *
 * The container <div> is always mounted at full size (never toggled via
 * `hidden`/unmounted while loading) — the scroll viewers measure their
 * container's box to fit width, and a zero-size hidden element at `load()`
 * time would wreck that fit. Loading/error states are absolutely-positioned
 * overlays on top of it instead.
 */
export function OfficeView({ pageId, title, format }: OfficeViewProps) {
  const { t } = useTranslation('app');
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ViewState>('loading');

  useEffect(() => {
    let cancelled = false;
    let viewer: DestroyableViewer | undefined;
    setState('loading');

    (async () => {
      try {
        const res = await fetch(api.pageFileUrl(pageId), { credentials: 'include' });
        if (!res.ok) throw new Error(`GET ${api.pageFileUrl(pageId)} -> ${res.status}`);
        const bytes = await res.arrayBuffer();
        const container = containerRef.current;
        if (cancelled || !container) return;

        // One dynamic import per format — see the module doc above for why
        // this must stay inside the effect. Each branch awaits its own
        // `import()`, so only the format actually being viewed is fetched.
        if (format === 'docx') {
          const { DocxScrollViewer } = await import('@silurus/ooxml/docx');
          if (cancelled || !containerRef.current) return;
          viewer = new DocxScrollViewer(containerRef.current, { enableTextSelection: true, background: 'transparent' });
        } else if (format === 'xlsx') {
          const { XlsxViewer } = await import('@silurus/ooxml/xlsx');
          if (cancelled || !containerRef.current) return;
          viewer = new XlsxViewer(containerRef.current);
        } else {
          const { PptxScrollViewer } = await import('@silurus/ooxml/pptx');
          if (cancelled || !containerRef.current) return;
          viewer = new PptxScrollViewer(containerRef.current, { enableTextSelection: true, background: 'transparent' });
        }
        await viewer.load(bytes);
        if (!cancelled) setState('ready');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[office] failed to render page ${pageId}:`, err);
        if (!cancelled) setState('error');
      }
    })();

    return () => {
      cancelled = true;
      viewer?.destroy();
    };
    // `title` deliberately excluded — it never affects what gets rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, format]);

  return (
    <div className="relative h-full bg-neutral-100 dark:bg-neutral-950">
      {state === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-100 text-sm text-neutral-400 dark:bg-neutral-950">
          {t('routes.office.loading')}
        </div>
      )}
      {state === 'error' && (
        // A document this library can't render must never look like a broken
        // page (owner's rule) — a clear message plus the download link, same
        // "at least you can still get the file" fallback a pdf's file
        // actions already offer.
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-neutral-100 p-8 text-center text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
          <p>{t('routes.office.renderFailed')}</p>
          <a
            href={api.pageFileUrl(pageId, true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {t('routes.pdf.download')}
          </a>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" aria-label={title} />
    </div>
  );
}
