-- Early-access waitlist (teaser page, 11/5). One row per address, not tied to an account (the person
-- may never sign up). The address is stored lowercased and trimmed; ip_hash is a keyed hash of the
-- caller's IP (never the IP itself), kept only to spot abuse. Export: scripts/early-access-export.ts.

CREATE TABLE early_access (
  email       text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  source      text,
  ip_hash     text
);
CREATE INDEX early_access_created_idx ON early_access (created_at);
