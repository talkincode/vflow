import {
  type AssetReference,
  type AudioTrackDefinition,
  type AudioTrackRole,
  type CandidateEntry,
  type CompositionDocument,
  type PortableCompositionBundle,
  PROTOCOL_VERSION,
  type ProtocolValidationError,
  type ProtocolValidationResult,
  type ReferencePackEntry,
  type RevisionStatus,
  type ShotDefinition,
  type ShotDependency,
  type ShotDependencyKind,
  type ShotSubjectBinding,
  type SubjectKind,
  type SubjectManifest,
  type SubjectSnapshot,
  type SubjectVariant,
  type ValidationContext,
} from "./types.ts";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isPositiveInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val >= 1;
}

function isNonNegativeInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val >= 0;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

function isPermanentUrlLike(id: string): boolean {
  return /^https?:\/\//i.test(id) || id.includes("X-Amz-Signature") || id.includes("?token=");
}

const VALID_DEPENDENCY_KINDS = new Set<ShotDependencyKind>([
  "continuity",
  "last_frame",
  "narrative",
  "reference",
]);

const VALID_AUDIO_ROLES = new Set<AudioTrackRole>(["bgm", "voiceover", "ambience", "sfx"]);
const VALID_SUBJECT_KINDS = new Set<SubjectKind>(["character", "prop"]);
const VALID_REVISION_STATUSES = new Set<RevisionStatus>(["candidate", "approved"]);

export function subjectRevisionKey(subjectId: string, revision: number): string {
  return `${subjectId}@${revision}`;
}

