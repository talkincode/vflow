-- Cloudflare D1 schema for MCP OAuth 2.1 in vflow
CREATE TABLE IF NOT EXISTS mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  response_types_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  secret_hash TEXT,
  owner TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS mcp_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  owner TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  resource TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  code_hash TEXT,
  csrf TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (client_id) REFERENCES mcp_clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (client_id) REFERENCES mcp_clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_grants_code_hash ON mcp_grants(code_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_token_hash ON mcp_tokens(token_hash);
