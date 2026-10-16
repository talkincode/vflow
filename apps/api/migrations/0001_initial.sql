-- Authoritative Cloudflare D1 schema for Video Compose
CREATE TABLE IF NOT EXISTS store_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO store_meta (id, version) VALUES (1, 0);

-- Projects and simplified two-role member ACL ('reader' | 'writer')
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reader', 'writer')),
  PRIMARY KEY (project_id, actor_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Immutable media assets stored in R2
CREATE TABLE IF NOT EXISTS assets (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_frames INTEGER,
  lineage_json TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'finalized', 'failed', 'expired')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_frames INTEGER,
  lineage_json TEXT
);

-- Character & Prop Subjects and versioned SubjectRevisions ('candidate' | 'approved')
CREATE TABLE IF NOT EXISTS subjects (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'prop')),
  name TEXT NOT NULL,
  latest_revision INTEGER NOT NULL,
  latest_approved_revision INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS subject_revisions (
  project_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved')),
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (project_id, subject_id, revision)
);

CREATE TABLE IF NOT EXISTS subject_changes (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  touched_paths_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, subject_id, id)
);

-- Compositions, immutable Revisions, Changes, and Review Proposals
CREATE TABLE IF NOT EXISTS compositions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT,
  head_revision INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS composition_revisions (
  project_id TEXT NOT NULL,
  composition_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parent_revision INTEGER,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  operation_id TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (project_id, composition_id, revision)
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  composition_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  touched_paths_json TEXT NOT NULL,
  auto_merged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  composition_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  description TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'conflicted')),
  result_revision INTEGER,
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  idem_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);
