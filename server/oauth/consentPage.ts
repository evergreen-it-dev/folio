/**
 * Server-rendered HTML for the OAuth consent screen and error pages. Server-rendered (not part of
 * the SPA) so it works on the very first navigation from an external app, with a strict CSP and
 * no scripts at all. Everything interpolated into it is HTML-escaped.
 */
import type { ApiTokenScope } from '../../shared/contracts.js';
import { resolveTextLanguage, serverText, type ServerTextKey } from '../serverText.js';

/** A language code that has a bundle in server/i18n (see serverText.ts). */
type Lang = string;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type TextKey = ServerTextKey extends infer K ? (K extends `oauth.${infer Rest}` ? Rest : never) : never;

function t(lang: Lang, key: TextKey, vars: Record<string, string> = {}): string {
  const template = serverText(`oauth.${key}`, lang);
  return escapeHtml(template).replace(/\{(\w+)\}/g, (_, name: string) => `<strong>${escapeHtml(vars[name] ?? '')}</strong>`);
}

/** Plain-text variant (for an attribute-free spot such as <title>). */
function plain(lang: Lang, key: TextKey): string {
  return escapeHtml(serverText(`oauth.${key}`, lang));
}

export function pickLang(userLang: string | null | undefined): Lang {
  return resolveTextLanguage(userLang);
}

const STYLE = `
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f4;color:#1c1917;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:#fff;max-width:480px;width:100%;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
h1{font-size:20px;margin:0 0 8px}
p{margin:8px 0}
.muted{color:#57534e;font-size:14px}
.warn{background:#fef3c7;border:1px solid #fcd34d;color:#78350f;border-radius:8px;padding:8px 12px;font-size:14px}
ul{padding-left:20px;margin:8px 0}
label{display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-size:15px}
.row{display:flex;gap:12px;margin-top:20px}
button{flex:1;font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #a8a29e;background:#fff;color:#1c1917;cursor:pointer}
button.primary{background:#1c1917;color:#fff;border-color:#1c1917}
@media (prefers-color-scheme:dark){body{background:#0c0a09;color:#e7e5e4}main{background:#1c1917}.muted{color:#a8a29e}button{background:#292524;color:#e7e5e4;border-color:#57534e}button.primary{background:#e7e5e4;color:#1c1917;border-color:#e7e5e4}.warn{background:#451a03;border-color:#92400e;color:#fde68a}}
`;

function shell(lang: Lang, title: string, body: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export interface ConsentView {
  lang: Lang;
  clientName: string;
  clientSource: 'dcr' | 'cimd';
  /** For CIMD, the host serving the metadata document; shown so the user can see who vouches for the name. */
  clientIdHost: string;
  redirectHost: string;
  userLabel: string;
  requestId: string;
  requestedScopes: ApiTokenScope[];
}

export function renderConsentPage(v: ConsentView): string {
  const wantsWrite = v.requestedScopes.includes('write');
  const warning =
    v.clientSource === 'dcr' ? t(v.lang, 'unverifiedDcr') : t(v.lang, 'unverifiedCimd', { host: v.clientIdHost });
  const body = `
<h1>${t(v.lang, 'heading', { app: v.clientName })}</h1>
<p class="muted">${t(v.lang, 'signedInAs', { user: v.userLabel })}</p>
<p class="warn">${warning}</p>
<p>${t(v.lang, 'canDo')}</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
<ul><li>${t(v.lang, 'read')}</li></ul>
${wantsWrite ? `<label><input type="checkbox" name="write" value="1" checked><span>${t(v.lang, 'writeOptional')}<br><span class="muted">${t(v.lang, 'write')}</span></span></label>` : ''}
<p class="muted">${t(v.lang, 'sameRights')}</p>
<p class="muted">${t(v.lang, 'willOpen', { host: v.redirectHost })}</p>
<div class="row"><button type="submit" name="decision" value="deny">${t(v.lang, 'deny')}</button><button type="submit" name="decision" value="allow" class="primary">${t(v.lang, 'allow')}</button></div>
</form>`;
  return shell(v.lang, plain(v.lang, 'title'), body);
}

export function renderErrorPage(lang: Lang, message: string): string {
  const body = `<h1>${plain(lang, 'errorTitle')}</h1><p>${escapeHtml(message)}</p><p class="muted">${plain(lang, 'back')}</p>`;
  return shell(lang, plain(lang, 'errorTitle'), body);
}

/** Headers for every HTML response of the flow: no framing (clickjacking on Allow), no caching, no scripts, no referrer. */
export const CONSENT_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // No form-action: Chrome applies it to the redirect that follows the POST, which goes to the client's callback.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};
