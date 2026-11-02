-- Refuses (the CHECK below fails) while provider='email' accounts exist: move or delete them by hand
-- first, never by cascade from a rollback.
DROP TABLE email_codes;
DROP INDEX users_email_lower_idx;
ALTER TABLE users DROP COLUMN email_verified;
ALTER TABLE users DROP CONSTRAINT users_provider_check;
ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('apple', 'google', 'dev'));
