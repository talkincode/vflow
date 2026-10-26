import {
  LifecycleService,
  isTrashed,
  assertCompositionActive,
  inferProjectOwner,
  userIdOf,
  lifecycleRecord,
} from "./lifecycle.ts";
import {
  ReferenceAuthoringService,
  initialProjectPolicy,
  assertWorkflowContext,
  assertNoMotionReferenceAssets,
  assertStrictSubjectReferences,
  isStrictProject,
  materialRevision,
  validateMaterial,
} from "./authoring.ts";
import { imageDimensions } from "./image-metadata.ts";
import type { WorkflowContext } from "@vflow/protocol";
import {
  canonicalizeJson,
  type ActorIdentity,
  type AssetManifestEntry,
  type CompositionDocument,
  parseBundleInterchange,
  type PortableCompositionBundle,
  PROTOCOL_VERSION,
  type ProtocolVersion,
  isReferenceProtocolVersion,
  type ProjectRole,
  type ReferencePackEntry,
  type RevisionStatus,
  serializeBundleInterchange,
  subjectRevisionKey,
  type SubjectKind,
  type SubjectSnapshot,
  type SubjectVariant,
  materialAssetIds,
  materialPins,
  validateCompositionDocument,
  validateSubjectSnapshot,
} from "@vflow/protocol";
import {
  applyTypedOperations,
  computeOperationPaths,
  detectConflictsAgainstHistory,
  pathsOverlap,
} from "./patch.ts";
import {
  resourceKey,
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
  type ProjectOverview,
  type ProposalRecord,
  type SubjectPatchChanges,
  type SubjectRecord,
  type TypedOperation,
  type UploadSessionRecord,
} from "./types.ts";

function compositeKey(projectId: string, entityId: string): string {
  return resourceKey(projectId, entityId);
}

export class VFlowDomainService {
  readonly store: DomainStore;
  readonly lifecycle: LifecycleService;
  readonly authoring: ReferenceAuthoringService;

  constructor(store?: DomainStore) {
    this.store = store ?? new TransactionalMemoryStore();
    this.lifecycle = new LifecycleService(
      this.store,
      (state, projectId, actor, role, includeTrash) =>
        this.assertProjectPermission(
          state,
          projectId,
          actor,
          role,
          includeTrash,
        ),
    );
    this.authoring = new ReferenceAuthoringService(
      this.store,
      (state, projectId, actor, role) =>
        this.assertProjectPermission(state, projectId, actor, role),
    );
  }

  private assertAuthenticated(
    actor: ActorIdentity | null | undefined,
  ): ActorIdentity {
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
    includeTrash = false,
  ): { actor: ActorIdentity; project: ProjectRecord } {
    const authActor = this.assertAuthenticated(actor);
    const project = state.projects[projectId];
    if (!project) {
      throw new DomainError("NOT_FOUND", `Project '${projectId}' not found.`);
    }
    if (
      inferProjectOwner(project) !== userIdOf(authActor) &&
      !(project.sharingMode === "members" && project.members[authActor.actorId])
    )
      throw new DomainError(
        "FORBIDDEN",
        "This project belongs to another user.",
      );
    if (!includeTrash && isTrashed(state, projectId, "project", projectId))
      throw new DomainError(
        "RESOURCE_TRASHED",
        "Project is in the recycle bin. Restore it before accessing its contents.",
      );
    const role =
      authActor.actorId.toLowerCase() === inferProjectOwner(project)
        ? "writer"
        : project.members[authActor.actorId];
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
    availableMaterials: Map<
      string,
      import("@vflow/protocol").MaterialRevision
    >;
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

    const availableMaterials = new Map<
      string,
      import("@vflow/protocol").MaterialRevision
    >();
    for (const record of Object.values(state.materials))
      if (record.projectId === projectId)
        for (const rev of Object.values(record.revisions))
          availableMaterials.set(`${record.id}@${rev.revision}`, rev);
    return { availableAssets, availableSubjects, availableMaterials };
  }

  async getProjectAccess(
    actor: ActorIdentity | null | undefined,
    projectId: string,
  ): Promise<{ role: ProjectRole }> {
    const state = await this.store.readState();
    const access = this.assertProjectPermission(
      state,
      projectId,
      actor,
      "reader",
    );
    return {
      role:
        access.actor.actorId.toLowerCase() === inferProjectOwner(access.project)
          ? "writer"
          : access.project.members[access.actor.actorId],
    };
  }