export function validateSubjectSnapshot(
  raw: unknown,
  basePath: string,
  context?: ValidationContext,
): { snapshot?: SubjectSnapshot; errors: ProtocolValidationError[] } {
  const errors: ProtocolValidationError[] = [];
  if (!isRecord(raw)) {
    errors.push({
      code: "INVALID_TYPE",
      path: basePath,
      message: "Subject must be an object.",
    });
    return { errors };
  }

  if (!isNonEmptyString(raw.id)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: `${basePath}.id`,
      message: "Subject id must be a non-empty string.",
    });
  }

  if (!isNonEmptyString(raw.kind) || !VALID_SUBJECT_KINDS.has(raw.kind as SubjectKind)) {
    errors.push({
      code: "INVALID_SUBJECT",
      path: `${basePath}.kind`,
      message: "Subject kind must be 'character' or 'prop'.",
    });
  }

  if (!isPositiveInteger(raw.revision)) {
    errors.push({
      code: "INVALID_SUBJECT",
      path: `${basePath}.revision`,
      message: "Subject revision must be a positive integer.",
    });
  }

  const rawStatus =
    raw.status ??
    (isRecord(raw.approval) && isNonEmptyString(raw.approval.status)
      ? raw.approval.status
      : undefined);

  if (!isNonEmptyString(rawStatus) || !VALID_REVISION_STATUSES.has(rawStatus as RevisionStatus)) {
    errors.push({
      code: "INVALID_SUBJECT",
      path: `${basePath}.status`,
      message: "Subject status must be 'candidate' or 'approved'.",
    });
  }

  if (!isNonEmptyString(raw.name)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: `${basePath}.name`,
      message: "Subject name must be a non-empty string.",
    });
  }

  if (!isRecord(raw.definition) || typeof raw.definition.description !== "string") {
    errors.push({
      code: "INVALID_SUBJECT",
      path: `${basePath}.definition`,
      message: "Subject definition.description is required.",
    });
  }

  const invariantsRaw = isRecord(raw.definition) ? raw.definition.invariants : undefined;
  const invariants: string[] = [];
  if (!Array.isArray(invariantsRaw) || !invariantsRaw.every((item) => typeof item === "string")) {
    errors.push({
      code: "INVALID_SUBJECT",
      path: `${basePath}.definition.invariants`,
      message: "Subject definition.invariants must be an array of strings.",
    });
  } else {
    invariants.push(...invariantsRaw);
  }

  const variants: Record<string, SubjectVariant> = {};
  if (!isRecord(raw.variants) || Object.keys(raw.variants).length === 0) {
    errors.push({
      code: "INVALID_SUBJECT",
      path: `${basePath}.variants`,
      message: "Subject must define at least one variant.",
    });
  } else {
    for (const [variantKey, variantVal] of Object.entries(raw.variants)) {
      const vPath = `${basePath}.variants.${variantKey}`;
      if (!isRecord(variantVal) || typeof variantVal.description !== "string") {
        errors.push({
          code: "INVALID_SUBJECT",
          path: vPath,
          message: "Variant must include a string description.",
        });
        continue;
      }
      if (!Array.isArray(variantVal.referencePack) || variantVal.referencePack.length === 0) {
        errors.push({
          code: "INVALID_SUBJECT",
          path: `${vPath}.referencePack`,
          message: "Variant referencePack must be a non-empty array.",
        });
        continue;
      }
      const pack: ReferencePackEntry[] = [];
      variantVal.referencePack.forEach((entry, idx) => {
        const ePath = `${vPath}.referencePack[${idx}]`;
        if (!isRecord(entry) || !isNonEmptyString(entry.asset)) {
          errors.push({
            code: "INVALID_SUBJECT",
            path: `${ePath}.asset`,
            message: "ReferencePack entry must specify a valid asset ID.",
          });
          return;
        }
        if (isPermanentUrlLike(entry.asset)) {
          errors.push({
            code: "INVALID_SUBJECT",
            path: `${ePath}.asset`,
            message: "ReferencePack asset must be a stable assetId, not a URL.",
          });
        }
        if (context?.availableAssets && !context.availableAssets.has(entry.asset)) {
          errors.push({
            code: "MISSING_ASSET_REFERENCE",
            path: `${ePath}.asset`,
            message: `Referenced asset '${entry.asset}' does not exist in project.`,
          });
        }
        const entryStatus = (entry.status ?? rawStatus ?? "candidate") as RevisionStatus;
        if (!VALID_REVISION_STATUSES.has(entryStatus)) {
          errors.push({
            code: "INVALID_SUBJECT",
            path: `${ePath}.status`,
            message: "ReferencePack entry status must be 'candidate' or 'approved'.",
          });
        }
        if (rawStatus === "approved" && entryStatus !== "approved") {
          errors.push({
            code: "INVALID_SUBJECT",
            path: `${ePath}.status`,
            message: "An approved SubjectRevision cannot contain unapproved referencePack entries.",
          });
        }
        const normalizedEntry: ReferencePackEntry = {
          asset: entry.asset,
          status: entryStatus,
        };
        if (isNonEmptyString(entry.view)) normalizedEntry.view = entry.view;
        if (isNonEmptyString(entry.purpose)) normalizedEntry.purpose = entry.purpose;
        if (typeof entry.notes === "string") normalizedEntry.notes = entry.notes;
        if (isRecord(entry.provenance)) {
          normalizedEntry.provenance = structuredClone(entry.provenance);
        }
        pack.push(normalizedEntry);
      });
      variants[variantKey] = {
        description: variantVal.description,
        referencePack: pack,
      };
    }
  }

  let defaultVariant: string | undefined;
  if (raw.defaultVariant !== undefined) {
    if (!isNonEmptyString(raw.defaultVariant) || !(raw.defaultVariant in variants)) {
      errors.push({
        code: "INVALID_SUBJECT",
        path: `${basePath}.defaultVariant`,
        message: "defaultVariant must match a defined variant key.",
      });
    } else {
      defaultVariant = raw.defaultVariant;
    }
  } else if (Object.keys(variants).length === 1) {
    defaultVariant = Object.keys(variants)[0];
  }

  if (errors.length > 0) {
    return { errors };
  }

  const snapshot: SubjectSnapshot = {
    id: raw.id as string,
    kind: raw.kind as SubjectKind,
    revision: raw.revision as number,
    status: rawStatus as RevisionStatus,
    name: raw.name as string,
    ...(defaultVariant ? { defaultVariant } : {}),
    definition: {
      description: (raw.definition as Record<string, unknown>).description as string,
      invariants,
    },
    variants,
    ...(isRecord(raw.extensions) ? { extensions: structuredClone(raw.extensions) } : {}),
  };

  return { snapshot, errors: [] };
}

