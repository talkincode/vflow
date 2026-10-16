import type { CompositionDocument } from "@video-compose/protocol";
import {
  type ChangeRecord,
  type ConflictDetail,
  DomainError,
  type TypedOperation,
} from "./types.ts";

export function computeOperationPaths(op: TypedOperation): string[] {
  switch (op.op) {
    case "upsert_shot": {
      const paths = [`shots.${op.shotId}`];
      if (op.afterShotId !== undefined) {
        paths.push(`sequence.anchor:${op.afterShotId ?? "$START"}`);
      } else {
        paths.push(`sequence.shot:${op.shotId}`);
      }
      return paths;
    }
    case "update_shot_fields": {
      const paths: string[] = [];
      if (op.description !== undefined) paths.push(`shots.${op.shotId}.description`);
      if (op.durationFrames !== undefined) paths.push(`shots.${op.shotId}.durationFrames`);
      if (op.dependsOn !== undefined) paths.push(`shots.${op.shotId}.dependsOn`);
      if (op.prompts) {
        if (op.prompts.image !== undefined) paths.push(`shots.${op.shotId}.prompts.image`);
        if (op.prompts.video !== undefined) paths.push(`shots.${op.shotId}.prompts.video`);
        if (op.prompts.audio !== undefined) paths.push(`shots.${op.shotId}.prompts.audio`);
      }
      if (paths.length === 0) {
        paths.push(`shots.${op.shotId}`);
      }
      return paths;
    }
    case "delete_shot":
      return [`shots.${op.shotId}`, "sequence"];
    case "attach_shot_candidate":
      return [`shots.${op.shotId}.candidates.${op.mediaKind}.${op.candidate.asset}`];
    case "select_shot_output":
      return [`shots.${op.shotId}.selected.${op.mediaKind}`];
    case "bind_shot_subject":
      return [`shots.${op.shotId}.subjects.${op.binding.subjectId}`];
    case "upsert_audio_track":
      return [`audioTracks.${op.track.id}`];
    case "delete_audio_track":
      return [`audioTracks.${op.trackId}`];
    case "reorder_sequence":
      return ["sequence"];
  }
}

export function pathsOverlap(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  if (pathA.startsWith(`${pathB}.`) || pathB.startsWith(`${pathA}.`)) return true;
  return false;
}

export function detectConflictsAgainstHistory(
  incomingOps: TypedOperation[],
  baseRevision: number,
  headRevision: number,
  interveningChanges: ChangeRecord[],
): ConflictDetail[] {
  const incomingPaths = incomingOps.flatMap(computeOperationPaths);
  const conflicts: ConflictDetail[] = [];

  for (const change of interveningChanges) {
    for (const incomingPath of incomingPaths) {
      for (const committedPath of change.touchedPaths) {
        if (pathsOverlap(incomingPath, committedPath)) {
          conflicts.push({
            path: incomingPath,
            baseRevision,
            headRevision,
            competingActorId: change.actorId,
            reason: `Path '${incomingPath}' conflicts with '${committedPath}' modified in revision ${change.resultRevision} by '${change.actorId}'.`,
          });
        }
      }
    }
  }

  return conflicts;
}

