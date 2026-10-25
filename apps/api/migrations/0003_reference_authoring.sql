-- Immutable reference-workflow revisions and external execution evidence.
-- Existing projects without a policy remain legacy; no old composition is rewritten.
CREATE TABLE IF NOT EXISTS reference_documents (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS reference_evidence (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
