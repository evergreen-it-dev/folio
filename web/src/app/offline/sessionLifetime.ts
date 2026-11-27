import { DEFAULT_SESSION_TTL_MS } from './savedDocuments';

function pageMeta(name: string): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
}

/** FOLIO_PWA=off on the server (server/pwa.ts): no worker, no install, no offline copies. */
export function pwaSwitchedOff(): boolean {
  return pageMeta('folio-pwa') === 'off';
}

/** The server's session lifetime, written into index.html by server/pageMeta.ts. */
export function sessionLifetimeMs(): number {
  const days = Number(pageMeta('folio-session-ttl-days'));
  return Number.isFinite(days) && days > 0 ? Math.round(days * 86_400_000) : DEFAULT_SESSION_TTL_MS;
}
