-- Refuses (the CHECK below fails, the whole step rolls back) while any memory, tombstone or memory
-- state is stored: export or delete them by hand first, never as a side effect of a rollback.
-- The exclusive locks come first so no write can commit between the count and the DROP.
LOCK TABLE memory_items, memory_tombstones, memory_state IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE memory_rollback_guard (n bigint CHECK (n = 0)) ON COMMIT DROP;
INSERT INTO memory_rollback_guard SELECT (SELECT count(*) FROM memory_items) + (SELECT count(*) FROM memory_tombstones) + (SELECT count(*) FROM memory_state);
DROP TABLE memory_state;
DROP TABLE memory_tombstones;
DROP TABLE memory_items;