export function validateSubjectManifest(
  input: unknown,
  context?: ValidationContext,
): ProtocolValidationResult<SubjectManifest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_TYPE",
          path: "$",
          message: "Subject manifest must be an object.",
        },
      ],
    };
  }

  const errors: ProtocolValidationError[] = [];
  if (input.apiVersion !== PROTOCOL_VERSION) {
    errors.push({
      code: "UNSUPPORTED_API_VERSION",
      path: "$.apiVersion",
      message: `Unsupported apiVersion '${String(input.apiVersion)}'. Expected '${PROTOCOL_VERSION}'.`,
    });
  }

  const { snapshot, errors: subjErrors } = validateSubjectSnapshot(
    input.subject,
    "$.subject",
    context,
  );
  errors.push(...subjErrors);

  if (errors.length > 0 || !snapshot) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      apiVersion: PROTOCOL_VERSION,
      subject: snapshot,
    },
    errors: [],
  };
}

function detectDependencyCycles(
  shots: Record<string, ShotDefinition>,
): ProtocolValidationError[] {
  const errors: ProtocolValidationError[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function dfs(shotId: string): void {
    state.set(shotId, "visiting");
    stack.push(shotId);

    const shot = shots[shotId];
    if (shot) {
      for (const dep of shot.dependsOn) {
        if (!shots[dep.shotId]) continue;
        const depState = state.get(dep.shotId);
        if (depState === "visiting") {
          const cycleStart = stack.indexOf(dep.shotId);
          const cyclePath = [...stack.slice(cycleStart), dep.shotId].join(" -> ");
          errors.push({
            code: "DEPENDENCY_CYCLE",
            path: `$.shots.${shotId}.dependsOn`,
            message: `Circular shot dependency detected: ${cyclePath}`,
          });
        } else if (!depState) {
          dfs(dep.shotId);
        }
      }
    }

    stack.pop();
    state.set(shotId, "visited");
  }

  for (const shotId of Object.keys(shots)) {
    if (!state.has(shotId)) {
      dfs(shotId);
    }
  }

  return errors;
}

export function validateCompositionDocument(
  input: unknown,
  context?: ValidationContext,
): ProtocolValidationResult<CompositionDocument> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_TYPE",
          path: "$",
          message: "Composition document must be an object.",
        },
      ],
    };
  }

  const errors: ProtocolValidationError[] = [];

  if (input.apiVersion !== PROTOCOL_VERSION) {
    errors.push({
      code: "UNSUPPORTED_API_VERSION",
      path: "$.apiVersion",
      message: `Unsupported apiVersion '${String(input.apiVersion)}'. Expected '${PROTOCOL_VERSION}'.`,
    });
  }

  if (!isNonEmptyString(input.id)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: "$.id",
      message: "Composition 'id' must be a non-empty string.",
    });
  }

  if (!isNonEmptyString(input.project)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: "$.project",
      message: "Composition 'project' must be a non-empty string.",
    });
  }

  if (!isRecord(input.format)) {
    errors.push({
      code: "INVALID_FORMAT",
      path: "$.format",
      message: "Composition 'format' is required.",
    });
  } else {
    if (!isPositiveInteger(input.format.width)) {
      errors.push({
        code: "INVALID_FORMAT",
        path: "$.format.width",
        message: "format.width must be a positive integer.",
      });
    }
    if (!isPositiveInteger(input.format.height)) {
      errors.push({
        code: "INVALID_FORMAT",
        path: "$.format.height",
        message: "format.height must be a positive integer.",
      });
    }
    if (!isPositiveInteger(input.format.fps)) {
      errors.push({
        code: "INVALID_FORMAT",
        path: "$.format.fps",
        message: "format.fps must be a positive integer.",
      });
    }
  }

  const checkAssetRef = (assetId: unknown, path: string): assetId is string => {
    if (!isNonEmptyString(assetId)) {
      errors.push({
        code: "MISSING_REQUIRED_FIELD",
        path,
        message: "Asset reference must be a non-empty string.",
      });
      return false;
    }
    if (isPermanentUrlLike(assetId)) {
      errors.push({
        code: "MISSING_ASSET_REFERENCE",
        path,
        message: `Asset reference '${assetId}' must be an immutable assetId, not a URL.`,
      });
      return false;
    }
    if (context?.availableAssets && !context.availableAssets.has(assetId)) {
      errors.push({
        code: "MISSING_ASSET_REFERENCE",
        path,
        message: `Referenced asset '${assetId}' does not exist in project.`,
      });
      return false;
    }
    return true;
  };

  const audioTracks: AudioTrackDefinition[] = [];
  const seenTrackIds = new Set<string>();
  if (input.audioTracks !== undefined) {
    if (!Array.isArray(input.audioTracks)) {
      errors.push({
        code: "INVALID_AUDIO_TRACK",
        path: "$.audioTracks",
        message: "audioTracks must be an array.",
      });
    } else {
      input.audioTracks.forEach((rawTrack, idx) => {
        const tPath = `$.audioTracks[${idx}]`;
        if (!isRecord(rawTrack)) {
          errors.push({
            code: "INVALID_AUDIO_TRACK",
            path: tPath,
            message: "AudioTrack must be an object.",
          });
          return;
        }
        if (!isNonEmptyString(rawTrack.id)) {
          errors.push({
            code: "INVALID_AUDIO_TRACK",
            path: `${tPath}.id`,
            message: "AudioTrack id must be a non-empty string.",
          });
        } else if (seenTrackIds.has(rawTrack.id)) {
          errors.push({
            code: "DUPLICATE_AUDIO_TRACK_ID",
            path: `${tPath}.id`,
            message: `Duplicate audioTrack id '${rawTrack.id}'.`,
          });
        } else {
          seenTrackIds.add(rawTrack.id);
        }

        if (
          !isNonEmptyString(rawTrack.role) ||
          !VALID_AUDIO_ROLES.has(rawTrack.role as AudioTrackRole)
        ) {
          errors.push({
            code: "INVALID_AUDIO_TRACK",
            path: `${tPath}.role`,
            message: "AudioTrack role must be one of 'bgm', 'voiceover', 'ambience', 'sfx'.",
          });
        }

        checkAssetRef(rawTrack.asset, `${tPath}.asset`);

        if (!isNonNegativeInteger(rawTrack.startFrame)) {
          errors.push({
            code: "INVALID_AUDIO_TRACK",
            path: `${tPath}.startFrame`,
            message: "AudioTrack startFrame must be a non-negative integer.",
          });
        }

        if (!isPositiveInteger(rawTrack.durationFrames)) {
          errors.push({
            code: "INVALID_AUDIO_TRACK",
            path: `${tPath}.durationFrames`,
            message: "AudioTrack durationFrames must be a positive integer.",
          });
        }

        if (
          rawTrack.trimStartFrame !== undefined &&
          !isNonNegativeInteger(rawTrack.trimStartFrame)
        ) {
          errors.push({
            code: "INVALID_AUDIO_TRACK",
            path: `${tPath}.trimStartFrame`,
            message: "AudioTrack trimStartFrame must be a non-negative integer.",
          });
        }

        if (
          isNonEmptyString(rawTrack.id) &&
          isNonEmptyString(rawTrack.role) &&
          isNonEmptyString(rawTrack.asset) &&
          isNonNegativeInteger(rawTrack.startFrame) &&
          isPositiveInteger(rawTrack.durationFrames)
        ) {
          audioTracks.push({
            id: rawTrack.id,
            role: rawTrack.role as AudioTrackRole,
            asset: rawTrack.asset,
            startFrame: rawTrack.startFrame,
            durationFrames: rawTrack.durationFrames,
            ...(rawTrack.trimStartFrame !== undefined
              ? { trimStartFrame: rawTrack.trimStartFrame as number }
              : {}),
            ...(typeof rawTrack.notes === "string" ? { notes: rawTrack.notes } : {}),
            ...(isRecord(rawTrack.extensions)
              ? { extensions: structuredClone(rawTrack.extensions) }
              : {}),
          });
        }
      });
    }
  }

  const shots: Record<string, ShotDefinition> = {};
  if (!isRecord(input.shots)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: "$.shots",
      message: "Composition 'shots' must be an object map.",
    });
  } else {
    for (const [shotId, rawShot] of Object.entries(input.shots)) {
      const sPath = `$.shots.${shotId}`;
      if (!isNonEmptyString(shotId)) {
        errors.push({
          code: "MISSING_REQUIRED_FIELD",
          path: sPath,
          message: "Shot ID must be non-empty.",
        });
        continue;
      }
      if (!isRecord(rawShot)) {
        errors.push({
          code: "INVALID_TYPE",
          path: sPath,
          message: "Shot definition must be an object.",
        });
        continue;
      }
      if (typeof rawShot.description !== "string") {
        errors.push({
          code: "MISSING_REQUIRED_FIELD",
          path: `${sPath}.description`,
          message: "Shot description must be a string.",
        });
      }
      if (rawShot.durationFrames !== undefined && !isPositiveInteger(rawShot.durationFrames)) {
        errors.push({
          code: "INVALID_DURATION_FRAMES",
          path: `${sPath}.durationFrames`,
          message: "Shot durationFrames must be a positive integer (frame count).",
        });
      }

      const dependsOn: ShotDependency[] = [];
      if (rawShot.dependsOn !== undefined) {
        if (!Array.isArray(rawShot.dependsOn)) {
          errors.push({
            code: "INVALID_TYPE",
            path: `${sPath}.dependsOn`,
            message: "Shot dependsOn must be an array.",
          });
        } else {
          rawShot.dependsOn.forEach((dep, dIdx) => {
            const dPath = `${sPath}.dependsOn[${dIdx}]`;
            if (!isRecord(dep) || !isNonEmptyString(dep.shotId)) {
              errors.push({
                code: "MISSING_REQUIRED_FIELD",
                path: `${dPath}.shotId`,
                message: "Dependency must specify a non-empty shotId.",
              });
              return;
            }
            const kind = (dep.kind ?? "continuity") as ShotDependencyKind;
            if (!VALID_DEPENDENCY_KINDS.has(kind)) {
              errors.push({
                code: "INVALID_TYPE",
                path: `${dPath}.kind`,
                message: "Dependency kind must be continuity, last_frame, narrative, or reference.",
              });
              return;
            }
            dependsOn.push({
              shotId: dep.shotId,
              kind,
              ...(typeof dep.notes === "string" ? { notes: dep.notes } : {}),
            });
          });
        }
      }

      const subjects: ShotSubjectBinding[] = [];
      if (rawShot.subjects !== undefined) {
        if (!Array.isArray(rawShot.subjects)) {
          errors.push({
            code: "INVALID_TYPE",
            path: `${sPath}.subjects`,
            message: "Shot subjects must be an array.",
          });
        } else {
          rawShot.subjects.forEach((binding, bIdx) => {
            const bPath = `${sPath}.subjects[${bIdx}]`;
            if (!isRecord(binding) || !isNonEmptyString(binding.subjectId)) {
              errors.push({
                code: "MISSING_REQUIRED_FIELD",
                path: `${bPath}.subjectId`,
                message: "Shot subject binding requires subjectId.",
              });
              return;
            }
            if (!isPositiveInteger(binding.subjectRevision)) {
              errors.push({
                code: "MISSING_REQUIRED_FIELD",
                path: `${bPath}.subjectRevision`,
                message: "Shot subject binding requires positive integer subjectRevision (never 'latest').",
              });
              return;
            }
            const variant =
              binding.variant !== undefined ? String(binding.variant) : undefined;
            if (context?.availableSubjects) {
              const key = subjectRevisionKey(binding.subjectId, binding.subjectRevision);
              const subj = context.availableSubjects.get(key);
              if (!subj) {
                errors.push({
                  code: "MISSING_SUBJECT_REVISION",
                  path: bPath,
                  message: `Pinned subject revision '${key}' does not exist in project.`,
                });
              } else {
                const resolvedVariant = variant ?? subj.defaultVariant;
                if (!resolvedVariant || !(resolvedVariant in subj.variants)) {
                  errors.push({
                    code: "MISSING_SUBJECT_VARIANT",
                    path: `${bPath}.variant`,
                    message: `Subject '${key}' cannot resolve variant '${resolvedVariant ?? "(omitted)"}'.`,
                  });
                }
              }
            }
            subjects.push({
              subjectId: binding.subjectId,
              subjectRevision: binding.subjectRevision,
              ...(variant ? { variant } : {}),
            });
          });
        }
      }

      const parseAssetRefList = (listRaw: unknown, rPath: string): AssetReference[] => {
        if (listRaw === undefined) return [];
        if (!Array.isArray(listRaw)) {
          errors.push({
            code: "INVALID_TYPE",
            path: rPath,
            message: "Asset reference list must be an array.",
          });
          return [];
        }
        const out: AssetReference[] = [];
        listRaw.forEach((item, idx) => {
          const itemPath = `${rPath}[${idx}]`;
          if (!isRecord(item)) {
            errors.push({
              code: "INVALID_TYPE",
              path: itemPath,
              message: "Asset reference must be an object.",
            });
            return;
          }
          if (checkAssetRef(item.asset, `${itemPath}.asset`)) {
            out.push({
              asset: item.asset,
              ...(typeof item.role === "string" ? { role: item.role } : {}),
              ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
            });
          }
        });
        return out;
      };

      const rawRefs = isRecord(rawShot.references) ? rawShot.references : {};
      const refImages = parseAssetRefList(rawRefs.images, `${sPath}.references.images`);
      const refVideos = parseAssetRefList(rawRefs.videos, `${sPath}.references.videos`);

      const parseCandidateList = (listRaw: unknown, cPath: string): CandidateEntry[] => {
        if (listRaw === undefined) return [];
        if (!Array.isArray(listRaw)) {
          errors.push({
            code: "INVALID_TYPE",
            path: cPath,
            message: "Candidates list must be an array.",
          });
          return [];
        }
        const out: CandidateEntry[] = [];
        listRaw.forEach((item, idx) => {
          const itemPath = `${cPath}[${idx}]`;
          if (!isRecord(item)) {
            errors.push({
              code: "INVALID_TYPE",
              path: itemPath,
              message: "Candidate entry must be an object.",
            });
            return;
          }
          if (checkAssetRef(item.asset, `${itemPath}.asset`)) {
            out.push({
              asset: item.asset,
              ...(typeof item.role === "string" ? { role: item.role } : {}),
              ...(typeof item.actor === "string" ? { actor: item.actor } : {}),
              ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
            });
          }
        });
        return out;
      };

      const rawCandidates = isRecord(rawShot.candidates) ? rawShot.candidates : {};
      const candImages = parseCandidateList(rawCandidates.images, `${sPath}.candidates.images`);
      const candVideos = parseCandidateList(rawCandidates.videos, `${sPath}.candidates.videos`);
      const candAudios = parseCandidateList(rawCandidates.audios, `${sPath}.candidates.audios`);

      const rawPrompts = isRecord(rawShot.prompts) ? rawShot.prompts : {};
      const prompts = {
        ...(typeof rawPrompts.image === "string" ? { image: rawPrompts.image } : {}),
        ...(typeof rawPrompts.video === "string" ? { video: rawPrompts.video } : {}),
        ...(typeof rawPrompts.audio === "string" ? { audio: rawPrompts.audio } : {}),
      };

      const rawSelected = isRecord(rawShot.selected)
        ? rawShot.selected
        : { video: null, audio: null };
      let selectedVideo: string | null = null;
      let selectedAudio: string | null = null;
      if (rawSelected.video !== null && rawSelected.video !== undefined) {
        if (checkAssetRef(rawSelected.video, `${sPath}.selected.video`)) {
          selectedVideo = rawSelected.video;
        }
      }
      if (rawSelected.audio !== null && rawSelected.audio !== undefined) {
        if (checkAssetRef(rawSelected.audio, `${sPath}.selected.audio`)) {
          selectedAudio = rawSelected.audio;
        }
      }

      const shotDef: ShotDefinition = {
        description: typeof rawShot.description === "string" ? rawShot.description : "",
        ...(isPositiveInteger(rawShot.durationFrames)
          ? { durationFrames: rawShot.durationFrames }
          : {}),
        dependsOn,
        subjects,
        references: {
          images: refImages,
          videos: refVideos,
        },
        prompts,
        candidates: {
          images: candImages,
          videos: candVideos,
          audios: candAudios,
        },
        selected: {
          video: selectedVideo,
          audio: selectedAudio,
        },
        ...(isRecord(rawShot.extensions)
          ? { extensions: structuredClone(rawShot.extensions) }
          : {}),
      };

      for (const [k, v] of Object.entries(rawShot)) {
        if (k.startsWith("x-")) {
          shotDef[k as `x-${string}`] = structuredClone(v);
        }
      }

      shots[shotId] = shotDef;
    }
  }

  for (const [shotId, shot] of Object.entries(shots)) {
    shot.dependsOn.forEach((dep, idx) => {
      if (!shots[dep.shotId]) {
        errors.push({
          code: "UNKNOWN_DEPENDENCY_SHOT",
          path: `$.shots.${shotId}.dependsOn[${idx}].shotId`,
          message: `Shot '${shotId}' depends on non-existent shot '${dep.shotId}'.`,
        });
      }
    });
  }

  errors.push(...detectDependencyCycles(shots));

  const sequence: string[] = [];
  const seenSequenceShots = new Set<string>();
  if (!Array.isArray(input.sequence)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: "$.sequence",
      message: "Composition 'sequence' must be an array of shot IDs.",
    });
  } else {
    input.sequence.forEach((item, idx) => {
      const seqPath = `$.sequence[${idx}]`;
      if (!isNonEmptyString(item)) {
        errors.push({
          code: "INVALID_TYPE",
          path: seqPath,
          message: "Sequence entry must be a non-empty shot ID string.",
        });
        return;
      }
      if (seenSequenceShots.has(item)) {
        errors.push({
          code: "DUPLICATE_SEQUENCE_SHOT",
          path: seqPath,
          message: `Duplicate shot ID '${item}' in sequence.`,
        });
      }
      seenSequenceShots.add(item);
      if (!shots[item]) {
        errors.push({
          code: "UNKNOWN_SEQUENCE_SHOT",
          path: seqPath,
          message: `Sequence references non-existent shot '${item}'.`,
        });
      }
      sequence.push(item);
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const formatRecord = input.format as Record<string, number>;
  const doc: CompositionDocument = {
    apiVersion: PROTOCOL_VERSION,
    id: input.id as string,
    project: input.project as string,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    format: {
      width: formatRecord.width,
      height: formatRecord.height,
      fps: formatRecord.fps,
    },
    audioTracks,
    sequence,
    shots,
    ...(isRecord(input.extensions) ? { extensions: structuredClone(input.extensions) } : {}),
  };

  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("x-")) {
      doc[k as `x-${string}`] = structuredClone(v);
    }
  }

  return { ok: true, value: doc, errors: [] };
}

