DROP TABLE email_codes;
DROP INDEX users_email_lower_idx;
DELETE FROM users WHERE provider = 'email';
ALTER TABLE users DROP CONSTRAINT users_provider_check;
ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('apple', 'google', 'dev'));
