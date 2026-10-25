import type {
  ActorKind,
  CompositionDocument,
  ProjectRole,
  SubjectKind,
  SubjectSnapshot,
} from "@video-compose/protocol";
import {
  resourceKey,
  createEmptyStateSnapshot,
  type DomainStateSnapshot,
  type DomainStore,
  type ObjectBucketAdapter,
} from "./storage.ts";
import { DomainError, type TypedOperation } from "./types.ts";

export interface CloudflareD1PreparedStatementLike {
  bind(...values: unknown[]): CloudflareD1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface CloudflareD1DatabaseLike {
  prepare(query: string): CloudflareD1PreparedStatementLike;
  batch(
    statements: CloudflareD1PreparedStatementLike[],
  ): Promise<Array<{ results?: unknown[]; meta?: { changes?: number } }>>;
}

export interface CloudflareR2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
}

export interface CloudflareR2BucketLike {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<CloudflareR2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
}

export class R2ObjectBucketAdapter implements ObjectBucketAdapter {
  private readonly r2: CloudflareR2BucketLike;

  constructor(r2: CloudflareR2BucketLike) {
    this.r2 = r2;
  }

  async put(key: string, data: Uint8Array, mimeType: string): Promise<void> {
    await this.r2.put(key, data, {
      httpMetadata: { contentType: mimeType },
    });
  }

  async get(
    key: string,
  ): Promise<{ data: Uint8Array; mimeType: string } | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    const ab = await obj.arrayBuffer();
    return {
      data: new Uint8Array(ab),
      mimeType: obj.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    await this.r2.delete(key);
  }

  async read(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.r2.get(key, range ? { range } : undefined);
    return object?.body ?? null;
  }

  async has(key: string): Promise<boolean> {
    const head = await this.r2.head(key);
    return head !== null;
  }
}

function compositeKey(projectId: string, entityId: string): string {
  return resourceKey(projectId, entityId);
}

export class D1TransactionalStore implements DomainStore {
  private readonly db: CloudflareD1DatabaseLike;
  readonly bucket: ObjectBucketAdapter;
  private faultStages = new Set<string>();

  constructor(db: CloudflareD1DatabaseLike, bucket: ObjectBucketAdapter) {
    this.db = db;
    this.bucket = bucket;
  }

  injectFaultOnce(stage: string): void {
    this.faultStages.add(stage);
  }

  private checkFault(stage: string): void {
    if (this.faultStages.has(stage)) {
      this.faultStages.delete(stage);
      throw new DomainError(
        "INTERNAL_ERROR",
        `Simulated D1 transactional commit failure at stage '${stage}'.`,
      );
    }
  }

