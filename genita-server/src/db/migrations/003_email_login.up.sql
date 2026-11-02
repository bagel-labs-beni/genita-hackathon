-- Email one-time-code sign-in (auth/email.ts). Users who sign in by email get provider 'email'
-- (provider_sub = the lowercased address); an existing account whose provider marked the same
-- address verified (users.email_verified) is reused instead. Codes are stored only as a keyed hash.
-- Rows from before this migration start unverified: an Apple user is linkable after their next
-- Apple sign-in sets the flag from the identity token.

ALTER TABLE users DROP CONSTRAINT users_provider_check;
ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('apple', 'google', 'dev', 'email'));
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
CREATE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE email_codes (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX email_codes_email_idx ON email_codes (email, created_at DESC);
