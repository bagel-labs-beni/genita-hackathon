-- Refuses (the CHECK below fails, the step rolls back) while addresses are stored: export and delete
-- them by hand first, never as a side effect of a (multi-step) rollback. The exclusive lock comes
-- first so no signup can commit between the count and the DROP.
LOCK TABLE early_access IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE early_access_rollback_guard (n bigint CHECK (n = 0)) ON COMMIT DROP;
INSERT INTO early_access_rollback_guard SELECT count(*) FROM early_access;
DROP TABLE early_access;