export function applyTypedOperations(
  baseDoc: CompositionDocument,
  operations: TypedOperation[],
): CompositionDocument {
  const doc: CompositionDocument = structuredClone(baseDoc);

  for (const op of operations) {
    switch (op.op) {
      case "upsert_shot": {
        doc.shots[op.shotId] = structuredClone(op.shot);
        const existingIdx = doc.sequence.indexOf(op.shotId);
        if (existingIdx === -1) {
          if (op.afterShotId === null) {
            doc.sequence.unshift(op.shotId);
          } else if (typeof op.afterShotId === "string") {
            const anchorIdx = doc.sequence.indexOf(op.afterShotId);
            if (anchorIdx === -1) {
              throw new DomainError(
                "VALIDATION_FAILED",
                `Anchor shot '${op.afterShotId}' not found in sequence.`,
              );
            }
            doc.sequence.splice(anchorIdx + 1, 0, op.shotId);
          } else {
            doc.sequence.push(op.shotId);
          }
        }
        break;
      }

      case "update_shot_fields": {
        const target = doc.shots[op.shotId];
        if (!target) {
          throw new DomainError("NOT_FOUND", `Shot '${op.shotId}' does not exist.`);
        }
        if (op.description !== undefined) {
          target.description = op.description;
        }
        if (op.durationFrames !== undefined) {
          target.durationFrames = op.durationFrames;
        }
        if (op.dependsOn !== undefined) {
          target.dependsOn = structuredClone(op.dependsOn);
        }
        if (op.prompts) {
          target.prompts = {
            ...target.prompts,
            ...structuredClone(op.prompts),
          };
        }
        break;
      }

      case "delete_shot": {
        if (!doc.shots[op.shotId]) {
          throw new DomainError("NOT_FOUND", `Shot '${op.shotId}' does not exist.`);
        }
        for (const [otherId, otherShot] of Object.entries(doc.shots)) {
          if (otherId === op.shotId) continue;
          if (otherShot.dependsOn.some((d) => d.shotId === op.shotId)) {
            throw new DomainError(
              "DEPENDENCY_ERROR",
              `Cannot delete shot '${op.shotId}' because shot '${otherId}' depends on it.`,
            );
          }
        }
        delete doc.shots[op.shotId];
        doc.sequence = doc.sequence.filter((id) => id !== op.shotId);
        break;
      }

      case "attach_shot_candidate": {
        const target = doc.shots[op.shotId];
        if (!target) {
          throw new DomainError("NOT_FOUND", `Shot '${op.shotId}' does not exist.`);
        }
        const list = target.candidates[op.mediaKind];
        const existingIdx = list.findIndex((c) => c.asset === op.candidate.asset);
        if (existingIdx >= 0) {
          list[existingIdx] = structuredClone(op.candidate);
        } else {
          list.push(structuredClone(op.candidate));
        }
        break;
      }

      case "select_shot_output": {
        const target = doc.shots[op.shotId];
        if (!target) {
          throw new DomainError("NOT_FOUND", `Shot '${op.shotId}' does not exist.`);
        }
        target.selected[op.mediaKind] = op.assetId;
        break;
      }

      case "bind_shot_subject": {
        const target = doc.shots[op.shotId];
        if (!target) {
          throw new DomainError("NOT_FOUND", `Shot '${op.shotId}' does not exist.`);
        }
        const existingIdx = target.subjects.findIndex(
          (s) => s.subjectId === op.binding.subjectId,
        );
        const clonedBinding = structuredClone(op.binding);
        if (existingIdx >= 0) {
          target.subjects[existingIdx] = clonedBinding;
        } else {
          target.subjects.push(clonedBinding);
        }
        break;
      }

      case "upsert_audio_track": {
        const existingIdx = doc.audioTracks.findIndex((t) => t.id === op.track.id);
        const clonedTrack = structuredClone(op.track);
        if (existingIdx >= 0) {
          doc.audioTracks[existingIdx] = clonedTrack;
        } else {
          doc.audioTracks.push(clonedTrack);
        }
        break;
      }

      case "delete_audio_track": {
        const existingIdx = doc.audioTracks.findIndex((t) => t.id === op.trackId);
        if (existingIdx === -1) {
          throw new DomainError(
            "NOT_FOUND",
            `AudioTrack '${op.trackId}' does not exist.`,
          );
        }
        doc.audioTracks.splice(existingIdx, 1);
        break;
      }

      case "reorder_sequence": {
        const currentIdx = doc.sequence.indexOf(op.shotId);
        if (currentIdx === -1) {
          throw new DomainError(
            "NOT_FOUND",
            `Shot '${op.shotId}' is not in sequence.`,
          );
        }
        doc.sequence.splice(currentIdx, 1);
        if (op.afterShotId === null) {
          doc.sequence.unshift(op.shotId);
        } else {
          const anchorIdx = doc.sequence.indexOf(op.afterShotId);
          if (anchorIdx === -1) {
            throw new DomainError(
              "VALIDATION_FAILED",
              `Anchor shot '${op.afterShotId}' is not in sequence.`,
            );
          }
          doc.sequence.splice(anchorIdx + 1, 0, op.shotId);
        }
        break;
      }
    }
  }

  return doc;
}
