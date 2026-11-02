-- Refuses (the CHECK below fails, the step rolls back) while summaries are stored: delete them by hand
-- first, never as a side effect of a (multi-step) rollback.
CREATE TEMP TABLE call_summaries_rollback_guard (n bigint CHECK (n = 0)) ON COMMIT DROP;
INSERT INTO call_summaries_rollback_guard SELECT count(*) FROM call_summaries;
DROP TABLE call_summaries;
