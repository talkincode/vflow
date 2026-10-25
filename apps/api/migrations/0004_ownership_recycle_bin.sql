-- Ownership is server-derived. Legacy agent-created projects migrate only when
-- there is exactly one human writer; ambiguous projects remain quarantined.
ALTER TABLE projects ADD COLUMN owner_user_id TEXT;
UPDATE projects SET owner_user_id = CASE
  WHEN instr(created_by, '@') > 0 THEN lower(trim(created_by))
  ELSE (SELECT CASE WHEN count(DISTINCT lower(trim(actor_id))) = 1 THEN min(lower(trim(actor_id))) ELSE NULL END
        FROM project_members WHERE project_id = projects.id AND role = 'writer' AND instr(actor_id, '@') > 0)
END;
ALTER TABLE projects ADD COLUMN sharing_mode TEXT NOT NULL DEFAULT 'private' CHECK(sharing_mode IN ('private','members'));
UPDATE projects SET sharing_mode = 'members' WHERE EXISTS (
  SELECT 1 FROM project_members WHERE project_id = projects.id AND instr(actor_id,'@') > 0 AND lower(trim(actor_id)) <> owner_user_id
);
ALTER TABLE projects ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX projects_owner_idx ON projects(owner_user_id);
CREATE TABLE resource_lifecycle (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('project','composition')),
  id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(project_id,kind,id)
);
