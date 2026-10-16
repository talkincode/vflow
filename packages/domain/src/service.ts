import {
  type ActorIdentity,
  type AssetManifestEntry,
  type CompositionDocument,
  parseBundleInterchange,
  type PortableCompositionBundle,
  type ProjectRole,
  PROTOCOL_VERSION,
  type ReferencePackEntry,
  type RevisionStatus,
  serializeBundleInterchange,
  subjectRevisionKey,
  type SubjectKind,
  type SubjectSnapshot,
  type SubjectVariant,
  validateCompositionDocument,
  validateSubjectSnapshot,
} from "@video-compose/protocol";
import {
  applyTypedOperations,
  computeOperationPaths,
  detectConflictsAgainstHistory,
  pathsOverlap,
} from "./patch.ts";
import {
  computeSha256Hex,
  type DomainStateSnapshot,
  type DomainStore,
  TransactionalMemoryStore,
} from "./storage.ts";
import {
  type AssetRecord,
  type AttachSubjectReferenceInput,
  type ChangeRecord,
  type CompositionRevisionRecord,
  type ConflictDetail,
  DomainError,
  type ProjectRecord,
  type ProposalRecord,
  type SubjectPatchChanges,
  type SubjectRecord,
  type TypedOperation,
  type UploadSessionRecord,
} from "./types.ts";

function compositeKey(projectId: string, entityId: string): string {
  return `${projectId}::${entityId}`;
}

export class VideoComposeDomainService {
  readonly store: DomainStore;

  constructor(store?: DomainStore) {
    this.store = store ?? new TransactionalMemoryStore();
  }

  private assertAuthenticated(actor: ActorIdentity | null | undefined): ActorIdentity {
    if (!actor || !actor.actorId || !actor.actorKind) {
      throw new DomainError("UNAUTHORIZED", "Authentication is required.");
    }
    return actor;
  }

  private assertProjectPermission(
    state: DomainStateSnapshot,
    projectId: string,
    actor: ActorIdentity | null | undefined,
    required: "reader" | "writer",
  ): { actor: ActorIdentity; project: ProjectRecord } {
    const authActor = this.assertAuthenticated(actor);
    const project = state.projects[projectId];
    if (!project) {
      throw new DomainError("NOT_FOUND", `Project '${projectId}' not found.`);
    }
    const role = project.members[authActor.actorId];
    if (!role) {
      throw new DomainError(
        "FORBIDDEN",
        `Actor '${authActor.actorId}' is not a member of project '${projectId}'.`,
      );
    }
    if (required === "writer" && role !== "writer") {
      throw new DomainError(
        "FORBIDDEN",
        `Actor '${authActor.actorId}' has 'reader' permission and cannot modify project '${projectId}'.`,
      );
    }
    return { actor: authActor, project };
  }

  private buildValidationContext(
    state: DomainStateSnapshot,
    projectId: string,
  ): {
    availableAssets: Set<string>;
    availableSubjects: Map<string, SubjectSnapshot>;
  } {
    const availableAssets = new Set<string>();
    for (const asset of Object.values(state.assets)) {
      if (asset.projectId === projectId) {
        availableAssets.add(asset.id);
      }
    }

    const availableSubjects = new Map<string, SubjectSnapshot>();
    for (const subj of Object.values(state.subjects)) {
      if (subj.projectId === projectId) {
        for (const rev of Object.values(subj.revisions)) {
          availableSubjects.set(subjectRevisionKey(subj.id, rev.revision), rev);
        }
      }
    }

    return { availableAssets, availableSubjects };
  }

  async createProject(
    actor: ActorIdentity | null | undefined,
    input: {
      id: string;
      name: string;
      description?: string;
      members?: Record<string, ProjectRole>;
    },
  ): Promise<ProjectRecord> {
    const authActor = this.assertAuthenticated(actor);
    if (!input.id?.trim() || !input.name?.trim()) {
      throw new DomainError("VALIDATION_FAILED", "Project id and name are required.");
    }

    return this.store.runInTransaction("createProject", (draft) => {
      if (draft.projects[input.id]) {
        throw new DomainError("ALREADY_EXISTS", `Project '${input.id}' already exists.`);
      }
      const now = new Date().toISOString();
      const members: Record<string, ProjectRole> = {
        ...(input.members ?? {}),
        [authActor.actorId]: "writer",
      };
      const record: ProjectRecord = {
        id: input.id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        createdAt: now,
        createdBy: authActor.actorId,
        members,
      };
      draft.projects[input.id] = record;
      return record;
    });
  }

  async setProjectMemberRole(
    actor: ActorIdentity | null | undefined,
    input: { projectId: string; targetActorId: string; role: ProjectRole | null },
  ): Promise<ProjectRecord> {
    return this.store.runInTransaction("setProjectMemberRole", (draft) => {
      const { project } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      if (input.role === null) {
        delete project.members[input.targetActorId];
      } else {
        project.members[input.targetActorId] = input.role;
      }
      return project;
    });
  }

  async listProjects(actor: ActorIdentity | null | undefined): Promise<ProjectRecord[]> {
    const authActor = this.assertAuthenticated(actor);
    const state = await this.store.readState();
    return Object.values(state.projects).filter(
      (p) => p.members[authActor.actorId] !== undefined,
    );
  }

  async getProject(
    actor: ActorIdentity | null | undefined,
    projectId: string,
  ): Promise<ProjectRecord> {
    const state = await this.store.readState();
    const { project } = this.assertProjectPermission(state, projectId, actor, "reader");
    return project;
  }

  // ==================== ASSET MANAGEMENT ====================

