import { canonicalizeJson, type ActorIdentity } from "@video-compose/protocol";
import { DomainError } from "./types.ts";
import {
  resourceKey,
  type DomainStateSnapshot,
  type DomainStore,
} from "./storage.ts";
export type ResourceKind = "project" | "composition";
export interface LifecycleEvent {
  revision: number;
  action: "trash" | "restore";
  actorId: string;
  operationId: string;
  createdAt: string;
}
export interface LifecycleRecord {
  projectId: string;
  kind: ResourceKind;
  id: string;
  headRevision: number;
  events: Record<number, LifecycleEvent>;
}
export interface TrashItem {
  projectId: string;
  kind: ResourceKind;
  id: string;
  title: string;
  lifecycleRevision: number;
  deletedAt: string;
  deletedBy: string;
  canRestore?: boolean;
  parentTrashed: boolean;
  compositionHeadRevision?: number;
  compositionCount?: number;
}
export const lifecycleKey = (
  projectId: string,
  kind: ResourceKind,
  id: string,
) => canonicalizeJson([projectId, kind, id]);
export const lifecycleRecord = (
  s: Readonly<DomainStateSnapshot>,
  p: string,
  k: ResourceKind,
  id: string,
) => s.lifecycle[lifecycleKey(p, k, id)];
export const isTrashed = (
  s: Readonly<DomainStateSnapshot>,
  p: string,
  k: ResourceKind,
  id: string,
) => {
  const r = lifecycleRecord(s, p, k, id);
  return r?.events[r.headRevision].action === "trash";
};
export function assertCompositionActive(
  s: Readonly<DomainStateSnapshot>,
  projectId: string,
  id: string,
) {
  if (isTrashed(s, projectId, "composition", id))
    throw new DomainError(
      "RESOURCE_TRASHED",
      "Composition is in the recycle bin. Restore it before reading or editing.",
    );
}
export const userIdOf = (a: ActorIdentity) =>
  a.userId ?? (a.actorKind === "human" ? a.actorId.toLowerCase() : a.actorId);
