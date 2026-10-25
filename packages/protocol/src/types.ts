export const PROTOCOL_VERSION = "video-compose/v1" as const;
export const REFERENCE_PROTOCOL_VERSION = "video-compose/v2" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION | typeof REFERENCE_PROTOCOL_VERSION;

export type ProjectRole = "reader" | "writer";
export type ActorKind = "human" | "agent";

export interface ActorIdentity {
  /** Server-derived account owner; never read from a request body/header. */
  userId?: string;
  actorId: string;
  actorKind: ActorKind;
}

export type SubjectKind = "character" | "prop";
export type RevisionStatus = "candidate" | "approved";

export interface ReferencePackEntry {
  asset: string;
  view?: string;
  purpose?: string;
  status: RevisionStatus;
  notes?: string;
  provenance?: Record<string, unknown>;
}

export interface SubjectVariant {
  description: string;
  referencePack: ReferencePackEntry[];
}

export interface SubjectSnapshot {
  id: string;
  kind: SubjectKind;
  revision: number;
  status: RevisionStatus;
  name: string;
  defaultVariant?: string;
  definition: {
    description: string;
    invariants: string[];
  };
  variants: Record<string, SubjectVariant>;
  extensions?: Record<string, unknown>;
}

export interface SubjectManifest {
  apiVersion: ProtocolVersion;
  subject: SubjectSnapshot;
}

export interface ShotSubjectBinding {
  subjectId: string;
  subjectRevision: number;
  variant?: string;
}

export type ShotDependencyKind = "continuity" | "last_frame" | "narrative" | "reference";

export interface ShotDependency {
  shotId: string;
  kind: ShotDependencyKind;
  notes?: string;
}

export interface AssetReference {
  asset: string;
  role?: string;
  notes?: string;
}

export interface CandidateEntry {
  asset: string;
  role?: string;
  actor?: string;
  notes?: string;
}

export interface ShotCandidates {
  images: CandidateEntry[];
  videos: CandidateEntry[];
  audios: CandidateEntry[];
}

export interface ShotSelected {
  video: string | null;
  audio: string | null;
}

export interface ShotPrompts {
  image?: string;
  video?: string;
  audio?: string;
}

export interface ShotDefinition {
  description: string;
  durationFrames?: number;
  dependsOn: ShotDependency[];
  subjects: ShotSubjectBinding[];
  references: {
    images: AssetReference[];
    videos: AssetReference[];
  };
  prompts: ShotPrompts;
  candidates: ShotCandidates;
  selected: ShotSelected;
  extensions?: Record<string, unknown>;
  [key: `x-${string}`]: unknown;
}

export type AudioTrackRole = "bgm" | "voiceover" | "ambience" | "sfx";

export interface AudioTrackDefinition {
  id: string;
  role: AudioTrackRole;
  asset: string;
  startFrame: number;
  durationFrames: number;
  trimStartFrame?: number;
  notes?: string;
  extensions?: Record<string, unknown>;
}

export interface CompositionFormat {
  width: number;
  height: number;
  fps: number;
}

export interface CompositionDocument {
  apiVersion: ProtocolVersion;
  id: string;
  project: string;
  title?: string;
  format: CompositionFormat;
  audioTracks: AudioTrackDefinition[];
  sequence: string[];
  shots: Record<string, ShotDefinition>;
  authoring?: import("./authoring.ts").CompositionAuthoring;
  extensions?: Record<string, unknown>;
  [key: `x-${string}`]: unknown;
}

export interface AssetManifestEntry {
  id: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationFrames?: number;
  lineage?: Record<string, unknown>;
}

export interface PortableCompositionBundle {
  apiVersion: ProtocolVersion;
  composition: CompositionDocument;
  revision?: number;
  dependencies: {
    subjects: SubjectSnapshot[];
    assets: AssetManifestEntry[];
    materials?: import("./authoring.ts").MaterialRevision[];
    compositionBaselines?: Array<{ id: string; revision: number; document: CompositionDocument }>;
  };
}

export type ProtocolErrorCode =
  | "INVALID_TYPE"
  | "UNSUPPORTED_API_VERSION"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FORMAT"
  | "INVALID_DURATION_FRAMES"
  | "INVALID_AUDIO_TRACK"
  | "DUPLICATE_AUDIO_TRACK_ID"
  | "DUPLICATE_SEQUENCE_SHOT"
  | "UNKNOWN_SEQUENCE_SHOT"
  | "UNKNOWN_DEPENDENCY_SHOT"
  | "DEPENDENCY_CYCLE"
  | "MISSING_ASSET_REFERENCE"
  | "MISSING_SUBJECT_REVISION"
  | "MISSING_SUBJECT_VARIANT"
  | "INVALID_SUBJECT"
  | "INVALID_CANDIDATE_LIST"
  | "PARSE_ERROR";

export interface ProtocolValidationError {
  code: ProtocolErrorCode;
  path: string;
  message: string;
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T; errors: [] }
  | { ok: false; errors: ProtocolValidationError[] };

export interface ValidationContext {
  availableMaterials?: ReadonlyMap<string, import("./authoring.ts").MaterialRevision>;
  availableAssets?: ReadonlySet<string>;
  availableSubjects?: ReadonlyMap<string, SubjectSnapshot>;
}
