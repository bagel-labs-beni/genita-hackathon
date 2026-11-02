-- F1-L4 · schema v1. Every user-owned row hangs off users(id) ON DELETE CASCADE,
-- so DELETE FROM users WHERE id = $1 removes the account's data in one statement
-- (blob objects under users/<id>/ are deleted separately, see auth/routes.ts).
-- gen_random_uuid() is built in from Postgres 13.

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL CHECK (provider IN ('apple', 'google', 'dev')),
  provider_sub        text NOT NULL,
  email               text,
  display_name        text,
  ai_consent_at       timestamptz,
  -- Apple refresh token + the client_id it was issued to (bundle id or services id),
  -- kept only to revoke the Sign in with Apple link on account deletion.
  apple_refresh_token text,
  apple_client_id     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_sub)
);

-- Consent log (users.ai_consent_at is the fast flag; this is the audit trail).
CREATE TABLE consents (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('ai_data', 'photo_rights', 'seen_memory')),
  version     text NOT NULL DEFAULT 'v1',
  granted     boolean NOT NULL DEFAULT true,
  device      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_user_idx ON consents (user_id, kind);

-- Login sessions behind the 30-day session JWT (sid claim). Logout = revoked_at.
CREATE TABLE auth_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device      text NOT NULL CHECK (device IN ('iphone', 'mac', 'web', 'dev')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

-- One-time codes for the Mac web login (callback → genita://… → POST /auth/exchange).
CREATE TABLE auth_codes (
  code_hash       text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device          text NOT NULL,
  code_challenge  text NOT NULL,
  is_new          boolean NOT NULL DEFAULT false,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);
CREATE INDEX auth_codes_user_idx ON auth_codes (user_id);

-- F3-L2 imported style card (raw pasted text is never stored).
CREATE TABLE user_styles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  source      text NOT NULL DEFAULT 'import',
  style_json  jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- F2-L20 uploaded companion photos. Bytes live in blob storage at blob_key.
CREATE TABLE companion_images (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        text NOT NULL,
  bytes       integer NOT NULL,
  blob_key    text NOT NULL,
  check_json  jsonb NOT NULL,
  head_box    jsonb,
  rights_ack  boolean NOT NULL DEFAULT false,
  ms_json     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companion_images_user_idx ON companion_images (user_id);

-- One companion per user (PRD: the face cannot be changed).
CREATE TABLE companions (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  image_id      text NOT NULL REFERENCES companion_images(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('human', 'animal', 'character')),
  source_image  text,
  voice_id      text NOT NULL,
  name          text NOT NULL,
  prep_status   text NOT NULL DEFAULT 'running' CHECK (prep_status IN ('running', 'ready', 'failed')),
  persona_card  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- F2-L9 prep job (scene → 3 silent clips → lips). state_json is the runner's PrepState.
CREATE TABLE clip_jobs (
  companion_id  text PRIMARY KEY REFERENCES companions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  state_json    jsonb NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ready_at      timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clip_jobs_status_idx ON clip_jobs (status);

-- Finished emotion clips (derived from clip_jobs.state_json on every write).
CREATE TABLE companion_emotions (
  companion_id  text NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  emotion       text NOT NULL,
  video_url     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (companion_id, emotion)
);

-- F2-L14 setup answers.
CREATE TABLE companion_prefs (
  companion_id  text PRIMARY KEY REFERENCES companions(id) ON DELETE CASCADE,
  depth         text NOT NULL,
  answers_json  jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- F6 conversation ownership (placeholder until F6-L7): which device holds the
-- sound right now, bumped epoch on every claim.
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  companion_id    text REFERENCES companions(id) ON DELETE CASCADE,
  active_device   text CHECK (active_device IN ('iphone', 'mac')),
  epoch           integer NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (user_id, last_active_at DESC);

CREATE TABLE messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'other')),
  text             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, id);

-- F7 memories. kind 'seen' = seen memory (PRD 20b): image_ref is the small
-- SAM-box crop in blob storage, text is the one line. The original photo is never kept.
CREATE TABLE memories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  companion_id     text REFERENCES companions(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('fact', 'episode', 'seen')),
  text             text NOT NULL,
  image_ref        text,
  box_json         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  CHECK (kind <> 'seen' OR image_ref IS NOT NULL)
);
CREATE INDEX memories_user_idx ON memories (user_id, kind, created_at DESC);

-- F10 result cards (Finds tab).
CREATE TABLE finds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind             text NOT NULL,
  title            text NOT NULL,
  summary          text,
  sources          jsonb NOT NULL DEFAULT '[]'::jsonb,
  card_json        jsonb,
  image_ref        text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finds_user_idx ON finds (user_id, created_at DESC);

-- F0-I3 per-user daily caps.
CREATE TABLE usage_daily (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        date NOT NULL,
  turns      integer NOT NULL DEFAULT 0,
  uploads    integer NOT NULL DEFAULT 0,
  clip_sets  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
