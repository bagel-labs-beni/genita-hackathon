-- Long-term memory in Postgres (P0 11/3): before this, the server kept memories in process unless
-- GENITA_MEMORY_FILE was set, so every deploy erased every user's memory. One row per memory
-- (item_json = src/memory/repository.ts Memory, id = memoryId(text)), Forget tombstones by id so a
-- late extraction cannot bring a forgotten line back, and the per-user call state (Forget revision,
-- last message time, opener guard, settings). Everything is keyed by users.id and cascades on delete.

CREATE TABLE memory_items (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          text NOT NULL,
  item_json   jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE memory_tombstones (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          text NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE memory_state (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_json  jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
