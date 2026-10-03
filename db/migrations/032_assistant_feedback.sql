-- AI assistant analytics (answer feedback, periodic survey, questions the
-- assistant could not answer). Visible to instance admins only.

-- Where a run was started from, and which user message started it, so the
-- admin analytics can filter by space and link a run back to its messages.
-- Runs older than this migration keep NULLs.
ALTER TABLE ai_runs
  ADD COLUMN IF NOT EXISTS space           text,
  ADD COLUMN IF NOT EXISTS page_id         text,
  ADD COLUMN IF NOT EXISTS user_message_id uuid REFERENCES ai_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_runs_space_idx ON ai_runs(space, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_user_message_idx ON ai_runs(user_message_id);
CREATE INDEX IF NOT EXISTS ai_runs_message_idx ON ai_runs(message_id);

-- One rating per assistant message (the owner of the conversation), changeable.
CREATE TABLE IF NOT EXISTS ai_message_feedback (
  message_id uuid PRIMARY KEY REFERENCES ai_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     text NOT NULL CHECK (rating IN ('up', 'down')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- "Did the assistant solve your question?" — asked after every N-th answer
-- since the previous survey (answered or skipped).
CREATE TABLE IF NOT EXISTS ai_conversation_surveys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  after_message_id uuid NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  answer           text NOT NULL CHECK (answer IN ('solved', 'partly', 'not_solved', 'skipped')),
  comment          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, after_message_id)
);
CREATE INDEX IF NOT EXISTS ai_conversation_surveys_conversation_idx ON ai_conversation_surveys(conversation_id, created_at);

-- Reported by the assistant itself (built-in tool report_unanswered_question).
CREATE TABLE IF NOT EXISTS ai_unanswered_questions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space           text,
  page_id         text,
  question        text NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('no_answer', 'low_confidence')),
  missing         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_unanswered_created_idx ON ai_unanswered_questions(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_unanswered_space_idx ON ai_unanswered_questions(space, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_unanswered_user_idx ON ai_unanswered_questions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_unanswered_conversation_idx ON ai_unanswered_questions(conversation_id, created_at);