export function inferProjectOwner(project: {
  createdBy: string;
  members: Record<string, unknown>;
  ownerUserId?: string;
}) {
  if (project.ownerUserId) return project.ownerUserId;
  if (project.createdBy.includes("@")) return project.createdBy.toLowerCase();
  const humans = Object.entries(project.members)
    .filter(([id, role]) => id.includes("@") && role === "writer")
    .map(([id]) => id.toLowerCase());
  return humans.length === 1 ? humans[0] : project.createdBy;
}
type Access = (
  state: Readonly<DomainStateSnapshot>,
  projectId: string,
  actor: ActorIdentity | null | undefined,
  role: "reader" | "writer",
  includeTrash?: boolean,
) => { actor: ActorIdentity; project: import("./types.ts").ProjectRecord };
export class LifecycleService {
  private store: DomainStore;
  private access: Access;
  constructor(store: DomainStore, access: Access) {
    this.store = store;
    this.access = access;
  }
  async list(actor: ActorIdentity | null | undefined): Promise<TrashItem[]> {
    if (!actor)
      throw new DomainError("UNAUTHORIZED", "Authentication is required.");
    const s = await this.store.readState();
    const result: TrashItem[] = [];
    for (const r of Object.values(s.lifecycle)) {
      const e = r.events[r.headRevision];
      if (e.action !== "trash") continue;
      const p = s.projects[r.projectId];
      if (
        !p ||
        (!p.members[actor.actorId] &&
          actor.actorId.toLowerCase() !== inferProjectOwner(p)) ||
        (inferProjectOwner(p) !== userIdOf(actor) &&
          p.sharingMode !== "members")
      )
        continue;
      const c = s.compositions[resourceKey(r.projectId, r.id)];
      result.push({
        projectId: r.projectId,
        kind: r.kind,
        id: r.id,
        title: r.kind === "project" ? p.name : (c?.title ?? r.id),
        lifecycleRevision: r.headRevision,
        deletedAt: e.createdAt,
        deletedBy: e.actorId,
        canRestore:
          (p.members[actor.actorId] === "writer" ||
            actor.actorId.toLowerCase() === inferProjectOwner(p)) &&
          (r.kind === "composition" ||
            inferProjectOwner(p) === userIdOf(actor)),
        parentTrashed:
          r.kind === "composition" &&
          isTrashed(s, r.projectId, "project", r.projectId),
        ...(r.kind === "composition"
          ? { compositionHeadRevision: c?.headRevision }
          : {
              compositionCount: Object.values(s.compositions).filter(
                (c) => c.projectId === r.projectId,
              ).length,
            }),
      });
    }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  async change(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      kind: ResourceKind;
      id: string;
      action: "trash" | "restore";
      baseRevision: number;
      operationId: string;
      expectedHeadRevision?: number;
    },
  ): Promise<{ revision: number; event: LifecycleEvent }> {
    return this.store.runInTransaction("lifecycleChange", (draft) => {
      const { actor: who, project } = this.access(
        draft,
        input.projectId,
        actor,
        "writer",
        true,
      );
      if (
        input.kind === "project" &&
        inferProjectOwner(project) !== userIdOf(who)
      )
        throw new DomainError(
          "FORBIDDEN",
          "Only the owner can trash or restore a project.",
        );
      if (
        !["project", "composition"].includes(input.kind) ||
        !["trash", "restore"].includes(input.action) ||
        !input.id?.trim() ||
        !input.operationId?.trim() ||
        !Number.isInteger(input.baseRevision) ||
        input.baseRevision < 0
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "Resource, action, baseRevision and operationId are required.",
        );
      if (input.kind === "project" && input.id !== input.projectId)
        throw new DomainError(
          "VALIDATION_FAILED",
          "Project identity does not match.",
        );
      const comp =
        input.kind === "composition"
          ? draft.compositions[resourceKey(input.projectId, input.id)]
          : undefined;
      if (input.kind === "composition" && !comp)
        throw new DomainError("NOT_FOUND", "Composition not found.");
      const receiptKey = canonicalizeJson([
        "lifecycle",
        input.projectId,
        who.actorId,
        input.operationId,
      ]);
      const fingerprint = canonicalizeJson(input);
      const receipt = draft.idempotencyRecords[receiptKey] as
        | {
            fingerprint: string;
            result: { revision: number; event: LifecycleEvent };
          }
        | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError(
            "VALIDATION_FAILED",
            "operationId was reused with different content.",
          );
        return receipt.result;
      }
      if (
        input.kind === "composition" &&
        isTrashed(draft, input.projectId, "project", input.projectId)
      )
        throw new DomainError(
          "PARENT_TRASHED",
          "Restore the project before changing a composition.",
        );
      const k = lifecycleKey(input.projectId, input.kind, input.id);
      const record = draft.lifecycle[k] ?? {
        projectId: input.projectId,
        kind: input.kind,
        id: input.id,
        headRevision: 0,
        events: {},
      };
      if (input.baseRevision !== record.headRevision)
        throw new DomainError(
          "REVISION_CONFLICT",
          "Recycle-bin state changed. Reload and retry.",
          { headRevision: record.headRevision },
        );
      if (comp && input.expectedHeadRevision !== comp.headRevision)
        throw new DomainError(
          "REVISION_CONFLICT",
          "Composition content changed. Reload before deleting or restoring.",
          { headRevision: comp.headRevision },
        );
      const deleted =
        record.headRevision > 0 &&
        record.events[record.headRevision].action === "trash";
      if ((input.action === "trash") === deleted)
        throw new DomainError(
          "VALIDATION_FAILED",
          deleted
            ? "Resource is already trashed."
            : "Resource is not in the recycle bin.",
        );
      const event: LifecycleEvent = {
        revision: record.headRevision + 1,
        action: input.action,
        actorId: who.actorId,
        operationId: input.operationId,
        createdAt: new Date().toISOString(),
      };
      record.headRevision = event.revision;
      record.events[event.revision] = event;
      draft.lifecycle[k] = record;
      const result = { revision: event.revision, event };
      draft.idempotencyRecords[receiptKey] = { fingerprint, result };
      return result;
    });
  }
}
