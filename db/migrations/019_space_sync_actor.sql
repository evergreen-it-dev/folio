-- Persist the identity responsible for the latest completed git sync so the
-- instance-admin spaces screen can show an auditable “who / when”.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS last_sync_by_name text;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS last_sync_by_email text;
