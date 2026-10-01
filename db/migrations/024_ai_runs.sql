-- Uninterrupted runs of Folio AI (05.09.2026). A run of the agent is a server
-- task with a row of its own: it survives a break of the HTTP connection, and
-- the partial text and the step are flushed here periodically, so that after
-- F5 (or a crash of the process) the user sees what the agent managed to do.
-- The terminal state is set by the server; `running` after a restart of the
-- process is turned into `error`.
CREATE TABLE IF NOT EXISTS ai_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_mode        text NOT NULL CHECK (run_mode IN ('ask', 'agent')),
  status          text NOT NULL CHECK (status IN ('running', 'done', 'error', 'cancelled')),
  step_status     text,
  step_label      text,
  text            text NOT NULL DEFAULT '',
  error           text,
  message_id      uuid REFERENCES ai_messages(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS ai_runs_user_idx ON ai_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx ON ai_runs(conversation_id, started_at DESC);
