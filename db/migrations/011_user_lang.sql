-- Round 10: i18n. NULL = no preference set yet — client/server both fall back
-- to DEFAULT_UI_LANGUAGE ('uk', shared/contracts.ts) rather than writing that
-- default in on every user row, so a future default change doesn't need a
-- backfill.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang text CHECK (lang IN ('uk', 'en', 'ru'));