  private async loadSnapshotWithVersion(): Promise<{
    version: number;
    state: DomainStateSnapshot;
  }> {
    const state = createEmptyStateSnapshot();

    const [
      metaRes,
      projectsRes,
      membersRes,
      assetsRes,
      sessionsRes,
      subjectsRes,
      subjectRevsRes,
      subjectChangesRes,
      compositionsRes,
      compRevsRes,
      changesRes,
      proposalsRes,
      idemRes,
      referenceDocsRes,
      referenceEvidenceRes,
      lifecycleRes,
    ] = await Promise.all([
      this.db
        .prepare("SELECT version FROM store_meta WHERE id = 1")
        .all<{ version: number }>(),
      this.db
        .prepare(
          "SELECT id, name, description, created_at, created_by, owner_user_id, sharing_mode, membership_revision FROM projects",
        )
        .all<{
          id: string;
          name: string;
          description: string | null;
          created_at: string;
          created_by: string;
          owner_user_id: string | null;
          sharing_mode: "private" | "members";
          membership_revision: number;
        }>(),
      this.db
        .prepare("SELECT project_id, actor_id, role FROM project_members")
        .all<{ project_id: string; actor_id: string; role: ProjectRole }>(),
      this.db
        .prepare(
          "SELECT project_id, id, sha256, mime_type, size_bytes, storage_key, width, height, duration_frames, lineage_json, created_at, created_by FROM assets",
        )
        .all<{
          project_id: string;
          id: string;
          sha256: string;
          mime_type: string;
          size_bytes: number;
          storage_key: string;
          width: number | null;
          height: number | null;
          duration_frames: number | null;
          lineage_json: string | null;
          created_at: string;
          created_by: string;
        }>(),
      this.db
        .prepare(
          "SELECT session_id, project_id, asset_id, expected_sha256, mime_type, expected_size_bytes, storage_key, status, expires_at, created_by, width, height, duration_frames, lineage_json FROM upload_sessions",
        )
        .all<{
          session_id: string;
          project_id: string;
          asset_id: string;
          expected_sha256: string;
          mime_type: string;
          expected_size_bytes: number;
          storage_key: string;
          status: "pending" | "finalized" | "failed" | "expired";
          expires_at: string;
          created_by: string;
          width: number | null;
          height: number | null;
          duration_frames: number | null;
          lineage_json: string | null;
        }>(),
      this.db
        .prepare(
          "SELECT project_id, id, kind, name, latest_revision, latest_approved_revision, updated_at FROM subjects",
        )
        .all<{
          project_id: string;
          id: string;
          kind: SubjectKind;
          name: string;
          latest_revision: number;
          latest_approved_revision: number | null;
          updated_at: string;
        }>(),
      this.db
        .prepare(
          "SELECT project_id, subject_id, revision, status, snapshot_json FROM subject_revisions",
        )
        .all<{
          project_id: string;
          subject_id: string;
          revision: number;
          status: "candidate" | "approved";
          snapshot_json: string;
        }>(),
      this.db
        .prepare(
          "SELECT id, project_id, subject_id, base_revision, result_revision, operation_id, actor_id, actor_kind, touched_paths_json, created_at FROM subject_changes ORDER BY result_revision ASC",
        )
        .all<{
          id: string;
          project_id: string;
          subject_id: string;
          base_revision: number;
          result_revision: number;
          operation_id: string;
          actor_id: string;
          actor_kind: ActorKind;
          touched_paths_json: string;
          created_at: string;
        }>(),
      this.db
        .prepare(
          "SELECT project_id, id, title, head_revision FROM compositions",
        )
        .all<{
          project_id: string;
          id: string;
          title: string | null;
          head_revision: number;
        }>(),
      this.db
        .prepare(
          "SELECT project_id, composition_id, revision, parent_revision, actor_id, actor_kind, operation_id, message, created_at, document_json FROM composition_revisions",
        )
        .all<{
          project_id: string;
          composition_id: string;
          revision: number;
          parent_revision: number | null;
          actor_id: string;
          actor_kind: ActorKind;
          operation_id: string;
          message: string | null;
          created_at: string;
          document_json: string;
        }>(),
      this.db
        .prepare(
          "SELECT id, project_id, composition_id, base_revision, result_revision, operation_id, actor_id, actor_kind, operations_json, touched_paths_json, auto_merged, created_at FROM changes ORDER BY result_revision ASC",
        )
        .all<{
          id: string;
          project_id: string;
          composition_id: string;
          base_revision: number;
          result_revision: number;
          operation_id: string;
          actor_id: string;
          actor_kind: ActorKind;
          operations_json: string;
          touched_paths_json: string;
          auto_merged: number;
          created_at: string;
        }>(),
      this.db
        .prepare(
          "SELECT project_id, id, composition_id, base_revision, operation_id, actor_id, actor_kind, description, operations_json, status, result_revision, created_at, reviewed_by, reviewed_at FROM proposals",
        )
        .all<{
          project_id: string;
          id: string;
          composition_id: string;
          base_revision: number;
          operation_id: string;
          actor_id: string;
          actor_kind: ActorKind;
          description: string;
          operations_json: string;
          status: "open" | "approved" | "rejected" | "conflicted";
          result_revision: number | null;
          created_at: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
        }>(),
      this.db
        .prepare("SELECT idem_key, result_json FROM idempotency_records")
        .all<{ idem_key: string; result_json: string }>(),
      this.db
        .prepare("SELECT project_id, id, record_json FROM reference_documents")
        .all<{ project_id: string; id: string; record_json: string }>(),
      this.db
        .prepare("SELECT project_id, id, record_json FROM reference_evidence")
        .all<{ project_id: string; id: string; record_json: string }>(),
      this.db
        .prepare(
          "SELECT project_id, kind, id, record_json FROM resource_lifecycle",
        )
        .all<{
          project_id: string;
          kind: string;
          id: string;
          record_json: string;
        }>(),
    ]);

    const version = metaRes.results[0]?.version ?? 0;
    for (const row of lifecycleRes.results) {
      const record = JSON.parse(
        row.record_json,
      ) as import("./lifecycle.ts").LifecycleRecord;
      state.lifecycle[JSON.stringify([row.project_id, row.kind, row.id])] =
        record;
    }

    for (const row of projectsRes.results) {
      state.projects[row.id] = {
        id: row.id,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        createdAt: row.created_at,
        createdBy: row.created_by,
        sharingMode: row.sharing_mode,
        membershipRevision: row.membership_revision,
        ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
        members: {},
      };
    }

    for (const m of membersRes.results) {
      const proj = state.projects[m.project_id];
      if (proj) {
        proj.members[m.actor_id] = m.role;
      }
    }

    for (const a of assetsRes.results) {
      state.assets[compositeKey(a.project_id, a.id)] = {
        id: a.id,
        projectId: a.project_id,
        sha256: a.sha256,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        storageKey: a.storage_key,
        ...(a.width !== null ? { width: a.width } : {}),
        ...(a.height !== null ? { height: a.height } : {}),
        ...(a.duration_frames !== null
          ? { durationFrames: a.duration_frames }
          : {}),
        ...(a.lineage_json
          ? { lineage: JSON.parse(a.lineage_json) as Record<string, unknown> }
          : {}),
        createdAt: a.created_at,
        createdBy: a.created_by,
      };
    }

    for (const s of sessionsRes.results) {
      state.uploadSessions[s.session_id] = {
        sessionId: s.session_id,
        projectId: s.project_id,
        assetId: s.asset_id,
        expectedSha256: s.expected_sha256,
        mimeType: s.mime_type,
        expectedSizeBytes: s.expected_size_bytes,
        storageKey: s.storage_key,
        status: s.status,
        expiresAt: s.expires_at,
        createdBy: s.created_by,
        ...(s.width !== null ? { width: s.width } : {}),
        ...(s.height !== null ? { height: s.height } : {}),
        ...(s.duration_frames !== null
          ? { durationFrames: s.duration_frames }
          : {}),
        ...(s.lineage_json
          ? { lineage: JSON.parse(s.lineage_json) as Record<string, unknown> }
          : {}),
      };
    }

    for (const subj of subjectsRes.results) {
      const sKey = compositeKey(subj.project_id, subj.id);
      state.subjects[sKey] = {
        id: subj.id,
        projectId: subj.project_id,
        kind: subj.kind,
        name: subj.name,
        latestRevision: subj.latest_revision,
        latestApprovedRevision: subj.latest_approved_revision,
        revisions: {},
        updatedAt: subj.updated_at,
      };
      state.subjectChanges[sKey] = [];
    }

    for (const rev of subjectRevsRes.results) {
      const sKey = compositeKey(rev.project_id, rev.subject_id);
      const subj = state.subjects[sKey];
      if (subj) {
        subj.revisions[rev.revision] = JSON.parse(
          rev.snapshot_json,
        ) as SubjectSnapshot;
      }
    }

    for (const chg of subjectChangesRes.results) {
      const sKey = compositeKey(chg.project_id, chg.subject_id);
      if (!state.subjectChanges[sKey]) {
        state.subjectChanges[sKey] = [];
      }
      state.subjectChanges[sKey].push({
        id: chg.id,
        projectId: chg.project_id,
        subjectId: chg.subject_id,
        baseRevision: chg.base_revision,
        resultRevision: chg.result_revision,
        operationId: chg.operation_id,
        actorId: chg.actor_id,
        actorKind: chg.actor_kind,
        touchedPaths: JSON.parse(chg.touched_paths_json) as string[],
        createdAt: chg.created_at,
      });
    }

    for (const comp of compositionsRes.results) {
      const cKey = compositeKey(comp.project_id, comp.id);
      state.compositions[cKey] = {
        id: comp.id,
        projectId: comp.project_id,
        ...(comp.title ? { title: comp.title } : {}),
        headRevision: comp.head_revision,
        revisions: {},
      };
      state.changes[cKey] = [];
    }

    for (const rev of compRevsRes.results) {
      const cKey = compositeKey(rev.project_id, rev.composition_id);
      const comp = state.compositions[cKey];
      if (comp) {
        comp.revisions[rev.revision] = {
          compositionId: rev.composition_id,
          projectId: rev.project_id,
          revision: rev.revision,
          parentRevision: rev.parent_revision,
          actorId: rev.actor_id,
          actorKind: rev.actor_kind,
          operationId: rev.operation_id,
          ...(rev.message ? { message: rev.message } : {}),
          createdAt: rev.created_at,
          document: JSON.parse(rev.document_json) as CompositionDocument,
        };
      }
    }

    for (const chg of changesRes.results) {
      const cKey = compositeKey(chg.project_id, chg.composition_id);
      if (!state.changes[cKey]) {
        state.changes[cKey] = [];
      }
      state.changes[cKey].push({
        id: chg.id,
        projectId: chg.project_id,
        compositionId: chg.composition_id,
        baseRevision: chg.base_revision,
        resultRevision: chg.result_revision,
        operationId: chg.operation_id,
        actorId: chg.actor_id,
        actorKind: chg.actor_kind,
        operations: JSON.parse(chg.operations_json) as TypedOperation[],
        touchedPaths: JSON.parse(chg.touched_paths_json) as string[],
        autoMergedFromStaleBase: chg.auto_merged === 1,
        createdAt: chg.created_at,
      });
    }

    for (const prop of proposalsRes.results) {
      state.proposals[compositeKey(prop.project_id, prop.id)] = {
        id: prop.id,
        projectId: prop.project_id,
        compositionId: prop.composition_id,
        baseRevision: prop.base_revision,
        operationId: prop.operation_id,
        actorId: prop.actor_id,
        actorKind: prop.actor_kind,
        description: prop.description,
        operations: JSON.parse(prop.operations_json) as TypedOperation[],
        status: prop.status,
        ...(prop.result_revision !== null
          ? { resultRevision: prop.result_revision }
          : {}),
        createdAt: prop.created_at,
        ...(prop.reviewed_by ? { reviewedBy: prop.reviewed_by } : {}),
        ...(prop.reviewed_at ? { reviewedAt: prop.reviewed_at } : {}),
      };
    }

    for (const idem of idemRes.results) {
      state.idempotencyRecords[idem.idem_key] = JSON.parse(idem.result_json);
    }

    for (const row of referenceDocsRes.results)
      state.materials[compositeKey(row.project_id, row.id)] = JSON.parse(
        row.record_json,
      );
    for (const row of referenceEvidenceRes.results)
      state.generationEvidence[compositeKey(row.project_id, row.id)] =
        JSON.parse(row.record_json);
    return { version, state };
  }