  async prepareAssetUpload(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      assetId: string;
      sha256: string;
      mimeType: string;
      sizeBytes: number;
      width?: number;
      height?: number;
      durationFrames?: number;
      lineage?: Record<string, unknown>;
    },
  ): Promise<UploadSessionRecord> {
    if (!input.assetId?.trim() || /^https?:\/\//i.test(input.assetId)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "assetId must be a non-empty stable identifier, not a URL.",
      );
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "sha256 must be a valid 64-character hex SHA-256 digest.",
      );
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new DomainError("VALIDATION_FAILED", "sizeBytes must be a positive integer.");
    }
    if (!input.mimeType?.trim()) {
      throw new DomainError("VALIDATION_FAILED", "mimeType is required.");
    }

    return this.store.runInTransaction("prepareAssetUpload", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      const aKey = compositeKey(input.projectId, input.assetId);
      const existing = draft.assets[aKey];
      if (existing) {
        if (existing.sha256.toLowerCase() !== input.sha256.toLowerCase()) {
          throw new DomainError(
            "IMMUTABILITY_VIOLATION",
            `Asset '${input.assetId}' already exists with a different SHA-256 digest. Never overwrite referenced media in place.`,
          );
        }
      }

      const sessionId = `upload-${input.projectId}-${input.assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const storageKey = `projects/${input.projectId}/assets/${input.sha256.toLowerCase()}`;
      const session: UploadSessionRecord = {
        sessionId,
        projectId: input.projectId,
        assetId: input.assetId,
        expectedSha256: input.sha256.toLowerCase(),
        mimeType: input.mimeType,
        expectedSizeBytes: input.sizeBytes,
        storageKey,
        status: "pending",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        createdBy: authActor.actorId,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.durationFrames !== undefined
          ? { durationFrames: input.durationFrames }
          : {}),
        ...(input.lineage ? { lineage: structuredClone(input.lineage) } : {}),
      };
      draft.uploadSessions[sessionId] = session;
      return session;
    });
  }

  async putUploadSessionBytes(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      sessionId: string;
      bytes: Uint8Array;
    },
  ): Promise<void> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, input.projectId, actor, "writer");
    const session = state.uploadSessions[input.sessionId];
    if (!session || session.projectId !== input.projectId) {
      throw new DomainError("NOT_FOUND", `Upload session '${input.sessionId}' not found.`);
    }
    if (session.status !== "pending") {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Upload session '${input.sessionId}' is in status '${session.status}'.`,
      );
    }
    await this.store.bucket.put(session.storageKey, input.bytes, session.mimeType);
  }

  async finalizeAssetUpload(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      sessionId: string;
    },
  ): Promise<AssetRecord> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, input.projectId, actor, "writer");
    const session = state.uploadSessions[input.sessionId];
    if (!session || session.projectId !== input.projectId) {
      throw new DomainError("NOT_FOUND", `Upload session '${input.sessionId}' not found.`);
    }

    const storedObj = await this.store.bucket.get(session.storageKey);
    if (!storedObj) {
      await this.store.runInTransaction("markUploadFailed", (draft) => {
        if (draft.uploadSessions[input.sessionId]) {
          draft.uploadSessions[input.sessionId].status = "failed";
        }
      });
      throw new DomainError(
        "ASSET_INTEGRITY_ERROR",
        `Uploaded R2 object missing for session '${input.sessionId}'.`,
      );
    }

    const actualSha256 = await computeSha256Hex(storedObj.data);
    const actualSize = storedObj.data.byteLength;
    if (
      actualSha256 !== session.expectedSha256 ||
      actualSize !== session.expectedSizeBytes
    ) {
      const otherFinalizedUsingSameKey = Object.values(state.assets).some(
        (a) => a.storageKey === session.storageKey,
      );
      if (!otherFinalizedUsingSameKey) {
        await this.store.bucket.delete(session.storageKey);
      }
      await this.store.runInTransaction("markUploadFailed", (draft) => {
        if (draft.uploadSessions[input.sessionId]) {
          draft.uploadSessions[input.sessionId].status = "failed";
        }
      });
      throw new DomainError(
        "ASSET_INTEGRITY_ERROR",
        `Asset integrity check failed: expected sha256=${session.expectedSha256} (${session.expectedSizeBytes}B), got sha256=${actualSha256} (${actualSize}B).`,
      );
    }

    return this.store.runInTransaction("finalizeAssetUpload", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      const aKey = compositeKey(input.projectId, session.assetId);
      const existing = draft.assets[aKey];
      if (existing) {
        if (existing.sha256 !== session.expectedSha256) {
          throw new DomainError(
            "IMMUTABILITY_VIOLATION",
            `Asset '${session.assetId}' already registered with different content.`,
          );
        }
        draft.uploadSessions[input.sessionId].status = "finalized";
        return existing;
      }

      const record: AssetRecord = {
        id: session.assetId,
        projectId: session.projectId,
        sha256: session.expectedSha256,
        mimeType: session.mimeType,
        sizeBytes: session.expectedSizeBytes,
        storageKey: session.storageKey,
        ...(session.width !== undefined ? { width: session.width } : {}),
        ...(session.height !== undefined ? { height: session.height } : {}),
        ...(session.durationFrames !== undefined
          ? { durationFrames: session.durationFrames }
          : {}),
        ...(session.lineage ? { lineage: structuredClone(session.lineage) } : {}),
        createdAt: new Date().toISOString(),
        createdBy: authActor.actorId,
      };
      draft.assets[aKey] = record;
      draft.uploadSessions[input.sessionId].status = "finalized";
      return record;
    });
  }

  async registerAssetDirect(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      assetId: string;
      bytes: Uint8Array;
      expectedSha256?: string;
      mimeType: string;
      width?: number;
      height?: number;
      durationFrames?: number;
      lineage?: Record<string, unknown>;
    },
  ): Promise<AssetRecord> {
    const sha256 = input.expectedSha256 ?? (await computeSha256Hex(input.bytes));
    const session = await this.prepareAssetUpload(actor, {
      projectId: input.projectId,
      assetId: input.assetId,
      sha256,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      width: input.width,
      height: input.height,
      durationFrames: input.durationFrames,
      lineage: input.lineage,
    });
    await this.putUploadSessionBytes(actor, {
      projectId: input.projectId,
      sessionId: session.sessionId,
      bytes: input.bytes,
    });
    return this.finalizeAssetUpload(actor, {
      projectId: input.projectId,
      sessionId: session.sessionId,
    });
  }

  async listAssets(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    query?: { mimePrefix?: string },
  ): Promise<AssetRecord[]> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    return Object.values(state.assets).filter((a) => {
      if (a.projectId !== projectId) return false;
      if (query?.mimePrefix && !a.mimeType.startsWith(query.mimePrefix)) return false;
      return true;
    });
  }

  async getAsset(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    assetId: string,
  ): Promise<AssetRecord> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    const asset = state.assets[compositeKey(projectId, assetId)];
    if (!asset) {
      throw new DomainError(
        "NOT_FOUND",
        `Asset '${assetId}' not found in project '${projectId}'.`,
      );
    }
    return asset;
  }

  async deleteAsset(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    assetId: string,
  ): Promise<{ deletedAssetId: string }> {
    return this.store.runInTransaction("deleteAsset", (draft) => {
      this.assertProjectPermission(draft, projectId, actor, "writer");
      const aKey = compositeKey(projectId, assetId);
      const asset = draft.assets[aKey];
      if (!asset) {
        throw new DomainError("NOT_FOUND", `Asset '${assetId}' not found.`);
      }

      for (const subj of Object.values(draft.subjects)) {
        if (subj.projectId !== projectId) continue;
        for (const rev of Object.values(subj.revisions)) {
          for (const variant of Object.values(rev.variants)) {
            if (variant.referencePack.some((r) => r.asset === assetId)) {
              throw new DomainError(
                "DEPENDENCY_ERROR",
                `Cannot delete asset '${assetId}': referenced by subject '${subj.id}' revision ${rev.revision}.`,
              );
            }
          }
        }
      }

      for (const comp of Object.values(draft.compositions)) {
        if (comp.projectId !== projectId) continue;
        for (const rev of Object.values(comp.revisions)) {
          const doc = rev.document;
          if (doc.audioTracks.some((t) => t.asset === assetId)) {
            throw new DomainError(
              "DEPENDENCY_ERROR",
              `Cannot delete asset '${assetId}': referenced by audioTrack in composition '${comp.id}' revision ${rev.revision}.`,
            );
          }
          for (const [shotId, shot] of Object.entries(doc.shots)) {
            const usedInRefs =
              shot.references.images.some((i) => i.asset === assetId) ||
              shot.references.videos.some((v) => v.asset === assetId);
            const usedInCandidates =
              shot.candidates.images.some((i) => i.asset === assetId) ||
              shot.candidates.videos.some((v) => v.asset === assetId) ||
              shot.candidates.audios.some((a) => a.asset === assetId);
            const usedInSelected =
              shot.selected.video === assetId || shot.selected.audio === assetId;
            if (usedInRefs || usedInCandidates || usedInSelected) {
              throw new DomainError(
                "DEPENDENCY_ERROR",
                `Cannot delete asset '${assetId}': referenced by shot '${shotId}' in composition '${comp.id}' revision ${rev.revision}.`,
              );
            }
          }
        }
      }

      delete draft.assets[aKey];
      return { deletedAssetId: assetId };
    });
  }

  // ==================== SUBJECT & REFERENCE PACK MANAGEMENT ====================

  async createSubject(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      id: string;
      kind: SubjectKind;
      name: string;
      defaultVariant?: string;
      status?: RevisionStatus;
      definition: {
        description: string;
        invariants: string[];
      };
      variants: Record<string, SubjectVariant>;
    },
  ): Promise<SubjectRecord> {
    return this.store.runInTransaction("createSubject", (draft) => {
      this.assertProjectPermission(draft, input.projectId, actor, "writer");
      const sKey = compositeKey(input.projectId, input.id);
      if (draft.subjects[sKey]) {
        throw new DomainError(
          "ALREADY_EXISTS",
          `Subject '${input.id}' already exists in project '${input.projectId}'.`,
        );
      }

      const { availableAssets } = this.buildValidationContext(draft, input.projectId);
      const status: RevisionStatus = input.status ?? "candidate";
      const { snapshot, errors } = validateSubjectSnapshot(
        {
          id: input.id,
          kind: input.kind,
          revision: 1,
          status,
          name: input.name,
          defaultVariant: input.defaultVariant,
          definition: input.definition,
          variants: input.variants,
        },
        "$.subject",
        { availableAssets },
      );

      if (errors.length > 0 || !snapshot) {
        throw new DomainError(
          "VALIDATION_FAILED",
          errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors },
        );
      }

      const record: SubjectRecord = {
        id: snapshot.id,
        projectId: input.projectId,
        kind: snapshot.kind,
        name: snapshot.name,
        latestRevision: 1,
        latestApprovedRevision: status === "approved" ? 1 : null,
        revisions: { 1: snapshot },
        updatedAt: new Date().toISOString(),
      };
      draft.subjects[sKey] = record;
      draft.subjectChanges[sKey] = [];
      return record;
    });
  }

  async patchSubject(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      subjectId: string;
      baseRevision: number;
      operationId: string;
      changes: SubjectPatchChanges;
    },
  ): Promise<SubjectSnapshot> {
    return this.store.runInTransaction("patchSubject", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      const idemKey = `subject_patch::${input.projectId}::${input.operationId}`;
      if (draft.idempotencyRecords[idemKey]) {
        return draft.idempotencyRecords[idemKey] as SubjectSnapshot;
      }

      const sKey = compositeKey(input.projectId, input.subjectId);
      const subject = draft.subjects[sKey];
      if (!subject) {
        throw new DomainError(
          "NOT_FOUND",
          `Subject '${input.subjectId}' not found in project '${input.projectId}'.`,
        );
      }

      if (!subject.revisions[input.baseRevision]) {
        throw new DomainError(
          "VALIDATION_FAILED",
          `Base revision ${input.baseRevision} does not exist on subject '${input.subjectId}'.`,
        );
      }

      const touchedPaths: string[] = [];
      if (input.changes.name !== undefined) touchedPaths.push("name");
      if (input.changes.defaultVariant !== undefined)
        touchedPaths.push("defaultVariant");
      if (input.changes.description !== undefined)
        touchedPaths.push("definition.description");
      if (input.changes.invariants !== undefined)
        touchedPaths.push("definition.invariants");
      if (input.changes.variants) {
        for (const vKey of Object.keys(input.changes.variants)) {
          touchedPaths.push(`variants.${vKey}`);
        }
      }

      const history = draft.subjectChanges[sKey] ?? [];
      if (input.baseRevision < subject.latestRevision) {
        const intervening = history.filter(
          (c) => c.resultRevision > input.baseRevision,
        );
        const conflicts: ConflictDetail[] = [];
        for (const prior of intervening) {
          for (const p1 of touchedPaths) {
            for (const p2 of prior.touchedPaths) {
              if (pathsOverlap(p1, p2)) {
                conflicts.push({
                  path: p1,
                  baseRevision: input.baseRevision,
                  headRevision: subject.latestRevision,
                  competingActorId: prior.actorId,
                  reason: `Subject field '${p1}' was concurrently modified in revision ${prior.resultRevision} by '${prior.actorId}'.`,
                });
              }
            }
          }
        }
        if (conflicts.length > 0) {
          throw new DomainError(
            "REVISION_CONFLICT",
            `Concurrent edit conflict on subject '${input.subjectId}'.`,
            { conflicts },
          );
        }
      }

      const headSnap = structuredClone(subject.revisions[subject.latestRevision]);
      const nextRevision = subject.latestRevision + 1;
      const mergedVariants = {
        ...headSnap.variants,
        ...(input.changes.variants ? structuredClone(input.changes.variants) : {}),
      };

      const candidateRaw: SubjectSnapshot = {
        id: subject.id,
        kind: subject.kind,
        revision: nextRevision,
        status: "candidate",
        name: input.changes.name ?? headSnap.name,
        defaultVariant: input.changes.defaultVariant ?? headSnap.defaultVariant,
        definition: {
          description: input.changes.description ?? headSnap.definition.description,
          invariants: input.changes.invariants
            ? [...input.changes.invariants]
            : [...headSnap.definition.invariants],
        },
        variants: mergedVariants,
        ...(headSnap.extensions ? { extensions: headSnap.extensions } : {}),
      };

      const { availableAssets } = this.buildValidationContext(draft, input.projectId);
      const { snapshot, errors } = validateSubjectSnapshot(
        candidateRaw,
        "$.subject",
        { availableAssets },
      );
      if (errors.length > 0 || !snapshot) {
        throw new DomainError(
          "VALIDATION_FAILED",
          errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors },
        );
      }

      subject.revisions[nextRevision] = snapshot;
      subject.latestRevision = nextRevision;
      subject.name = snapshot.name;
      subject.updatedAt = new Date().toISOString();

      history.push({
        id: `subj-chg-${nextRevision}`,
        projectId: input.projectId,
        subjectId: subject.id,
        baseRevision: input.baseRevision,
        resultRevision: nextRevision,
        operationId: input.operationId,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        touchedPaths,
        createdAt: subject.updatedAt,
      });
      draft.subjectChanges[sKey] = history;
      draft.idempotencyRecords[idemKey] = snapshot;
      return snapshot;
    });
  }

  async attachSubjectReference(
    actor: ActorIdentity | null | undefined,
    input: AttachSubjectReferenceInput,
  ): Promise<SubjectSnapshot> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, input.projectId, actor, "writer");
    const sKey = compositeKey(input.projectId, input.subjectId);
    const subject = state.subjects[sKey];
    if (!subject) {
      throw new DomainError("NOT_FOUND", `Subject '${input.subjectId}' not found.`);
    }
    const headSnap = subject.revisions[subject.latestRevision];
    const existingVariant = headSnap.variants[input.variant] ?? {
      description: `${input.variant} variant`,
      referencePack: [],
    };
    const nextPack: ReferencePackEntry[] = [
      ...existingVariant.referencePack,
      {
        asset: input.entry.asset,
        status: input.entry.status ?? "candidate",
        ...(input.entry.view ? { view: input.entry.view } : {}),
        ...(input.entry.purpose ? { purpose: input.entry.purpose } : {}),
        ...(input.entry.notes ? { notes: input.entry.notes } : {}),
        ...(input.entry.provenance ? { provenance: input.entry.provenance } : {}),
      },
    ];

    return this.patchSubject(actor, {
      projectId: input.projectId,
      subjectId: input.subjectId,
      baseRevision: input.baseRevision,
      operationId: input.operationId,
      changes: {
        variants: {
          [input.variant]: {
            description: existingVariant.description,
            referencePack: nextPack,
          },
        },
      },
    });
  }

  async approveSubjectRevision(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      subjectId: string;
      revision: number;
      operationId: string;
    },
  ): Promise<SubjectSnapshot> {
    return this.store.runInTransaction("approveSubjectRevision", (draft) => {
      this.assertProjectPermission(draft, input.projectId, actor, "writer");
      const idemKey = `subject_approve::${input.projectId}::${input.operationId}`;
      if (draft.idempotencyRecords[idemKey]) {
        return draft.idempotencyRecords[idemKey] as SubjectSnapshot;
      }

      const sKey = compositeKey(input.projectId, input.subjectId);
      const subject = draft.subjects[sKey];
      if (!subject) {
        throw new DomainError("NOT_FOUND", `Subject '${input.subjectId}' not found.`);
      }
      const targetRev = subject.revisions[input.revision];
      if (!targetRev) {
        throw new DomainError(
          "NOT_FOUND",
          `Revision ${input.revision} not found on subject '${input.subjectId}'.`,
        );
      }

      const promoted = structuredClone(targetRev);
      promoted.status = "approved";
      for (const variant of Object.values(promoted.variants)) {
        for (const item of variant.referencePack) {
          item.status = "approved";
        }
      }

      const { availableAssets } = this.buildValidationContext(draft, input.projectId);
      const { snapshot, errors } = validateSubjectSnapshot(promoted, "$.subject", {
        availableAssets,
      });
      if (errors.length > 0 || !snapshot) {
        throw new DomainError(
          "VALIDATION_FAILED",
          errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors },
        );
      }

      subject.revisions[input.revision] = snapshot;
      subject.latestApprovedRevision = Math.max(
        subject.latestApprovedRevision ?? 0,
        input.revision,
      );
      subject.updatedAt = new Date().toISOString();
      draft.idempotencyRecords[idemKey] = snapshot;
      return snapshot;
    });
  }

  async listSubjects(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    kind?: SubjectKind,
  ): Promise<SubjectRecord[]> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    return Object.values(state.subjects).filter(
      (s) => s.projectId === projectId && (!kind || s.kind === kind),
    );
  }

  async getSubject(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    subjectId: string,
    revision?: number,
  ): Promise<{ subject: SubjectRecord; snapshot: SubjectSnapshot }> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    const subject = state.subjects[compositeKey(projectId, subjectId)];
    if (!subject) {
      throw new DomainError("NOT_FOUND", `Subject '${subjectId}' not found.`);
    }
    const targetRev = revision ?? subject.latestRevision;
    const snapshot = subject.revisions[targetRev];
    if (!snapshot) {
      throw new DomainError(
        "NOT_FOUND",
        `Revision ${targetRev} not found on subject '${subjectId}'.`,
      );
    }
    return { subject, snapshot };
  }

  async getSubjectUsage(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    subjectId: string,
  ): Promise<
    Array<{
      compositionId: string;
      compositionRevision: number;
      shotId: string;
      subjectRevision: number;
      resolvedVariant: string;
    }>
  > {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    const sKey = compositeKey(projectId, subjectId);
    const subject = state.subjects[sKey];
    if (!subject) {
      throw new DomainError("NOT_FOUND", `Subject '${subjectId}' not found.`);
    }

    const usage: Array<{
      compositionId: string;
      compositionRevision: number;
      shotId: string;
      subjectRevision: number;
      resolvedVariant: string;
    }> = [];

    for (const comp of Object.values(state.compositions)) {
      if (comp.projectId !== projectId) continue;
      const head = comp.revisions[comp.headRevision];
      if (!head) continue;
      for (const [shotId, shot] of Object.entries(head.document.shots)) {
        for (const binding of shot.subjects) {
          if (binding.subjectId === subjectId) {
            const revSnap = subject.revisions[binding.subjectRevision];
            usage.push({
              compositionId: comp.id,
              compositionRevision: head.revision,
              shotId,
              subjectRevision: binding.subjectRevision,
              resolvedVariant:
                binding.variant ?? revSnap?.defaultVariant ?? "unknown",
            });
          }
        }
      }
    }

    return usage;
  }

  // ==================== COMPOSITION & CONCURRENT REVISIONS ====================

  private assertApprovedSubjectBindings(
    state: DomainStateSnapshot,
    projectId: string,
    doc: CompositionDocument,
  ): void {
    for (const [shotId, shot] of Object.entries(doc.shots)) {
      for (const binding of shot.subjects) {
        const sKey = compositeKey(projectId, binding.subjectId);
        const subject = state.subjects[sKey];
        const snap = subject?.revisions[binding.subjectRevision];
        if (!snap) {
          throw new DomainError(
            "DEPENDENCY_ERROR",
            `Shot '${shotId}' references missing subject revision '${binding.subjectId}@${binding.subjectRevision}'.`,
          );
        }
        if (snap.status !== "approved") {
          throw new DomainError(
            "DEPENDENCY_ERROR",
            `Shot '${shotId}' cannot bind unapproved candidate subject revision '${binding.subjectId}@${binding.subjectRevision}'. Approve the revision first.`,
          );
        }
        const resolvedVariant = binding.variant ?? snap.defaultVariant;
        if (!resolvedVariant || !(resolvedVariant in snap.variants)) {
          throw new DomainError(
            "DEPENDENCY_ERROR",
            `Shot '${shotId}' references unknown variant '${resolvedVariant ?? "(omitted)"}' on '${binding.subjectId}@${binding.subjectRevision}'.`,
          );
        }
      }
    }
  }

  async createComposition(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      document: CompositionDocument;
      operationId?: string;
    },
  ): Promise<CompositionRevisionRecord> {
    return this.store.runInTransaction("createComposition", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );

      if (input.document.project !== input.projectId) {
        throw new DomainError(
          "VALIDATION_FAILED",
          `Composition document.project ('${input.document.project}') must match projectId ('${input.projectId}').`,
        );
      }

      const cKey = compositeKey(input.projectId, input.document.id);
      if (draft.compositions[cKey]) {
        throw new DomainError(
          "ALREADY_EXISTS",
          `Composition '${input.document.id}' already exists in project '${input.projectId}'.`,
        );
      }

      const context = this.buildValidationContext(draft, input.projectId);
      const validated = validateCompositionDocument(input.document, context);
      if (!validated.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors: validated.errors },
        );
      }

      this.assertApprovedSubjectBindings(draft, input.projectId, validated.value);

      const now = new Date().toISOString();
      const revRecord: CompositionRevisionRecord = {
        compositionId: validated.value.id,
        projectId: input.projectId,
        revision: 1,
        parentRevision: null,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        operationId: input.operationId ?? `init-${validated.value.id}`,
        message: "Initial composition revision",
        createdAt: now,
        document: validated.value,
      };

      draft.compositions[cKey] = {
        id: validated.value.id,
        projectId: input.projectId,
        title: validated.value.title,
        headRevision: 1,
        revisions: { 1: revRecord },
      };
      draft.changes[cKey] = [];
      return revRecord;
    });
  }

  async listCompositions(
    actor: ActorIdentity | null | undefined,
    projectId: string,
  ): Promise<
    Array<{
      id: string;
      projectId: string;
      title?: string;
      headRevision: number;
    }>
  > {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    return Object.values(state.compositions)
      .filter((c) => c.projectId === projectId)
      .map((c) => ({
        id: c.id,
        projectId: c.projectId,
        title: c.title,
        headRevision: c.headRevision,
      }));
  }

  async getComposition(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    compositionId: string,
    revision?: number,
  ): Promise<{
    headRevision: number;
    revisionRecord: CompositionRevisionRecord;
    resolvedSubjects: Record<
      string,
      {
        subjectId: string;
        subjectRevision: number;
        resolvedVariant: string;
        referencePack: ReferencePackEntry[];
        snapshot: SubjectSnapshot;
      }
    >;
  }> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    const comp = state.compositions[compositeKey(projectId, compositionId)];
    if (!comp) {
      throw new DomainError(
        "NOT_FOUND",
        `Composition '${compositionId}' not found in project '${projectId}'.`,
      );
    }
    const targetRev = revision ?? comp.headRevision;
    const revRecord = comp.revisions[targetRev];
    if (!revRecord) {
      throw new DomainError(
        "NOT_FOUND",
        `Revision ${targetRev} not found on composition '${compositionId}'.`,
      );
    }

    const resolvedSubjects: Record<
      string,
      {
        subjectId: string;
        subjectRevision: number;
        resolvedVariant: string;
        referencePack: ReferencePackEntry[];
        snapshot: SubjectSnapshot;
      }
    > = {};

    for (const shot of Object.values(revRecord.document.shots)) {
      for (const binding of shot.subjects) {
        const subj = state.subjects[compositeKey(projectId, binding.subjectId)];
        const snap = subj?.revisions[binding.subjectRevision];
        if (snap) {
          const resolvedVariant =
            binding.variant ?? snap.defaultVariant ?? Object.keys(snap.variants)[0];
          const variantObj = snap.variants[resolvedVariant];
          const key = `${binding.subjectId}@${binding.subjectRevision}#${resolvedVariant}`;
          resolvedSubjects[key] = {
            subjectId: binding.subjectId,
            subjectRevision: binding.subjectRevision,
            resolvedVariant,
            referencePack: variantObj ? variantObj.referencePack : [],
            snapshot: snap,
          };
        }
      }
    }

    return {
      headRevision: comp.headRevision,
      revisionRecord: revRecord,
      resolvedSubjects,
    };
  }

  async patchComposition(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      compositionId: string;
      baseRevision: number;
      operationId: string;
      operations: TypedOperation[];
      message?: string;
    },
  ): Promise<{
    revisionRecord: CompositionRevisionRecord;
    changeRecord: ChangeRecord;
  }> {
    if (!input.operationId?.trim()) {
      throw new DomainError("VALIDATION_FAILED", "operationId (idempotency key) is required.");
    }
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "operations must be a non-empty array.");
    }

    return this.store.runInTransaction("patchComposition", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );

      const idemKey = `comp_patch::${input.projectId}::${input.compositionId}::${input.operationId}`;
      if (draft.idempotencyRecords[idemKey]) {
        return draft.idempotencyRecords[idemKey] as {
          revisionRecord: CompositionRevisionRecord;
          changeRecord: ChangeRecord;
        };
      }

      const cKey = compositeKey(input.projectId, input.compositionId);
      const comp = draft.compositions[cKey];
      if (!comp) {
        throw new DomainError(
          "NOT_FOUND",
          `Composition '${input.compositionId}' not found.`,
        );
      }

      if (!comp.revisions[input.baseRevision]) {
        throw new DomainError(
          "VALIDATION_FAILED",
          `baseRevision ${input.baseRevision} does not exist on composition '${input.compositionId}'.`,
        );
      }

      const history = draft.changes[cKey] ?? [];
      let autoMergedFromStaleBase = false;
      if (input.baseRevision < comp.headRevision) {
        const interveningChanges = history.filter(
          (c) => c.resultRevision > input.baseRevision,
        );
        const conflicts = detectConflictsAgainstHistory(
          input.operations,
          input.baseRevision,
          comp.headRevision,
          interveningChanges,
        );
        if (conflicts.length > 0) {
          throw new DomainError(
            "REVISION_CONFLICT",
            `Conflicting concurrent edits detected against head revision ${comp.headRevision}.`,
            {
              baseRevision: input.baseRevision,
              headRevision: comp.headRevision,
              conflicts,
            },
          );
        }
        autoMergedFromStaleBase = true;
      }

      const headDoc = comp.revisions[comp.headRevision].document;
      const updatedDoc = applyTypedOperations(headDoc, input.operations);
      const context = this.buildValidationContext(draft, input.projectId);
      const validated = validateCompositionDocument(updatedDoc, context);
      if (!validated.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors: validated.errors },
        );
      }

      this.assertApprovedSubjectBindings(draft, input.projectId, validated.value);

      const nextRevision = comp.headRevision + 1;
      const now = new Date().toISOString();
      const revisionRecord: CompositionRevisionRecord = {
        compositionId: comp.id,
        projectId: input.projectId,
        revision: nextRevision,
        parentRevision: comp.headRevision,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        operationId: input.operationId,
        ...(input.message ? { message: input.message } : {}),
        createdAt: now,
        document: validated.value,
      };

      const touchedPaths = input.operations.flatMap(computeOperationPaths);
      const changeRecord: ChangeRecord = {
        id: `chg-${comp.id}-${nextRevision}`,
        projectId: input.projectId,
        compositionId: comp.id,
        baseRevision: input.baseRevision,
        resultRevision: nextRevision,
        operationId: input.operationId,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        operations: structuredClone(input.operations),
        touchedPaths,
        autoMergedFromStaleBase,
        createdAt: now,
      };

      comp.revisions[nextRevision] = revisionRecord;
      comp.headRevision = nextRevision;
      comp.title = validated.value.title;
      history.push(changeRecord);
      draft.changes[cKey] = history;

      const output = { revisionRecord, changeRecord };
      draft.idempotencyRecords[idemKey] = output;
      return output;
    });
  }

  async listCompositionHistory(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    compositionId: string,
  ): Promise<{
    revisions: CompositionRevisionRecord[];
    changes: ChangeRecord[];
  }> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    const cKey = compositeKey(projectId, compositionId);
    const comp = state.compositions[cKey];
    if (!comp) {
      throw new DomainError("NOT_FOUND", `Composition '${compositionId}' not found.`);
    }
    const revisions = Object.values(comp.revisions).sort(
      (a, b) => a.revision - b.revision,
    );
    const changes = [...(state.changes[cKey] ?? [])];
    return { revisions, changes };
  }

  async restoreCompositionRevision(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      compositionId: string;
      targetRevision: number;
      operationId: string;
    },
  ): Promise<CompositionRevisionRecord> {
    return this.store.runInTransaction("restoreCompositionRevision", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      const cKey = compositeKey(input.projectId, input.compositionId);
      const comp = draft.compositions[cKey];
      if (!comp) {
        throw new DomainError("NOT_FOUND", `Composition '${input.compositionId}' not found.`);
      }
      const historical = comp.revisions[input.targetRevision];
      if (!historical) {
        throw new DomainError(
          "NOT_FOUND",
          `Target revision ${input.targetRevision} not found on '${input.compositionId}'.`,
        );
      }

      const nextRevision = comp.headRevision + 1;
      const now = new Date().toISOString();
      const restoredRecord: CompositionRevisionRecord = {
        compositionId: comp.id,
        projectId: input.projectId,
        revision: nextRevision,
        parentRevision: comp.headRevision,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        operationId: input.operationId,
        message: `Restored from revision ${input.targetRevision}`,
        createdAt: now,
        document: structuredClone(historical.document),
      };

      comp.revisions[nextRevision] = restoredRecord;
      comp.headRevision = nextRevision;
      return restoredRecord;
    });
  }

  // ==================== PROPOSALS (REVIEW WORKFLOW) ====================

  async submitProposal(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      compositionId: string;
      baseRevision: number;
      operationId: string;
      description: string;
      operations: TypedOperation[];
    },
  ): Promise<ProposalRecord> {
    return this.store.runInTransaction("submitProposal", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      const cKey = compositeKey(input.projectId, input.compositionId);
      const comp = draft.compositions[cKey];
      if (!comp || !comp.revisions[input.baseRevision]) {
        throw new DomainError(
          "NOT_FOUND",
          `Composition '${input.compositionId}' at baseRevision ${input.baseRevision} not found.`,
        );
      }

      const previewDoc = applyTypedOperations(
        comp.revisions[input.baseRevision].document,
        input.operations,
      );
      const context = this.buildValidationContext(draft, input.projectId);
      const validated = validateCompositionDocument(previewDoc, context);
      if (!validated.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors: validated.errors },
        );
      }
      this.assertApprovedSubjectBindings(draft, input.projectId, validated.value);

      const proposalId = `prop-${input.compositionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const proposal: ProposalRecord = {
        id: proposalId,
        projectId: input.projectId,
        compositionId: input.compositionId,
        baseRevision: input.baseRevision,
        operationId: input.operationId,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        description: input.description,
        operations: structuredClone(input.operations),
        status: "open",
        createdAt: new Date().toISOString(),
      };
      draft.proposals[compositeKey(input.projectId, proposalId)] = proposal;
      return proposal;
    });
  }

  async approveProposal(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      proposalId: string;
      operationId: string;
    },
  ): Promise<{
    proposal: ProposalRecord;
    revisionRecord: CompositionRevisionRecord;
  }> {
    const state = await this.store.readState();
    const { actor: authActor } = this.assertProjectPermission(
      state,
      input.projectId,
      actor,
      "writer",
    );
    const pKey = compositeKey(input.projectId, input.proposalId);
    const proposal = state.proposals[pKey];
    if (!proposal) {
      throw new DomainError("NOT_FOUND", `Proposal '${input.proposalId}' not found.`);
    }
    if (proposal.status !== "open") {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Proposal '${input.proposalId}' is already '${proposal.status}'.`,
      );
    }

    const patchResult = await this.patchComposition(authActor, {
      projectId: input.projectId,
      compositionId: proposal.compositionId,
      baseRevision: proposal.baseRevision,
      operationId: input.operationId,
      operations: proposal.operations,
      message: `Approved proposal ${proposal.id}: ${proposal.description}`,
    });

    return this.store.runInTransaction("finalizeProposalApproval", (draft) => {
      const target = draft.proposals[pKey];
      target.status = "approved";
      target.resultRevision = patchResult.revisionRecord.revision;
      target.reviewedBy = authActor.actorId;
      target.reviewedAt = new Date().toISOString();
      return {
        proposal: target,
        revisionRecord: patchResult.revisionRecord,
      };
    });
  }

  async listProposals(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    compositionId?: string,
  ): Promise<ProposalRecord[]> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, projectId, actor, "reader");
    return Object.values(state.proposals).filter(
      (p) =>
        p.projectId === projectId &&
        (!compositionId || p.compositionId === compositionId),
    );
  }

  // ==================== JSON / YAML PORTABLE INTERCHANGE ====================

  async exportCompositionBundle(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      compositionId: string;
      revision?: number;
      format: "json" | "yaml";
    },
  ): Promise<{ bundle: PortableCompositionBundle; serialized: string }> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, input.projectId, actor, "reader");
    const cKey = compositeKey(input.projectId, input.compositionId);
    const comp = state.compositions[cKey];
    if (!comp) {
      throw new DomainError(
        "NOT_FOUND",
        `Composition '${input.compositionId}' not found.`,
      );
    }
    const targetRev = input.revision ?? comp.headRevision;
    const revRecord = comp.revisions[targetRev];
    if (!revRecord) {
      throw new DomainError(
        "NOT_FOUND",
        `Revision ${targetRev} not found on '${input.compositionId}'.`,
      );
    }

    const doc = revRecord.document;
    const referencedAssetIds = new Set<string>();
    const referencedSubjects = new Map<string, SubjectSnapshot>();

    for (const track of doc.audioTracks) {
      referencedAssetIds.add(track.asset);
    }

    for (const shot of Object.values(doc.shots)) {
      for (const img of shot.references.images) referencedAssetIds.add(img.asset);
      for (const vid of shot.references.videos) referencedAssetIds.add(vid.asset);
      for (const img of shot.candidates.images) referencedAssetIds.add(img.asset);
      for (const vid of shot.candidates.videos) referencedAssetIds.add(vid.asset);
      for (const aud of shot.candidates.audios) referencedAssetIds.add(aud.asset);
      if (shot.selected.video) referencedAssetIds.add(shot.selected.video);
      if (shot.selected.audio) referencedAssetIds.add(shot.selected.audio);

      for (const binding of shot.subjects) {
        const sKey = compositeKey(input.projectId, binding.subjectId);
        const subj = state.subjects[sKey];
        const snap = subj?.revisions[binding.subjectRevision];
        if (!snap) {
          throw new DomainError(
            "DEPENDENCY_ERROR",
            `Unresolved subject dependency '${binding.subjectId}@${binding.subjectRevision}' during export.`,
          );
        }
        referencedSubjects.set(
          subjectRevisionKey(binding.subjectId, binding.subjectRevision),
          snap,
        );
        for (const variant of Object.values(snap.variants)) {
          for (const ref of variant.referencePack) {
            referencedAssetIds.add(ref.asset);
          }
        }
      }
    }

    const assetsManifest: AssetManifestEntry[] = [];
    for (const assetId of Array.from(referencedAssetIds).sort()) {
      const asset = state.assets[compositeKey(input.projectId, assetId)];
      if (!asset) {
        throw new DomainError(
          "DEPENDENCY_ERROR",
          `Unresolved asset dependency '${assetId}' during export.`,
        );
      }
      assetsManifest.push({
        id: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
        ...(asset.durationFrames !== undefined
          ? { durationFrames: asset.durationFrames }
          : {}),
        ...(asset.lineage ? { lineage: asset.lineage } : {}),
      });
    }

    const bundle: PortableCompositionBundle = {
      apiVersion: PROTOCOL_VERSION,
      composition: doc,
      revision: revRecord.revision,
      dependencies: {
        subjects: Array.from(referencedSubjects.values()),
        assets: assetsManifest,
      },
    };

    return {
      bundle,
      serialized: serializeBundleInterchange(bundle, input.format),
    };
  }

  async importCompositionBundle(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      payload: string;
      format: "json" | "yaml";
      targetCompositionId?: string;
      operationId?: string;
    },
  ): Promise<CompositionRevisionRecord> {
    return this.store.runInTransaction("importCompositionBundle", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );

      const parsed = parseBundleInterchange(input.payload, input.format);
      if (!parsed.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors: parsed.errors },
        );
      }

      const bundle = parsed.value;
      const missingAssets: string[] = [];
      for (const assetDep of bundle.dependencies.assets) {
        const existingAsset = draft.assets[compositeKey(input.projectId, assetDep.id)];
        if (!existingAsset) {
          missingAssets.push(assetDep.id);
        } else if (existingAsset.sha256 !== assetDep.sha256) {
          throw new DomainError(
            "IMMUTABILITY_VIOLATION",
            `Asset '${assetDep.id}' in target project '${input.projectId}' has sha256=${existingAsset.sha256}, which conflicts with bundle sha256=${assetDep.sha256}.`,
          );
        }
      }

      if (missingAssets.length > 0) {
        throw new DomainError(
          "DEPENDENCY_ERROR",
          `Cannot import bundle: target project '${input.projectId}' is missing required assets: ${missingAssets.join(", ")}.`,
          { missingAssets },
        );
      }

      for (const subjSnap of bundle.dependencies.subjects) {
        const sKey = compositeKey(input.projectId, subjSnap.id);
        const existingSubj = draft.subjects[sKey];
        if (!existingSubj) {
          draft.subjects[sKey] = {
            id: subjSnap.id,
            projectId: input.projectId,
            kind: subjSnap.kind,
            name: subjSnap.name,
            latestRevision: subjSnap.revision,
            latestApprovedRevision:
              subjSnap.status === "approved" ? subjSnap.revision : null,
            revisions: { [subjSnap.revision]: structuredClone(subjSnap) },
            updatedAt: new Date().toISOString(),
          };
          draft.subjectChanges[sKey] = [];
        } else {
          const existingRev = existingSubj.revisions[subjSnap.revision];
          if (!existingRev) {
            existingSubj.revisions[subjSnap.revision] = structuredClone(subjSnap);
            existingSubj.latestRevision = Math.max(
              existingSubj.latestRevision,
              subjSnap.revision,
            );
            if (subjSnap.status === "approved") {
              existingSubj.latestApprovedRevision = Math.max(
                existingSubj.latestApprovedRevision ?? 0,
                subjSnap.revision,
              );
            }
          }
        }
      }

      const importedDoc: CompositionDocument = {
        ...structuredClone(bundle.composition),
        id: input.targetCompositionId ?? bundle.composition.id,
        project: input.projectId,
      };

      const context = this.buildValidationContext(draft, input.projectId);
      const validated = validateCompositionDocument(importedDoc, context);
      if (!validated.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors: validated.errors },
        );
      }

      this.assertApprovedSubjectBindings(draft, input.projectId, validated.value);

      const cKey = compositeKey(input.projectId, validated.value.id);
      const now = new Date().toISOString();
      const existingComp = draft.compositions[cKey];
      const nextRev = existingComp ? existingComp.headRevision + 1 : 1;
      const revRecord: CompositionRevisionRecord = {
        compositionId: validated.value.id,
        projectId: input.projectId,
        revision: nextRev,
        parentRevision: existingComp ? existingComp.headRevision : null,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        operationId: input.operationId ?? `import-${validated.value.id}-${nextRev}`,
        message: "Imported from portable bundle",
        createdAt: now,
        document: validated.value,
      };

      if (!existingComp) {
        draft.compositions[cKey] = {
          id: validated.value.id,
          projectId: input.projectId,
          title: validated.value.title,
          headRevision: 1,
          revisions: { 1: revRecord },
        };
        draft.changes[cKey] = [];
      } else {
        existingComp.revisions[nextRev] = revRecord;
        existingComp.headRevision = nextRev;
        existingComp.title = validated.value.title;
      }

      return revRecord;
    });
  }
}
