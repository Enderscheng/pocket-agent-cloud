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