  async createProject(
    actor: ActorIdentity | null | undefined,
    input: {
      id: string;
      name: string;
      description?: string;
      members?: Record<string, ProjectRole>;
      authoringMode?: "strict" | "legacy";
      sharingMode?: "private" | "members";
      operationId?: string;
    },
  ): Promise<ProjectRecord> {
    const authActor = this.assertAuthenticated(actor);
    if (
      input.members &&
      (typeof input.members !== "object" ||
        Array.isArray(input.members) ||
        Object.values(input.members).some(
          (r) => !["reader", "writer"].includes(r),
        ))
    )
      throw new DomainError("VALIDATION_FAILED", "Invalid project members.");
    if (
      input.sharingMode &&
      !["private", "members"].includes(input.sharingMode)
    )
      throw new DomainError("VALIDATION_FAILED", "Invalid sharing mode.");
    if (input.members)
      input = {
        ...input,
        members: Object.fromEntries(
          Object.entries(input.members).map(([id, role]) => [
            id.includes("@") ? id.trim().toLowerCase() : id.trim(),
            role,
          ]),
        ),
      };
    if (
      !input.id?.trim() ||
      !input.name?.trim() ||
      (input.authoringMode !== undefined &&
        !["strict", "legacy"].includes(input.authoringMode))
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Project id and name are required.",
      );
    }

