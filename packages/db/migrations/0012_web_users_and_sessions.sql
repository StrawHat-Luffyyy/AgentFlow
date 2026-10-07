CREATE TABLE web_users (
  id VARCHAR(200) PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  roles TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE web_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(200) NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_web_sessions_user_id ON web_sessions(user_id);
CREATE INDEX idx_web_sessions_expires_at ON web_sessions(expires_at);
