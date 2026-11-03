-- Session memory (memory lane 11/3): one compact summary per conversation thread (topics, mood,
-- open threads, the companion's promises, what the user asked), never the transcript. A call
-- handed off iPhone <-> Mac is ONE thread, so both devices upsert the same row. The server keeps
-- the newest SUMMARY_KEEP per user. Forget drops them all; account delete cascades.

CREATE TABLE call_summaries (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id     text NOT NULL,
  turns         integer NOT NULL,
  summary_json  jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX call_summaries_user_idx ON call_summaries (user_id, updated_at DESC);