    return this.store.runInTransaction("createProject", (draft) => {
      const receiptKey = input.operationId
        ? canonicalizeJson([
            "project-create",
            authActor.actorKind,
            authActor.actorId,
            input.id,
            input.operationId,
          ])
        : undefined;
      const fingerprint = canonicalizeJson({
        id: input.id,
        name: input.name,
        description: input.description || null,
        members: input.members ?? {},
        sharingMode: input.sharingMode ?? null,
        authoringMode: input.authoringMode ?? "strict",
      });
      const receipt = receiptKey
        ? (draft.idempotencyRecords[receiptKey] as
            { fingerprint: string; result: ProjectRecord } | undefined)
        : undefined;
      if (receipt) {
        this.assertProjectPermission(draft, input.id, actor, "writer");
        if (receipt.fingerprint !== fingerprint) {
          throw new DomainError(
            "VALIDATION_FAILED",
            "Idempotency key was already used with different creation data.",
          );
        }
        return receipt.result;
      }
      if (draft.projects[input.id]) {
        throw new DomainError(
          "ALREADY_EXISTS",
          `Project '${input.id}' already exists.`,
        );
      }
      const now = new Date().toISOString();
      const members: Record<string, ProjectRole> = {
        ...(input.members ?? {}),
        [authActor.actorId]: "writer",
        [userIdOf(authActor)]: "writer",
      };
      const record: ProjectRecord = {
        id: input.id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        createdAt: now,
        createdBy: authActor.actorId,
        ownerUserId: userIdOf(authActor),
        sharingMode:
          input.sharingMode ??
          (Object.keys(input.members ?? {}).some(
            (id) =>
              id.includes("@") && id.toLowerCase() !== userIdOf(authActor),
          )
            ? "members"
            : "private"),
        lifecycleRevision: 0,
        membershipRevision: 0,
        members,
      };
      draft.projects[input.id] = record;
      draft.materials[compositeKey(input.id, "workflow-policy")] =
        initialProjectPolicy(
          input.id,
          authActor,
          input.authoringMode ?? "strict",
        );
      if (receiptKey) {
        draft.idempotencyRecords[receiptKey] = {
          fingerprint,
          result: structuredClone(record),
        };
      }
      return record;
    });
  }

  async setProjectMemberRole(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      targetActorId: string;
      role: ProjectRole | null;
      baseRevision: number;
      operationId: string;
    },
  ): Promise<ProjectRecord> {
    input = {
      ...input,
      targetActorId: input.targetActorId?.includes("@")
        ? input.targetActorId.trim().toLowerCase()
        : input.targetActorId?.trim(),
    };
    return this.store.runInTransaction("setProjectMemberRole", (draft) => {
      const { project } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      if (!actor || inferProjectOwner(project) !== userIdOf(actor))
        throw new DomainError(
          "FORBIDDEN",
          "Only the project owner can manage sharing.",
        );
      if (
        !input.operationId?.trim() ||
        !Number.isInteger(input.baseRevision) ||
        !input.targetActorId?.trim() ||
        !["reader", "writer", null].includes(input.role)
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "Sharing requires a member, role, baseRevision and operationId.",
        );
      const receiptKey = canonicalizeJson([
        "membership",
        input.projectId,
        actor.actorId,
        input.operationId,
      ]);
      const fingerprint = canonicalizeJson(input);
      const receipt = draft.idempotencyRecords[receiptKey] as
        { fingerprint: string; result: ProjectRecord } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError(
            "VALIDATION_FAILED",
            "operationId was reused with different sharing content.",
          );
        return receipt.result;
      }
      if (input.baseRevision !== (project.membershipRevision ?? 0))
        throw new DomainError(
          "REVISION_CONFLICT",
          "Sharing changed; reload before updating.",
          { headRevision: project.membershipRevision ?? 0 },
        );
      if (
        input.targetActorId.toLowerCase() === inferProjectOwner(project) &&
        input.role !== "writer"
      )
        throw new DomainError(
          "FORBIDDEN",
          "The owner's writer access cannot be removed.",
        );
      if (
        input.role &&
        input.targetActorId.includes("@") &&
        input.targetActorId.toLowerCase() !== inferProjectOwner(project)
      )
        project.sharingMode = "members";
      if (input.role === null) {
        delete project.members[input.targetActorId];
      } else {
        project.members[input.targetActorId] = input.role;
      }
      project.sharingMode = Object.keys(project.members).some(
        (id) =>
          id.includes("@") && id.toLowerCase() !== inferProjectOwner(project),
      )
        ? "members"
        : "private";
      project.membershipRevision = (project.membershipRevision ?? 0) + 1;
      draft.idempotencyRecords[receiptKey] = {
        fingerprint,
        result: structuredClone(project),
      };
      return project;
    });
  }

  async listProjects(
    actor: ActorIdentity | null | undefined,
  ): Promise<ProjectRecord[]> {
    const authActor = this.assertAuthenticated(actor);
    const state = await this.store.readState();
    return Object.values(state.projects)
      .filter(
        (p) =>
          (authActor.actorId.toLowerCase() === inferProjectOwner(p) ||
            p.members[authActor.actorId] !== undefined) &&
          (inferProjectOwner(p) === userIdOf(authActor) ||
            p.sharingMode === "members") &&
          !isTrashed(state, p.id, "project", p.id),
      )
      .map((p) => ({
        ...p,
        ownerUserId: inferProjectOwner(p),
        lifecycleRevision:
          lifecycleRecord(state, p.id, "project", p.id)?.headRevision ?? 0,
      }));
  }

  async getProject(
    actor: ActorIdentity | null | undefined,
    projectId: string,
  ): Promise<ProjectRecord> {
    const state = await this.store.readState();
    const { project } = this.assertProjectPermission(
      state,
      projectId,
      actor,
      "reader",
    );
    return {
      ...project,
      ownerUserId: inferProjectOwner(project),
      lifecycleRevision:
        lifecycleRecord(state, projectId, "project", projectId)?.headRevision ??
        0,
    };
  }

  async getProjectOverview(
    actor: ActorIdentity | null | undefined,
    projectId: string,
  ): Promise<ProjectOverview> {
    const state = await this.store.readState();
    const access = this.assertProjectPermission(
      state,
      projectId,
      actor,
      "reader",
    );
    return {
      project: {
        ...access.project,
        ownerUserId: inferProjectOwner(access.project),
        lifecycleRevision:
          lifecycleRecord(state, projectId, "project", projectId)
            ?.headRevision ?? 0,
      },
      role:
        access.actor.actorId.toLowerCase() === inferProjectOwner(access.project)
          ? "writer"
          : access.project.members[access.actor.actorId],
      isOwner: inferProjectOwner(access.project) === userIdOf(access.actor),
      compositions: Object.values(state.compositions)
        .filter(
          (composition) =>
            composition.projectId === projectId &&
            !isTrashed(state, projectId, "composition", composition.id),
        )
        .map(({ id, title, headRevision }) => ({
          id,
          projectId,
          title,
          headRevision,
          ownerUserId: inferProjectOwner(access.project),
          lifecycleRevision:
            lifecycleRecord(state, projectId, "composition", id)
              ?.headRevision ?? 0,
        })),
      assetCount: Object.values(state.assets).filter(
        (asset) => asset.projectId === projectId,
      ).length,
      subjectCount: Object.values(state.subjects).filter(
        (subject) => subject.projectId === projectId,
      ).length,
    };
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
      throw new DomainError(
        "VALIDATION_FAILED",
        "sizeBytes must be a positive integer.",
      );
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
      throw new DomainError(
        "NOT_FOUND",
        `Upload session '${input.sessionId}' not found.`,
      );
    }
    if (session.status !== "pending") {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Upload session '${input.sessionId}' is in status '${session.status}'.`,
      );
    }
    await this.store.bucket.put(
      session.storageKey,
      input.bytes,
      session.mimeType,
    );
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
      throw new DomainError(
        "NOT_FOUND",
        `Upload session '${input.sessionId}' not found.`,
      );
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

    const dimensions = session.mimeType.startsWith("image/")
      ? imageDimensions(storedObj.data)
      : undefined;
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
        lineage: {
          ...(session.lineage ?? {}),
          mediaDimensions: {
            verified: Boolean(dimensions),
            source: "file-header",
          },
        },
        ...(dimensions ?? {}),
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
    const sha256 =
      input.expectedSha256 ?? (await computeSha256Hex(input.bytes));
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
      if (query?.mimePrefix && !a.mimeType.startsWith(query.mimePrefix))
        return false;
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

  async getAssetContent(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    assetId: string,
    options?: {
      range?: { start: number; end?: number } | { suffix: number };
      head?: boolean;
    },
  ): Promise<{
    asset: AssetRecord;
    body: ReadableStream<Uint8Array> | null;
    range?: { offset: number; length: number };
  }> {
    const asset = await this.getAsset(actor, projectId, assetId);
    const requested = options?.range;
    let range: { offset: number; length: number } | undefined;
    if (requested) {
      const start =
        "suffix" in requested
          ? Math.max(0, asset.sizeBytes - requested.suffix)
          : requested.start;
      const end =
        "suffix" in requested
          ? asset.sizeBytes - 1
          : Math.min(requested.end ?? asset.sizeBytes - 1, asset.sizeBytes - 1);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= asset.sizeBytes ||
        end < start ||
        ("suffix" in requested &&
          (!Number.isSafeInteger(requested.suffix) || requested.suffix <= 0))
      ) {
        throw new DomainError(
          "RANGE_NOT_SATISFIABLE",
          "Requested byte range is not available.",
          { sizeBytes: asset.sizeBytes },
        );
      }
      range = { offset: start, length: end - start + 1 };
    }
    if (options?.head && !(await this.store.bucket.has(asset.storageKey)))
      throw new DomainError("NOT_FOUND", "The media file is unavailable.");
    const body = options?.head
      ? null
      : await this.store.bucket.read(asset.storageKey, range);
    if (!options?.head && !body)
      throw new DomainError("NOT_FOUND", "The media file is unavailable.");
    return { asset, body, ...(range ? { range } : {}) };
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

      if (
        Object.values(draft.materials).some(
          (r) =>
            r.projectId === projectId &&
            Object.values(r.revisions).some((v) =>
              materialAssetIds(v.document).includes(assetId),
            ),
        ) ||
        Object.values(draft.generationEvidence).some(
          (r) =>
            r.projectId === projectId &&
            [
              ...r.outputs,
              ...r.actualInputs.map((a) => a.asset),
              ...r.packet.inputs.map((a) => a.asset),
              ...(r.packet.motion?.video ? [r.packet.motion.video.asset] : []),
              ...(r.packet.motion?.keyframes ?? []).map((k) => k.asset),
              ...(r.actualMotion?.video ? [r.actualMotion.video.asset] : []),
              ...(r.actualMotion?.keyframes ?? []).map((k) => k.asset),
            ].includes(assetId),
        )
      ) {
        throw new DomainError(
          "DEPENDENCY_ERROR",
          "Asset is retained by reference workflow or execution history.",
        );
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
              shot.selected.video === assetId ||
              shot.selected.audio === assetId;
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
      workflowContext?: WorkflowContext;
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
      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      const sKey = compositeKey(input.projectId, input.id);
      if (draft.subjects[sKey]) {
        throw new DomainError(
          "ALREADY_EXISTS",
          `Subject '${input.id}' already exists in project '${input.projectId}'.`,
        );
      }

      const { availableAssets } = this.buildValidationContext(
        draft,
        input.projectId,
      );
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

      assertNoMotionReferenceAssets(draft, input.projectId, snapshot);
      if (snapshot.status === "approved")
        assertStrictSubjectReferences(
          draft,
          input.projectId,
          snapshot,
          input.workflowContext,
        );
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
      workflowContext?: WorkflowContext;
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
      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      const idemKey = canonicalizeJson([
        "subject_patch",
        input.projectId,
        authActor.actorId,
        input.operationId,
      ]);
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

      const headSnap = structuredClone(
        subject.revisions[subject.latestRevision],
      );
      const nextRevision = subject.latestRevision + 1;
      const mergedVariants = {
        ...headSnap.variants,
        ...(input.changes.variants
          ? structuredClone(input.changes.variants)
          : {}),
      };

      const candidateRaw: SubjectSnapshot = {
        id: subject.id,
        kind: subject.kind,
        revision: nextRevision,
        status: "candidate",
        name: input.changes.name ?? headSnap.name,
        defaultVariant: input.changes.defaultVariant ?? headSnap.defaultVariant,
        definition: {
          description:
            input.changes.description ?? headSnap.definition.description,
          invariants: input.changes.invariants
            ? [...input.changes.invariants]
            : [...headSnap.definition.invariants],
        },
        variants: mergedVariants,
        ...(headSnap.extensions ? { extensions: headSnap.extensions } : {}),
      };

      const { availableAssets } = this.buildValidationContext(
        draft,
        input.projectId,
      );
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

      assertNoMotionReferenceAssets(draft, input.projectId, snapshot);
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
      throw new DomainError(
        "NOT_FOUND",
        `Subject '${input.subjectId}' not found.`,
      );
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
        ...(input.entry.provenance
          ? { provenance: input.entry.provenance }
          : {}),
      },
    ];

    return this.patchSubject(actor, {
      workflowContext: input.workflowContext,
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
      workflowContext?: WorkflowContext;
    },
  ): Promise<SubjectSnapshot> {
    return this.store.runInTransaction("approveSubjectRevision", (draft) => {
      this.assertProjectPermission(draft, input.projectId, actor, "writer");
      const idemKey = canonicalizeJson([
        "subject_approve",
        input.projectId,
        actor?.actorId,
        input.operationId,
      ]);
      if (draft.idempotencyRecords[idemKey]) {
        return draft.idempotencyRecords[idemKey] as SubjectSnapshot;
      }

      const sKey = compositeKey(input.projectId, input.subjectId);
      const subject = draft.subjects[sKey];
      if (!subject) {
        throw new DomainError(
          "NOT_FOUND",
          `Subject '${input.subjectId}' not found.`,
        );
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

      const { availableAssets } = this.buildValidationContext(
        draft,
        input.projectId,
      );
      const { snapshot, errors } = validateSubjectSnapshot(
        promoted,
        "$.subject",
        {
          availableAssets,
        },
      );
      if (errors.length > 0 || !snapshot) {
        throw new DomainError(
          "VALIDATION_FAILED",
          errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors },
        );
      }

      assertNoMotionReferenceAssets(draft, input.projectId, snapshot);
      assertStrictSubjectReferences(
        draft,
        input.projectId,
        snapshot,
        input.workflowContext,
      );
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
      if (
        comp.projectId !== projectId ||
        isTrashed(state, projectId, "composition", comp.id)
      )
        continue;
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
    const materials = (doc.authoring?.materials ?? []).map((pin) => {
      const ref = materialRevision(state, projectId, pin);
      if (
        !ref ||
        ref.status !== "approved" ||
        !validateMaterial(state, projectId, ref.document).ready
      )
        throw new DomainError(
          "REFERENCE_REVIEW_REQUIRED",
          "Composition needs approved, valid material revisions.",
          { pin },
        );
      return ref;
    });
    if (isStrictProject(state, projectId)) {
      const approvedAssets = new Set(
        materials.flatMap((r) =>
          r.document.kind === "reference_pack"
            ? r.document.views.map((v) => v.asset)
            : r.document.kind === "storyboard_sequence"
              ? r.document.panels.map((p) => p.asset)
              : [],
        ),
      );
      for (const [shotId, shot] of Object.entries(doc.shots))
        for (const image of shot.references.images) {
          if (!approvedAssets.has(image.asset))
            throw new DomainError(
              "REFERENCE_REVIEW_REQUIRED",
              "Direct references require an explicitly pinned approved material; mixed/raw assets remain archive-only.",
              { asset: image.asset },
            );
          const scoped = materials.some((r) =>
            r.document.kind === "reference_pack"
              ? r.document.views.some(
                  (v) =>
                    v.asset === image.asset &&
                    (v.owner.kind === "scene" ||
                      shot.subjects.some(
                        (b) =>
                          b.subjectId === v.owner.id &&
                          b.subjectRevision === v.owner.revision &&
                          (b.variant ??
                            state.subjects[compositeKey(projectId, b.subjectId)]
                              ?.revisions[b.subjectRevision]
                              ?.defaultVariant) === v.owner.variant,
                      )),
                )
              : r.document.kind === "storyboard_sequence" &&
                r.document.panels.some(
                  (p) =>
                    p.asset === image.asset &&
                    p.shotId === shotId &&
                    r.document.kind === "storyboard_sequence" &&
                    r.document.compositionId === doc.id,
                ),
          );
          if (!scoped)
            throw new DomainError(
              "REFERENCE_SCOPE_MISMATCH",
              "Image owner/panel does not match the shot's fixed subject bindings.",
              { shotId, asset: image.asset },
            );
        }
    }
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
      workflowContext?: WorkflowContext;
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

      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      assertCompositionActive(draft, input.projectId, input.document.id);
      const receiptKey = input.operationId
        ? canonicalizeJson([
            "composition-create",
            input.projectId,
            authActor.actorKind,
            authActor.actorId,
            input.document.id,
            input.operationId,
          ])
        : undefined;
      const fingerprint = canonicalizeJson(input.document);
      const receipt = receiptKey
        ? (draft.idempotencyRecords[receiptKey] as
            | { fingerprint: string; result: CompositionRevisionRecord }
            | undefined)
        : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new DomainError(
            "VALIDATION_FAILED",
            "Idempotency key was already used with different creation data.",
          );
        }
        return receipt.result;
      }

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

      this.assertApprovedSubjectBindings(
        draft,
        input.projectId,
        validated.value,
      );

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
      if (receiptKey) {
        draft.idempotencyRecords[receiptKey] = {
          fingerprint,
          result: structuredClone(revRecord),
        };
      }
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
      .filter(
        (c) =>
          c.projectId === projectId &&
          !isTrashed(state, projectId, "composition", c.id),
      )
      .map((c) => ({
        id: c.id,
        projectId: c.projectId,
        title: c.title,
        headRevision: c.headRevision,
        ownerUserId: inferProjectOwner(state.projects[projectId]),
        lifecycleRevision:
          lifecycleRecord(state, projectId, "composition", c.id)
            ?.headRevision ?? 0,
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
    assertCompositionActive(state, projectId, compositionId);
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
            binding.variant ??
            snap.defaultVariant ??
            Object.keys(snap.variants)[0];
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
      workflowContext?: WorkflowContext;
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
      throw new DomainError(
        "VALIDATION_FAILED",
        "operationId (idempotency key) is required.",
      );
    }
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "operations must be a non-empty array.",
      );
    }

    return this.store.runInTransaction("patchComposition", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );

      assertCompositionActive(draft, input.projectId, input.compositionId);
      const idemKey = canonicalizeJson([
        "comp_patch",
        input.projectId,
        input.compositionId,
        authActor.actorId,
        input.operationId,
      ]);
      if (draft.idempotencyRecords[idemKey]) {
        return draft.idempotencyRecords[idemKey] as {
          revisionRecord: CompositionRevisionRecord;
          changeRecord: ChangeRecord;
        };
      }

      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      assertCompositionActive(draft, input.projectId, input.compositionId);
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

      this.assertApprovedSubjectBindings(
        draft,
        input.projectId,
        validated.value,
      );

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
    assertCompositionActive(state, projectId, compositionId);
    const cKey = compositeKey(projectId, compositionId);
    const comp = state.compositions[cKey];
    if (!comp) {
      throw new DomainError(
        "NOT_FOUND",
        `Composition '${compositionId}' not found.`,
      );
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
      workflowContext?: WorkflowContext;
    },
  ): Promise<CompositionRevisionRecord> {
    return this.store.runInTransaction(
      "restoreCompositionRevision",
      (draft) => {
        const { actor: authActor } = this.assertProjectPermission(
          draft,
          input.projectId,
          actor,
          "writer",
        );
        assertWorkflowContext(draft, input.projectId, input.workflowContext);
        assertCompositionActive(draft, input.projectId, input.compositionId);
        const cKey = compositeKey(input.projectId, input.compositionId);
        const comp = draft.compositions[cKey];
        if (!comp) {
          throw new DomainError(
            "NOT_FOUND",
            `Composition '${input.compositionId}' not found.`,
          );
        }
        const historical = comp.revisions[input.targetRevision];
        if (!historical) {
          throw new DomainError(
            "NOT_FOUND",
            `Target revision ${input.targetRevision} not found on '${input.compositionId}'.`,
          );
        }

        this.assertApprovedSubjectBindings(
          draft,
          input.projectId,
          historical.document,
        );
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
      },
    );
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
      assertCompositionActive(draft, input.projectId, input.compositionId);
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
      this.assertApprovedSubjectBindings(
        draft,
        input.projectId,
        validated.value,
      );

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
      workflowContext?: WorkflowContext;
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
      throw new DomainError(
        "NOT_FOUND",
        `Proposal '${input.proposalId}' not found.`,
      );
    }
    if (proposal.status !== "open") {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Proposal '${input.proposalId}' is already '${proposal.status}'.`,
      );
    }

    const patchResult = await this.patchComposition(authActor, {
      workflowContext: input.workflowContext,
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
        (!compositionId || p.compositionId === compositionId) &&
        !isTrashed(state, projectId, "composition", p.compositionId),
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
      targetVersion?: ProtocolVersion;
    },
  ): Promise<{ bundle: PortableCompositionBundle; serialized: string }> {
    const state = await this.store.readState();
    this.assertProjectPermission(state, input.projectId, actor, "reader");
    assertCompositionActive(state, input.projectId, input.compositionId);
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

    const original = revRecord.document;
    if (
      input.targetVersion === PROTOCOL_VERSION &&
      original.authoring !== undefined
    )
      throw new DomainError(
        "UNREPRESENTABLE_IN_V1",
        "A v2 reference workflow cannot be silently stripped for v1 export.",
        { paths: ["authoring"] },
      );
    const doc: CompositionDocument = {
      ...original,
      apiVersion: input.targetVersion ?? original.apiVersion,
    };
    const referencedMaterials = new Map<
      string,
      import("@vflow/protocol").MaterialRevision
    >();
    const referencedAssetIds = new Set<string>();
    const compositionBaselines: NonNullable<
      PortableCompositionBundle["dependencies"]["compositionBaselines"]
    > = [];
    const collectMaterial = (
      pin: import("@vflow/protocol").RevisionPin,
    ): void => {
      const key = `${pin.id}@${pin.revision}`;
      if (referencedMaterials.has(key)) return;
      const ref = materialRevision(state, input.projectId, pin);
      if (!ref)
        throw new DomainError(
          "DEPENDENCY_ERROR",
          `Missing reference material ${key}`,
        );
      referencedMaterials.set(key, ref);
      materialAssetIds(ref.document).forEach((id) =>
        referencedAssetIds.add(id),
      );
      materialPins(ref.document).forEach(collectMaterial);
      if (
        ref.document.kind === "storyboard_sequence" ||
        ref.document.kind === "motion_reference"
      ) {
        // Both pin an exact composition revision that a consumer needs to interpret them.
        const seq = ref.document;
        assertCompositionActive(state, input.projectId, seq.compositionId);
        const baseline =
          state.compositions[compositeKey(input.projectId, seq.compositionId)]
            ?.revisions[seq.compositionRevision]?.document;
        if (!baseline)
          throw new DomainError(
            "DEPENDENCY_ERROR",
            "Storyboard baseline is missing.",
          );
        if (
          !compositionBaselines.some(
            (b) =>
              b.id === seq.compositionId &&
              b.revision === seq.compositionRevision,
          )
        ) {
          compositionBaselines.push({
            id: seq.compositionId,
            revision: seq.compositionRevision,
            document: baseline,
          });
          baseline.authoring?.materials.forEach(collectMaterial);
        }
      }
    };
    doc.authoring?.materials.forEach(collectMaterial);
    const referencedSubjects = new Map<string, SubjectSnapshot>();

    for (const track of [
      doc,
      ...compositionBaselines.map((b) => b.document),
    ].flatMap((d) => d.audioTracks)) {
      referencedAssetIds.add(track.asset);
    }

    for (const shot of [
      doc,
      ...compositionBaselines.map((b) => b.document),
    ].flatMap((d) => Object.values(d.shots))) {
      for (const img of shot.references.images)
        referencedAssetIds.add(img.asset);
      for (const vid of shot.references.videos)
        referencedAssetIds.add(vid.asset);
      for (const img of shot.candidates.images)
        referencedAssetIds.add(img.asset);
      for (const vid of shot.candidates.videos)
        referencedAssetIds.add(vid.asset);
      for (const aud of shot.candidates.audios)
        referencedAssetIds.add(aud.asset);
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

    for (const ref of referencedMaterials.values()) {
      const owners =
        ref.document.kind === "reference_pack"
          ? ref.document.views.map((v) => v.owner)
          : ref.document.kind === "storyboard_sequence"
            ? ref.document.panels.flatMap((p) =>
                p.entities.map((e) => e.subject),
              )
            : ref.document.kind === "motion_reference"
              ? ref.document.subjects
              : [];
      for (const owner of owners)
        if (owner.kind !== "scene") {
          const subject =
            state.subjects[compositeKey(input.projectId, owner.id)]?.revisions[
              owner.revision
            ];
          if (!subject)
            throw new DomainError(
              "DEPENDENCY_ERROR",
              "Missing material owner subject.",
            );
          referencedSubjects.set(
            subjectRevisionKey(owner.id, owner.revision),
            subject,
          );
          for (const variant of Object.values(subject.variants))
            variant.referencePack.forEach((r) =>
              referencedAssetIds.add(r.asset),
            );
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
      apiVersion: doc.apiVersion,
      composition: doc,
      revision: revRecord.revision,
      dependencies: {
        subjects: Array.from(referencedSubjects.values()),
        assets: assetsManifest,
        ...(isReferenceProtocolVersion(doc.apiVersion)
          ? {
              materials: Array.from(referencedMaterials.values()),
              compositionBaselines,
            }
          : {}),
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
      workflowContext?: WorkflowContext;
      payload: string;
      format: "json" | "yaml";
      targetCompositionId?: string;
      operationId?: string;
      baseRevision?: number;
    },
  ): Promise<CompositionRevisionRecord> {
    return this.store.runInTransaction("importCompositionBundle", (draft) => {
      const { actor: authActor } = this.assertProjectPermission(
        draft,
        input.projectId,
        actor,
        "writer",
      );

      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      const receiptKey = input.operationId
        ? canonicalizeJson([
            "bundle-import",
            input.projectId,
            authActor.actorId,
            input.operationId,
          ])
        : undefined;
      const fingerprint = canonicalizeJson({
        payload: input.payload,
        format: input.format,
        targetCompositionId: input.targetCompositionId ?? null,
        baseRevision: input.baseRevision ?? null,
      });
      const receipt = receiptKey
        ? (draft.idempotencyRecords[receiptKey] as
            | { fingerprint: string; result: CompositionRevisionRecord }
            | undefined)
        : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError(
            "VALIDATION_FAILED",
            "Import operationId was reused with different content.",
          );
        assertCompositionActive(
          draft,
          input.projectId,
          receipt.result.document.id,
        );
        return receipt.result;
      }
      const parsed = parseBundleInterchange(input.payload, input.format);
      if (!parsed.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
          { errors: parsed.errors },
        );
      }

      const bundle = parsed.value;
      assertCompositionActive(
        draft,
        input.projectId,
        input.targetCompositionId ?? bundle.composition.id,
      );
      const initialTarget =
        draft.compositions[
          compositeKey(
            input.projectId,
            input.targetCompositionId ?? bundle.composition.id,
          )
        ];
      if (
        (input.baseRevision !== undefined &&
          input.baseRevision !== (initialTarget?.headRevision ?? 0)) ||
        (initialTarget &&
          isStrictProject(draft, input.projectId) &&
          input.baseRevision === undefined)
      )
        throw new DomainError(
          "REVISION_CONFLICT",
          "Import requires the current target baseRevision.",
          { headRevision: initialTarget?.headRevision ?? 0 },
        );
      const missingAssets: string[] = [];
      for (const assetDep of bundle.dependencies.assets) {
        const existingAsset =
          draft.assets[compositeKey(input.projectId, assetDep.id)];
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
          if (
            existingRev &&
            canonicalizeJson(existingRev) !== canonicalizeJson(subjSnap)
          )
            throw new DomainError(
              "IMMUTABILITY_VIOLATION",
              "Imported subject revision conflicts with existing content.",
            );
          if (!existingRev) {
            existingSubj.revisions[subjSnap.revision] =
              structuredClone(subjSnap);
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

      for (const source of bundle.dependencies.materials ?? []) {
        const imported = {
          ...structuredClone(source),
          projectId: input.projectId,
        };
        const mk = compositeKey(input.projectId, imported.document.id);
        const record = draft.materials[mk] ?? {
          id: imported.document.id,
          projectId: input.projectId,
          headRevision: 0,
          revisions: {},
        };
        const old = record.revisions[imported.revision];
        if (old && canonicalizeJson(old) !== canonicalizeJson(imported))
          throw new DomainError(
            "IMMUTABILITY_VIOLATION",
            "Imported reference material conflicts with an existing revision.",
          );
        record.revisions[imported.revision] = old ?? imported;
        record.headRevision = Math.max(record.headRevision, imported.revision);
        draft.materials[mk] = record;
      }
      for (const subjSnap of bundle.dependencies.subjects)
        assertNoMotionReferenceAssets(draft, input.projectId, subjSnap);
      for (const baseline of bundle.dependencies.compositionBaselines ?? []) {
        const ck = compositeKey(input.projectId, baseline.id);
        const document = {
          ...structuredClone(baseline.document),
          project: input.projectId,
        };
        assertCompositionActive(draft, input.projectId, baseline.id);
        const comp = draft.compositions[ck] ?? {
          id: baseline.id,
          projectId: input.projectId,
          title: document.title,
          headRevision: 0,
          revisions: {},
        };
        const existing = comp.revisions[baseline.revision];
        if (
          existing &&
          canonicalizeJson(existing.document) !== canonicalizeJson(document)
        )
          throw new DomainError(
            "IMMUTABILITY_VIOLATION",
            "Storyboard baseline conflicts with an existing composition revision.",
          );
        comp.revisions[baseline.revision] = existing ?? {
          compositionId: baseline.id,
          projectId: input.projectId,
          revision: baseline.revision,
          parentRevision: null,
          actorId: authActor.actorId,
          actorKind: authActor.actorKind,
          operationId: input.operationId ?? "baseline-import",
          createdAt: new Date().toISOString(),
          message: "Imported pinned storyboard baseline",
          document,
        };
        comp.headRevision = Math.max(comp.headRevision, baseline.revision);
        draft.compositions[ck] = comp;
        draft.changes[ck] ??= [];
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

      this.assertApprovedSubjectBindings(
        draft,
        input.projectId,
        validated.value,
      );

      const cKey = compositeKey(input.projectId, validated.value.id);
      const now = new Date().toISOString();
      const existingComp = draft.compositions[cKey];
      if (
        isReferenceProtocolVersion(
          existingComp?.revisions[existingComp.headRevision].document.apiVersion,
        ) &&
        validated.value.apiVersion === PROTOCOL_VERSION
      )
        throw new DomainError(
          "UNREPRESENTABLE_IN_V1",
          "Import cannot erase v2 authoring dependencies.",
        );
      const nextRev = existingComp ? existingComp.headRevision + 1 : 1;
      const revRecord: CompositionRevisionRecord = {
        compositionId: validated.value.id,
        projectId: input.projectId,
        revision: nextRev,
        parentRevision: existingComp ? existingComp.headRevision : null,
        actorId: authActor.actorId,
        actorKind: authActor.actorKind,
        operationId:
          input.operationId ?? `import-${validated.value.id}-${nextRev}`,
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

      if (receiptKey)
        draft.idempotencyRecords[receiptKey] = {
          fingerprint,
          result: revRecord,
        };
      return revRecord;
    });
  }
}
