-- Sign-in through Google (OAuth 2.0), the owner's decision: corporate domains,
-- auto-creation without access to a space, linking by email.
--
-- google_sub is the stable identifier of a Google account (JWT `sub`), never
-- the email (that can change on Google's side). UNIQUE without NOT NULL —
-- Postgres allows any number of NULLs in a unique column, so password-only
-- users (the majority) simply do not have this field.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;

-- A user created only through Google has no password at all — NULL, not an
-- empty string or a fake hash (server/auth/passwords.ts::verifyPassword
-- already treats NULL as "the password can never be guessed", the comparison
-- with bcrypt is not performed).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
