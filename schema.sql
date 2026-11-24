CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  verifier_cipher TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_cipher TEXT NOT NULL,
  calendar_id TEXT,
  create_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (create_state IN ('idle', 'creating', 'uncertain', 'ready'))
);
CREATE TABLE IF NOT EXISTS discord_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  limited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, title TEXT NOT NULL, due_date TEXT NOT NULL, due_time TEXT, notes TEXT, event_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_seen (source_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
