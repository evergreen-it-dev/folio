import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import mermaid from 'mermaid';
import { Check, Copy } from 'lucide-react';
import { ensureMermaidInitialized, onMermaidThemeChange } from './mermaidSetup';
import { sanitizeMermaidId } from './mermaidId';
import { isStaleChunkError, tryReloadForStaleChunk } from '../app/stale-chunk';
import './i18n/register';

export interface MermaidBlockProps {
  code: string;
  /** Called whenever this diagram fails to parse/render (e.g. to surface it elsewhere in the UI). */
  onError?: (message: string) => void;
}

type Status = 'loading' | 'ready' | 'error';

/**
 * Client-side mermaid@11 rendering. Renders into a plain (React-unmanaged)
 * container via mermaid.render()'s returned SVG string — React only ever
 * controls this component's own state/classNames, never that container's
 * children, so mixing imperative innerHTML writes with React is safe.
 */
export function MermaidBlock({ code, onError }: MermaidBlockProps) {
  const { t } = useTranslation('diagrams');
  const rawId = useId();
  const baseId = useMemo(() => sanitizeMermaidId(rawId), [rawId]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderCount = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [themeTick, setThemeTick] = useState(0);
  const [copied, setCopied] = useState(false);

  // Re-render every mounted block whenever the OS/browser color scheme flips.
  useEffect(() => onMermaidThemeChange(() => setThemeTick((t) => t + 1)), []);

  useEffect(() => {
    let cancelled = false;
    ensureMermaidInitialized();
    setStatus('loading');
    // Fresh id per attempt: mermaid briefly mounts a hidden measurement node
    // under this id, and per-attempt uniqueness avoids any collision if a
    // previous (now-cancelled) render for this instance is still in flight.
    const renderId = `${baseId}-${++renderCount.current}`;

    (async () => {
      try {
        const { svg, bindFunctions } = await mermaid.render(renderId, code);
        if (cancelled) return;
        const el = containerRef.current;
        if (!el) return;
        el.innerHTML = svg;
        bindFunctions?.(el);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        // A lazily-loaded mermaid diagram-type chunk gone stale after a
        // deploy throws here, not at import() call sites elsewhere — see
        // app/stale-chunk.ts. tryReloadForStaleChunk reloads the page (once
        // per tab) when that's what happened; if it returns true we're
        // navigating away, so there's nothing left to render.
        if (tryReloadForStaleChunk(err)) return;
        const message = isStaleChunkError(err) ? t('mermaid.staleVersion') : err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setStatus('error');
        onErrorRef.current?.(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, baseId, themeTick]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable/denied — non-critical, ignore silently.
    }
  }

  if (status === 'error') {
    return (
      <div className="my-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        <div className="mb-1.5 font-medium">{t('mermaid.errorTitle')}</div>
        {/* The raw parse-error message itself is mermaid's own (English,
            technical) output, not our UI copy — left untranslated on
            purpose, same as any other library/server error text. */}
        <p className="mb-2 break-words font-mono text-xs opacity-90">{errorMessage}</p>
        <pre className="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="group relative my-4 min-h-[2.5rem]">
      {status === 'loading' && <div className="p-4 text-center text-xs opacity-50">{t('mermaid.rendering')}</div>}
      <div
        ref={containerRef}
        hidden={status !== 'ready'}
        className="flex justify-center overflow-x-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full"
      />
      {status === 'ready' && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? t('mermaid.copied') : t('mermaid.copySource')}
          title={copied ? t('mermaid.copied') : t('mermaid.copySource')}
          className="absolute right-2 top-2 flex items-center gap-1 rounded border border-neutral-300 bg-white/90 px-1.5 py-1 text-xs opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 dark:border-neutral-700 dark:bg-neutral-900/90"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}
