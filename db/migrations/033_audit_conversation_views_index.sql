-- "Who opened this assistant conversation" (the analytics page, /admin/assistant): reads the
-- `assistant.conversation_viewed` entries of audit_log by conversation id (target), newest first.
-- audit_log is shared with every other audited action and has no index at all; a partial index
-- keeps this lookup off a sequential scan and costs nothing for the other actions.
CREATE INDEX IF NOT EXISTS audit_log_conversation_viewed_idx
  ON audit_log (target, at DESC)
  WHERE action = 'assistant.conversation_viewed';
