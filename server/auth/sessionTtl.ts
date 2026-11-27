// Split out of store.ts so pageMeta.ts can tell the client the session lifetime without loading the database layer.

const DEFAULT_SESSION_TTL_DAYS = 30;

/**
 * Absolute lifetime of a login session (no sliding expiry): FOLIO_SESSION_TTL_DAYS, default 30.
 * A missing, non-numeric or non-positive value falls back to the default. Read at call time, so
 * the cookie's Max-Age and the stored expires_at always agree.
 */
export function sessionTtlMs(): number {
  const raw = process.env.FOLIO_SESSION_TTL_DAYS?.trim();
  const days = raw ? Number(raw) : DEFAULT_SESSION_TTL_DAYS;
  const valid = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : DEFAULT_SESSION_TTL_DAYS;
  return Math.round(valid * 24 * 60 * 60 * 1000);
}