  async readState(): Promise<Readonly<DomainStateSnapshot>> {
    const { state } = await this.loadSnapshotWithVersion();
    return state;
  }

  async runInTransaction<T>(
    stageName: string,
    fn: (draft: DomainStateSnapshot) => T | Promise<T>,
  ): Promise<T> {
    const { version, state: beforeState } =
      await this.loadSnapshotWithVersion();
    const draft = structuredClone(beforeState);
    const result = await fn(draft);

    this.checkFault(stageName);

    const stmts: CloudflareD1PreparedStatementLike[] = [];

    // Optimistic compare-and-swap version bump
    stmts.push(
      this.db
        .prepare(
          "UPDATE store_meta SET version = ? WHERE id = 1 AND version = ?",
        )
        .bind(version + 1, version),
    );

    for (const r of Object.values(draft.lifecycle))
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO resource_lifecycle (project_id,kind,id,record_json) VALUES (?,?,?,?)",
          )
          .bind(r.projectId, r.kind, r.id, JSON.stringify(r)),
      );

    // Projects & members
    for (const proj of Object.values(draft.projects)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO projects (id, name, description, created_at, created_by, owner_user_id, sharing_mode, membership_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            proj.id,
            proj.name,
            proj.description ?? null,
            proj.createdAt,
            proj.createdBy,
            proj.ownerUserId ?? null,
            proj.sharingMode ?? "private",
            proj.membershipRevision ?? 0,
          ),
      );
      stmts.push(
        this.db
          .prepare("DELETE FROM project_members WHERE project_id = ?")
          .bind(proj.id),
      );
      for (const [actorId, role] of Object.entries(proj.members)) {
        stmts.push(
          this.db
            .prepare(
              "INSERT INTO project_members (project_id, actor_id, role) VALUES (?, ?, ?)",
            )
            .bind(proj.id, actorId, role),
        );
      }
    }

    // Deleted assets cleanup
    for (const oldKey of Object.keys(beforeState.assets)) {
      if (!draft.assets[oldKey]) {
        const oldAsset = beforeState.assets[oldKey];
        stmts.push(
          this.db
            .prepare("DELETE FROM assets WHERE project_id = ? AND id = ?")
            .bind(oldAsset.projectId, oldAsset.id),
        );
      }
    }

    // Assets upsert
    for (const asset of Object.values(draft.assets)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO assets (project_id, id, sha256, mime_type, size_bytes, storage_key, width, height, duration_frames, lineage_json, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            asset.projectId,
            asset.id,
            asset.sha256,
            asset.mimeType,
            asset.sizeBytes,
            asset.storageKey,
            asset.width ?? null,
            asset.height ?? null,
            asset.durationFrames ?? null,
            asset.lineage ? JSON.stringify(asset.lineage) : null,
            asset.createdAt,
            asset.createdBy,
          ),
      );
    }

    // Upload sessions upsert
    for (const session of Object.values(draft.uploadSessions)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO upload_sessions (session_id, project_id, asset_id, expected_sha256, mime_type, expected_size_bytes, storage_key, status, expires_at, created_by, width, height, duration_frames, lineage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            session.sessionId,
            session.projectId,
            session.assetId,
            session.expectedSha256,
            session.mimeType,
            session.expectedSizeBytes,
            session.storageKey,
            session.status,
            session.expiresAt,
            session.createdBy,
            session.width ?? null,
            session.height ?? null,
            session.durationFrames ?? null,
            session.lineage ? JSON.stringify(session.lineage) : null,
          ),
      );
    }

    // Subjects, subject_revisions, subject_changes
    for (const [sKey, subj] of Object.entries(draft.subjects)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO subjects (project_id, id, kind, name, latest_revision, latest_approved_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            subj.projectId,
            subj.id,
            subj.kind,
            subj.name,
            subj.latestRevision,
            subj.latestApprovedRevision,
            subj.updatedAt,
          ),
      );
      for (const rev of Object.values(subj.revisions)) {
        stmts.push(
          this.db
            .prepare(
              "INSERT OR REPLACE INTO subject_revisions (project_id, subject_id, revision, status, snapshot_json) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(
              subj.projectId,
              subj.id,
              rev.revision,
              rev.status,
              JSON.stringify(rev),
            ),
        );
      }
      for (const chg of draft.subjectChanges[sKey] ?? []) {
        stmts.push(
          this.db
            .prepare(
              "INSERT OR REPLACE INTO subject_changes (id, project_id, subject_id, base_revision, result_revision, operation_id, actor_id, actor_kind, touched_paths_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              chg.id,
              chg.projectId,
              chg.subjectId,
              chg.baseRevision,
              chg.resultRevision,
              chg.operationId,
              chg.actorId,
              chg.actorKind,
              JSON.stringify(chg.touchedPaths),
              chg.createdAt,
            ),
        );
      }
    }

    // Compositions, composition_revisions, changes
    for (const [cKey, comp] of Object.entries(draft.compositions)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO compositions (project_id, id, title, head_revision) VALUES (?, ?, ?, ?)",
          )
          .bind(comp.projectId, comp.id, comp.title ?? null, comp.headRevision),
      );
      for (const rev of Object.values(comp.revisions)) {
        stmts.push(
          this.db
            .prepare(
              "INSERT OR REPLACE INTO composition_revisions (project_id, composition_id, revision, parent_revision, actor_id, actor_kind, operation_id, message, created_at, document_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              rev.projectId,
              rev.compositionId,
              rev.revision,
              rev.parentRevision,
              rev.actorId,
              rev.actorKind,
              rev.operationId,
              rev.message ?? null,
              rev.createdAt,
              JSON.stringify(rev.document),
            ),
        );
      }
      for (const chg of draft.changes[cKey] ?? []) {
        stmts.push(
          this.db
            .prepare(
              "INSERT OR REPLACE INTO changes (id, project_id, composition_id, base_revision, result_revision, operation_id, actor_id, actor_kind, operations_json, touched_paths_json, auto_merged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              chg.id,
              chg.projectId,
              chg.compositionId,
              chg.baseRevision,
              chg.resultRevision,
              chg.operationId,
              chg.actorId,
              chg.actorKind,
              JSON.stringify(chg.operations),
              JSON.stringify(chg.touchedPaths),
              chg.autoMergedFromStaleBase ? 1 : 0,
              chg.createdAt,
            ),
        );
      }
    }

    // Proposals
    for (const prop of Object.values(draft.proposals)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO proposals (project_id, id, composition_id, base_revision, operation_id, actor_id, actor_kind, description, operations_json, status, result_revision, created_at, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            prop.projectId,
            prop.id,
            prop.compositionId,
            prop.baseRevision,
            prop.operationId,
            prop.actorId,
            prop.actorKind,
            prop.description,
            JSON.stringify(prop.operations),
            prop.status,
            prop.resultRevision ?? null,
            prop.createdAt,
            prop.reviewedBy ?? null,
            prop.reviewedAt ?? null,
          ),
      );
    }

    // Idempotency records
    for (const [idemKey, val] of Object.entries(draft.idempotencyRecords)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO idempotency_records (idem_key, result_json) VALUES (?, ?)",
          )
          .bind(idemKey, JSON.stringify(val)),
      );
    }

    for (const record of Object.values(draft.materials)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO reference_documents (project_id, id, record_json) VALUES (?, ?, ?)",
          )
          .bind(record.projectId, record.id, JSON.stringify(record)),
      );
    }
    for (const record of Object.values(draft.generationEvidence)) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO reference_evidence (project_id, id, record_json) VALUES (?, ?, ?)",
          )
          .bind(record.projectId, record.id, JSON.stringify(record)),
      );
    }
    const batchResults = await this.db.batch(stmts);
    const casChanges = batchResults[0]?.meta?.changes;
    if (casChanges !== undefined && casChanges === 0) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Concurrent D1 transaction modified store_meta version during commit.",
      );
    }

    return structuredClone(result);
  }
}
