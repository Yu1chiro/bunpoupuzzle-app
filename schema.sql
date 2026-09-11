-- Jalankan pada database Neon kosong. Aman dijalankan ulang.
BEGIN;
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY,
  username VARCHAR(40) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS decks (
  id UUID PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  title VARCHAR(100) NOT NULL,
  description VARCHAR(300) NOT NULL DEFAULT '',
  seconds_per_question INTEGER NOT NULL DEFAULT 60 CHECK (seconds_per_question BETWEEN 5 AND 600),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS decks_admin_idx ON decks(admin_id);
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY,
  deck_id UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  question VARCHAR(1000) NOT NULL,
  clue VARCHAR(500) NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT question_has_separator CHECK (position('・' in question) > 0)
);
CREATE INDEX IF NOT EXISTS questions_deck_idx ON questions(deck_id, position);
-- Snapshot menjaga sesi tetap konsisten saat admin mengedit/menghapus deck.
-- Token sesi asli hanya di browser, database menyimpan SHA-256-nya.
CREATE TABLE IF NOT EXISTS game_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  state JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS game_expiry_idx ON game_sessions(expires_at);
COMMIT;
