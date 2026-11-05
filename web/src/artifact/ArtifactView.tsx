/**
 * A page of kind 'artifact': an HTML page made by an agent (a Claude artifact, a Cursor canvas, any self-contained
 * page) shown in a sandboxed iframe, read-only. Folio never edits the bundle — editors replace it whole.
 *
 * The frame has NO allow-same-origin (shared ARTIFACT_IFRAME_SANDBOX): its origin is opaque, so it sees neither
 * Folio's cookies nor its API; its window.storage goes through the postMessage bridge (useArtifactBridge). An
 * `embed` artifact is somebody else's page on somebody else's origin (Claude's embed code), shown as the author
 * published it.
 *
 * Mounted by the page route, the share link and the public site alike; what only the session offers
 * (download, replace) arrives as props.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AppWindow, ChevronDown, ChevronRight, Code, Download, ExternalLink, Maximize2, Minimize2, RefreshCw, TriangleAlert } from 'lucide-react';
import { ARTIFACT_IFRAME_SANDBOX, type ArtifactCapability, type ArtifactPayload } from '@shared/contracts';
import { ArtifactSourceDialog } from './ArtifactSourceDialog';
import { useArtifactBridge } from './useArtifactBridge';
import './i18n/register';

export interface ArtifactViewProps {
  payload: ArtifactPayload;
  pageId: string;
  title: string;
  /** Changes when the bundle was replaced (the page's updatedAt): only then does the frame reload with a freshly minted `src`. */
  version?: string;
  /** False on the public site and share links: the state is then kept in this browser, whatever the payload says. Default true. */
  allowServerState?: boolean;
  /** GET /api/pages/:id/artifact/download — session only; absent = no Download button. */
  downloadUrl?: string;
  /** Editors: opens the import dialog in replace mode; absent = no Replace button. */
  onReplace?: () => void;
  /** An element outside the view (the share page's header) that takes the action buttons instead of the view's own toolbar row. */
  toolbarHost?: HTMLElement | null;
}

/** Only http(s) links are ever put in an href: the source URL comes from a manifest anybody could have written. */
function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const DEFAULT_EMBED_HEIGHT = 640;

