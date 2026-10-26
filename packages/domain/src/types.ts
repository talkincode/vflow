import type {
  ActorKind,
  AudioTrackDefinition,
  CandidateEntry,
  CompositionDocument,
  ProjectRole,
  ReferencePackEntry,
  RevisionStatus,
  ShotDefinition,
  ShotDependency,
  ShotPrompts,
  ShotSubjectBinding,
  SubjectKind,
  SubjectSnapshot,
  SubjectVariant,
} from "@vflow/protocol";

export interface ProjectRecord {
  ownerUserId?: string;
  sharingMode?: "private" | "members";
  membershipRevision?: number;
  lifecycleRevision?: number;
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  createdBy: string;
  members: Record<string, ProjectRole>;
}

export interface CompositionSummary {
  ownerUserId?: string;
  lifecycleRevision?: number;
  id: string;
  projectId: string;
  title?: string;
  headRevision: number;
}

export interface ProjectOverview {
  isOwner?: boolean;
  project: ProjectRecord;
  role: ProjectRole;
  compositions: CompositionSummary[];
  assetCount: number;
  subjectCount: number;
}

export interface AssetRecord {
  id: string;
  projectId: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  width?: number;
  height?: number;
  durationFrames?: number;
  lineage?: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
}

export interface UploadSessionRecord {
  sessionId: string;
  projectId: string;
  assetId: string;
  expectedSha256: string;
  mimeType: string;
  expectedSizeBytes: number;
  storageKey: string;
  status: "pending" | "finalized" | "failed" | "expired";
  expiresAt: string;
  createdBy: string;
  width?: number;
  height?: number;
  durationFrames?: number;
  lineage?: Record<string, unknown>;
}

export interface SubjectRecord {
  id: string;
  projectId: string;
  kind: SubjectKind;
  name: string;
  latestRevision: number;
  latestApprovedRevision: number | null;
  revisions: Record<number, SubjectSnapshot>;
  updatedAt: string;
}

export interface SubjectPatchChanges {
  name?: string;
  defaultVariant?: string;
  description?: string;
  invariants?: string[];
  variants?: Record<string, SubjectVariant>;
}

export interface SubjectChangeRecord {
  id: string;
  projectId: string;
  subjectId: string;
  baseRevision: number;
  resultRevision: number;
  operationId: string;
  actorId: string;
  actorKind: ActorKind;
  touchedPaths: string[];
  createdAt: string;
}

export interface CompositionRevisionRecord {
  compositionId: string;
  projectId: string;
  revision: number;
  parentRevision: number | null;
  actorId: string;
  actorKind: ActorKind;
  operationId: string;
  message?: string;
  createdAt: string;
  document: CompositionDocument;
}

export type TypedOperation =
  | {
      op: "set_authoring";
      authoring: import("@vflow/protocol").CompositionAuthoring;
    }
  | {
      op: "upsert_shot";
      shotId: string;
      shot: ShotDefinition;
      afterShotId?: string | null;
    }
  | {
      op: "update_shot_fields";
      shotId: string;
      description?: string;
      durationFrames?: number;
      prompts?: Partial<ShotPrompts>;
      dependsOn?: ShotDependency[];
    }
  | {
      op: "delete_shot";
      shotId: string;
    }
  | {
      op: "attach_shot_candidate";
      shotId: string;
      mediaKind: "images" | "videos" | "audios";
      candidate: CandidateEntry;
    }
  | {
      op: "detach_shot_candidate";
      shotId: string;
      mediaKind: "images" | "videos" | "audios";
      assetId: string;
    }
  | {
      op: "update_shot_candidate";
      shotId: string;
      mediaKind: "images" | "videos" | "audios";
      assetId: string;
      candidate: Partial<Omit<CandidateEntry, "asset">>;
    }
  | {
      op: "select_shot_output";
      shotId: string;
      mediaKind: "video" | "audio";
      assetId: string | null;
    }
  | {
      op: "bind_shot_subject";
      shotId: string;
      binding: ShotSubjectBinding;
    }
  | {
      op: "upsert_audio_track";
      track: AudioTrackDefinition;
    }
  | {
      op: "delete_audio_track";
      trackId: string;
    }
  | {
      op: "reorder_sequence";
      shotId: string;
      afterShotId: string | null;
    };

export interface ChangeRecord {
  id: string;
  projectId: string;
  compositionId: string;
  baseRevision: number;
  resultRevision: number;
  operationId: string;
  actorId: string;
  actorKind: ActorKind;
  operations: TypedOperation[];
  touchedPaths: string[];
  autoMergedFromStaleBase: boolean;
  createdAt: string;
}

export interface ProposalRecord {
  id: string;
  projectId: string;
  compositionId: string;
  baseRevision: number;
  operationId: string;
  actorId: string;
  actorKind: ActorKind;
  description: string;
  operations: TypedOperation[];
  status: "open" | "approved" | "rejected" | "conflicted";
  resultRevision?: number;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface ConflictDetail {
  path: string;
  baseRevision: number;
  headRevision: number;
  competingActorId: string;
  reason: string;
}

export type DomainErrorCode =
  | "RESOURCE_TRASHED"
  | "PARENT_TRASHED"
  | "WORKFLOW_CONTEXT_REQUIRED"
  | "WORKFLOW_VERSION_MISMATCH"
  | "REFERENCE_SCOPE_MISMATCH"
  | "REFERENCE_USAGE_AMBIGUOUS"
  | "REFERENCE_REVIEW_REQUIRED"
  | "REFERENCE_CONFLICT_UNRESOLVED"
  | "GRID_CELL_REQUIRED"
  | "STORYBOARD_LAYOUT_INVALID"
  | "STORYBOARD_TEXT_DETECTED"
  | "REFERENCE_BUDGET_EXCEEDED"
  | "MEDIA_DIMENSIONS_UNVERIFIED"
  | "UNREPRESENTABLE_IN_V1"
  | "RANGE_NOT_SATISFIABLE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "REVISION_CONFLICT"
  | "ASSET_INTEGRITY_ERROR"
  | "IMMUTABILITY_VIOLATION"
  | "DEPENDENCY_ERROR"
  | "INTERNAL_ERROR";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export interface AttachSubjectReferenceInput {
  workflowContext?: import("@vflow/protocol").WorkflowContext;
  projectId: string;
  subjectId: string;
  baseRevision: number;
  operationId: string;
  variant: string;
  entry: Omit<ReferencePackEntry, "status"> & { status?: RevisionStatus };
}