export function validatePortableBundle(
  input: unknown,
  context?: ValidationContext,
): ProtocolValidationResult<PortableCompositionBundle> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ code: "INVALID_TYPE", path: "$", message: "Bundle must be an object." }],
    };
  }

  const errors: ProtocolValidationError[] = [];
  if (input.apiVersion !== PROTOCOL_VERSION) {
    errors.push({
      code: "UNSUPPORTED_API_VERSION",
      path: "$.apiVersion",
      message: `Unsupported apiVersion '${String(input.apiVersion)}'.`,
    });
  }

  const depsRaw = isRecord(input.dependencies) ? input.dependencies : null;
  if (!depsRaw || !Array.isArray(depsRaw.subjects) || !Array.isArray(depsRaw.assets)) {
    errors.push({
      code: "MISSING_REQUIRED_FIELD",
      path: "$.dependencies",
      message: "Bundle dependencies must include subjects and assets arrays.",
    });
    return { ok: false, errors };
  }

  const bundleAssets = new Set<string>(context?.availableAssets ?? []);
  const assetsList: PortableCompositionBundle["dependencies"]["assets"] = [];
  depsRaw.assets.forEach((rawAsset, idx) => {
    const aPath = `$.dependencies.assets[${idx}]`;
    if (
      !isRecord(rawAsset) ||
      !isNonEmptyString(rawAsset.id) ||
      !isNonEmptyString(rawAsset.sha256) ||
      !isNonEmptyString(rawAsset.mimeType) ||
      !isPositiveInteger(rawAsset.sizeBytes)
    ) {
      errors.push({
        code: "MISSING_REQUIRED_FIELD",
        path: aPath,
        message: "Asset manifest entry requires id, sha256, mimeType, and positive sizeBytes.",
      });
      return;
    }
    bundleAssets.add(rawAsset.id);
    assetsList.push({
      id: rawAsset.id,
      sha256: rawAsset.sha256,
      mimeType: rawAsset.mimeType,
      sizeBytes: rawAsset.sizeBytes,
      ...(isPositiveInteger(rawAsset.width) ? { width: rawAsset.width } : {}),
      ...(isPositiveInteger(rawAsset.height) ? { height: rawAsset.height } : {}),
      ...(isPositiveInteger(rawAsset.durationFrames)
        ? { durationFrames: rawAsset.durationFrames }
        : {}),
      ...(isRecord(rawAsset.lineage) ? { lineage: structuredClone(rawAsset.lineage) } : {}),
    });
  });

  const bundleSubjects = new Map<string, SubjectSnapshot>(context?.availableSubjects ?? []);
  const subjectsList: SubjectSnapshot[] = [];
  depsRaw.subjects.forEach((rawSubj, idx) => {
    const { snapshot, errors: sErrs } = validateSubjectSnapshot(
      rawSubj,
      `$.dependencies.subjects[${idx}]`,
      { availableAssets: bundleAssets },
    );
    errors.push(...sErrs);
    if (snapshot) {
      bundleSubjects.set(subjectRevisionKey(snapshot.id, snapshot.revision), snapshot);
      subjectsList.push(snapshot);
    }
  });

  const compResult = validateCompositionDocument(input.composition, {
    availableAssets: bundleAssets,
    availableSubjects: bundleSubjects,
  });
  if (!compResult.ok) {
    errors.push(
      ...compResult.errors.map((e) => ({
        ...e,
        path: e.path.replace(/^\$/, "$.composition"),
      })),
    );
  }

  if (errors.length > 0 || !compResult.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      apiVersion: PROTOCOL_VERSION,
      composition: compResult.value,
      ...(isPositiveInteger(input.revision) ? { revision: input.revision } : {}),
      dependencies: {
        subjects: subjectsList,
        assets: assetsList,
      },
    },
    errors: [],
  };
}