export function ArtifactView({ payload, pageId, title, version, allowServerState = true, downloadUrl, onReplace, toolbarHost }: ArtifactViewProps) {
  const { t } = useTranslation('artifact');
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const isEmbed = payload.type === 'embed';
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);

  // The url of a minted token changes on every fetch of the page (a refocus refetches it); reloading the frame on
  // each would wipe what the reader is doing in it. So `src` is taken once per page and bundle version.
  const frameKey = `${pageId}:${version ?? ''}`;
  const [frame, setFrame] = useState({ key: frameKey, src: payload.src });
  if (frame.key !== frameKey) setFrame({ key: frameKey, src: payload.src });
  const src = frame.key === frameKey ? frame.src : payload.src;

  useArtifactBridge(frameRef, pageId, payload.stateServer && allowServerState, !isEmbed);

  useEffect(() => {
    function onChange() {
      setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === rootRef.current);
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  function toggleFullscreen() {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (root.requestFullscreen) void root.requestFullscreen().catch(() => setFullscreen((v) => !v));
    else setFullscreen((v) => !v); // iOS Safari has no element fullscreen: fill the window instead
  }

  const frameUrl = isEmbed ? payload.embedUrl : src;
  const unsupported: ArtifactCapability[] = payload.capabilities.filter((c) => c !== 'storage');
  const sourceUrl = safeHttpUrl(payload.source?.url);
  const origin = payload.source?.origin;
  // Pasted HTML (no origin, or 'other' without a link) has nothing to say about where it came from: no badge.
  const sourceLabel = origin && (origin !== 'other' || sourceUrl) ? t(`source.${origin}`) : sourceUrl ? t('source.other') : null;

  const toolbarButton = 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60';
  const badge = (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-neutral-200/70 px-2 py-1 font-medium text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-200">
      <AppWindow size={13} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{sourceLabel}</span>
      {sourceUrl && <ExternalLink size={11} className="shrink-0 opacity-60" aria-hidden="true" />}
    </span>
  );

  // In the header there is less room: the text shows from lg up, and the title keeps icon-only buttons explained.
  const portaled = !!toolbarHost && !fullscreen;
  const label = (text: string) => (
    <>
      <span className={portaled ? 'hidden lg:inline' : 'hidden sm:inline'}>{text}</span>
      <span className={portaled ? 'sr-only lg:hidden' : 'sr-only sm:hidden'}>{text}</span>
    </>
  );
  const actions = (
    <div className={`${portaled ? 'text-xs text-neutral-600 dark:text-neutral-300 ' : 'ml-auto '}flex flex-wrap items-center gap-0.5`}>
      {onReplace && (
        <button type="button" onClick={onReplace} className={toolbarButton} title={portaled ? t('toolbar.replace') : undefined}>
          <RefreshCw size={14} aria-hidden="true" />
          {label(t('toolbar.replace'))}
        </button>
      )}
      {payload.sourceSrc && (
        <button type="button" onClick={() => setShowSource(true)} className={toolbarButton} title={portaled ? t('toolbar.showSource') : undefined}>
          <Code size={14} aria-hidden="true" />
          {label(t('toolbar.showSource'))}
        </button>
      )}
      {downloadUrl && !isEmbed && (
        <a href={downloadUrl} download className={toolbarButton} title={portaled ? t('toolbar.download') : undefined}>
          <Download size={14} aria-hidden="true" />
          {label(t('toolbar.download'))}
        </a>
      )}
      {frameUrl && (
        <a href={frameUrl} target="_blank" rel="noopener noreferrer" className={toolbarButton} title={portaled ? t('toolbar.openInTab') : undefined}>
          <ExternalLink size={14} aria-hidden="true" />
          {label(t('toolbar.openInTab'))}
        </a>
      )}
      {frameUrl && (
        <button type="button" onClick={toggleFullscreen} aria-pressed={fullscreen} className={toolbarButton} title={portaled ? t('toolbar.fullscreen') : undefined}>
          {fullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          {label(fullscreen ? t('toolbar.exitFullscreen') : t('toolbar.fullscreen'))}
        </button>
      )}
    </div>
  );

  let body: ReactNode;
  if (!frameUrl) {
    body = (
      <div className="flex flex-1 items-start justify-center p-8">
        <div className="max-w-md text-center text-sm text-neutral-500 dark:text-neutral-400">
          <p className="font-medium text-neutral-700 dark:text-neutral-200">{t('empty')}</p>
          <p className="mt-1">{t('emptyHint')}</p>
        </div>
      </div>
    );
  } else if (isEmbed) {
    // Third-party origin, not ours: allow-same-origin is safe here (it only lets THEIR page keep its own storage).
    body = (
      <div className="min-h-0 flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-950">
        <iframe
          ref={frameRef}
          key={frameKey}
          src={frameUrl}
          title={t('frameTitle', { title })}
          sandbox={`${ARTIFACT_IFRAME_SANDBOX} allow-same-origin`}
          allow="fullscreen; clipboard-write"
          referrerPolicy="no-referrer"
          style={{ height: fullscreen ? '100%' : (payload.embedHeight ?? DEFAULT_EMBED_HEIGHT) }}
          className="block w-full border-0 bg-white"
        />
      </div>
    );
  } else {
    body = (
      <div className="relative min-h-0 flex-1 bg-neutral-100 dark:bg-neutral-950">
        <iframe
          ref={frameRef}
          key={frameKey}
          src={frameUrl}
          title={t('frameTitle', { title })}
          sandbox={ARTIFACT_IFRAME_SANDBOX}
          allow="fullscreen; clipboard-write"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`flex min-h-[480px] flex-col bg-white dark:bg-neutral-900 ${fullscreen ? 'fixed inset-0 z-50 h-dvh' : 'h-full'}`}
    >
      {portaled && toolbarHost ? (
        createPortal(actions, toolbarHost)
      ) : (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          {sourceLabel &&
            (sourceUrl ? (
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer nofollow" title={t('source.openOriginal')} className="min-w-0 max-w-[16rem]">
                {badge}
              </a>
            ) : (
              badge
            ))}
          {actions}
        </div>
      )}

      {unsupported.length > 0 && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {t('partial', { what: unsupported.map((c) => t(`capability.${c}`)).join(', ') })}
        </div>
      )}

      {payload.warnings.length > 0 && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <button type="button" className="flex items-center gap-1.5 font-medium" onClick={() => setShowWarnings((v) => !v)} aria-expanded={showWarnings}>
            {showWarnings ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {t('warningsTitle', { count: payload.warnings.length })}
          </button>
          {showWarnings && (
            <ul className="mt-1 list-disc pl-6">
              {payload.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {body}

      {showSource && payload.sourceSrc && (
        <ArtifactSourceDialog
          url={payload.sourceSrc}
          name={payload.source?.file ?? title}
          onClose={() => setShowSource(false)}
        />
      )}
    </div>
  );
}
