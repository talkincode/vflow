import {
  type AssetRecord,
  type ChangeRecord,
  type CompositionRevisionRecord,
  DomainError,
  type ProjectRecord,
  type ProposalRecord,
  type SubjectChangeRecord,
  type SubjectRecord,
  type UploadSessionRecord,
} from "./types.ts";

export interface DomainStateSnapshot {
  projects: Record<string, ProjectRecord>;
  assets: Record<string, AssetRecord>;
  uploadSessions: Record<string, UploadSessionRecord>;
  subjects: Record<string, SubjectRecord>;
  subjectChanges: Record<string, SubjectChangeRecord[]>;
  compositions: Record<
    string,
    {
      id: string;
      projectId: string;
      title?: string;
      headRevision: number;
      revisions: Record<number, CompositionRevisionRecord>;
    }
  >;
  changes: Record<string, ChangeRecord[]>;
  proposals: Record<string, ProposalRecord>;
  idempotencyRecords: Record<string, unknown>;
}

export function createEmptyStateSnapshot(): DomainStateSnapshot {
  return {
    projects: {},
    assets: {},
    uploadSessions: {},
    subjects: {},
    subjectChanges: {},
    compositions: {},
    changes: {},
    proposals: {},
    idempotencyRecords: {},
  };
}

export interface ObjectBucketAdapter {
  put(key: string, data: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  read(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

export interface DomainStore {
  readonly bucket: ObjectBucketAdapter;
  injectFaultOnce(stage: string): void;
  readState(): Promise<Readonly<DomainStateSnapshot>>;
  runInTransaction<T>(
    stageName: string,
    fn: (draft: DomainStateSnapshot) => T | Promise<T>,
  ): Promise<T>;
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes).buffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class InMemoryObjectBucket implements ObjectBucketAdapter {
  private readonly objects = new Map<string, { data: Uint8Array; mimeType: string }>();

  async put(key: string, data: Uint8Array, mimeType: string): Promise<void> {
    this.objects.set(key, { data: new Uint8Array(data), mimeType });
  }

  async get(key: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { data: new Uint8Array(found.data), mimeType: found.mimeType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async read(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = range
      ? object.data.slice(range.offset, range.offset + range.length)
      : new Uint8Array(object.data);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

export class TransactionalMemoryStore implements DomainStore {
  private state: DomainStateSnapshot = createEmptyStateSnapshot();

  readonly bucket: ObjectBucketAdapter;
  private faultStages = new Set<string>();

  constructor(bucket?: ObjectBucketAdapter) {
    this.bucket = bucket ?? new InMemoryObjectBucket();
  }

  injectFaultOnce(stage: string): void {
    this.faultStages.add(stage);
  }

  checkFault(stage: string): void {
    if (this.faultStages.has(stage)) {
      this.faultStages.delete(stage);
      throw new DomainError(
        "INTERNAL_ERROR",
        `Simulated transactional commit failure at stage '${stage}'.`,
      );
    }
  }

  async readState(): Promise<Readonly<DomainStateSnapshot>> {
    return structuredClone(this.state);
  }

  async runInTransaction<T>(
    stageName: string,
    fn: (draft: DomainStateSnapshot) => T | Promise<T>,
  ): Promise<T> {
    const workingCopy = structuredClone(this.state);
    const result = await fn(workingCopy);
    this.checkFault(stageName);
    this.state = workingCopy;
    return structuredClone(result);
  }
}
