import { isTrashed, assertCompositionActive } from "./lifecycle.ts";
import {
  AUTHORING_POLICY_VERSION,
  AUTHORING_PROMPTS,
  AUTHORING_RULES,
  AUTHORING_VERSION,
  ActualGenerationInputsSchema,
  AuthoringIdSchema,
  GenerationInputRequestSchema,
  MaterialDocumentSchema,
  REQUIRED_REVIEW_CHECKS,
  ReviewSchema,
  WorkflowContextSchema,
  renderAuthoringPrompt,
  canonicalizeJson,
  materialAssetIds,
  materialPins,
  structuralMaterialDiagnostics,
  type ActorIdentity,
  type AuthoringDiagnostic,
  type AuthoringValidation,
  type GenerationEvidence,
  type GenerationInputPacket,
  type MaterialDocument,
  type MaterialRecord,
  type MaterialRevision,
  type ReferenceOwner,
  type RevisionPin,
  type WorkflowContext,
} from "@vflow/protocol";
import {
  resourceKey,
  computeSha256Hex,
  type DomainStateSnapshot,
  type DomainStore,
} from "./storage.ts";
import { DomainError, type ProjectRecord } from "./types.ts";

const key = resourceKey;
type State = Readonly<DomainStateSnapshot>;
type Access = (
  state: State,
  projectId: string,
  actor: ActorIdentity | null | undefined,
  role: "reader" | "writer",
) => { actor: ActorIdentity; project: ProjectRecord };
export function projectPolicy(
  state: State,
  projectId: string,
): MaterialRevision | undefined {
  const r = state.materials[key(projectId, "workflow-policy")];
  return r?.revisions[r.headRevision];
}
export function isStrictProject(state: State, projectId: string): boolean {
  const doc = projectPolicy(state, projectId)?.document;
  return doc?.kind === "policy" && doc.mode === "strict";
}
export function assertWorkflowContext(
  state: State,
  projectId: string,
  context?: WorkflowContext,
): void {
  if (!isStrictProject(state, projectId)) return;
  if (!context)
    throw new DomainError(
      "WORKFLOW_CONTEXT_REQUIRED",
      "Read authoring_workflow_get before this authoring operation.",
      { action: "authoring_workflow_get", projectId },
    );
  const result = WorkflowContextSchema.safeParse(context);
  if (
    !result.success ||
    context.projectId !== projectId ||
    context.policyRevision !== projectPolicy(state, projectId)?.revision
  )
    throw new DomainError(
      "WORKFLOW_VERSION_MISMATCH",
      "Workflow context is stale or belongs to another project.",
      {
        action: "authoring_workflow_get",
        projectId,
        policyVersion: AUTHORING_POLICY_VERSION,
      },
    );
}
export function initialProjectPolicy(
  projectId: string,
  actor: ActorIdentity,
  mode: "strict" | "legacy",
): MaterialRecord {
  return {
    projectId,
    id: "workflow-policy",
    headRevision: 1,
    revisions: {
      1: {
        projectId,
        revision: 1,
        status: "approved",
        actorId: actor.actorId,
        createdAt: new Date().toISOString(),
        operationId: "project-policy",
        document: {
          schemaVersion: AUTHORING_VERSION,
          id: "workflow-policy",
          title: "Reference authoring policy",
          kind: "policy",
          mode,
          policyVersion: AUTHORING_POLICY_VERSION,
          constraints: [],
        },
      },
    },
  };
}
export function materialRevision(
  state: State,
  projectId: string,
  pin: RevisionPin,
): MaterialRevision | undefined {
  return state.materials[key(projectId, pin.id)]?.revisions[pin.revision];
}
function diagnostic(
  code: string,
  path: string,
  message: string,
  action = "Review or correct the referenced material, then validate again.",
): AuthoringDiagnostic {
  return { code, path, message, action };
}
function ownerDiagnostics(
  state: State,
  projectId: string,
  owner: ReferenceOwner,
  production: boolean,
): AuthoringDiagnostic[] {
  if (owner.kind === "scene") {
    const scene = materialRevision(state, projectId, owner);
    if (
      !scene ||
      scene.document.kind !== "scene" ||
      !scene.document.environmentVariants[owner.variant]
    )
      return [
        diagnostic(
          "REFERENCE_SCOPE_MISMATCH",
          "owner",
          "Scene revision or environment variant does not exist.",
        ),
      ];
    if (production && scene.status !== "approved")
      return [
        diagnostic(
          "REFERENCE_REVIEW_REQUIRED",
          "owner",
          "Scene revision is not approved.",
        ),
      ];
  } else {
    const subject =
      state.subjects[key(projectId, owner.id)]?.revisions[owner.revision];
    if (
      !subject ||
      subject.kind !== owner.kind ||
      !subject.variants[owner.variant]
    )
      return [
        diagnostic(
          "REFERENCE_SCOPE_MISMATCH",
          "owner",
          "Subject kind/revision/variant does not match this view.",
        ),
      ];
    if (production && subject.status !== "approved")
      return [
        diagnostic(
          "REFERENCE_REVIEW_REQUIRED",
          "owner",
          "Subject revision is not approved.",
        ),
      ];
  }
  return [];
}
function reviewDiagnostics(
  review: import("@vflow/protocol").MaterialReview | undefined,
  category: keyof typeof REQUIRED_REVIEW_CHECKS,
  path: string,
): AuthoringDiagnostic[] {
  if (!review || review.decision !== "accepted")
    return [
      diagnostic(
        "REFERENCE_REVIEW_REQUIRED",
        path,
        "Visual review is missing, unknown or rejected.",
      ),
    ];
  return REQUIRED_REVIEW_CHECKS[category]
    .filter((c) => review.checks[c] !== "pass")
    .map((c) =>
      diagnostic(
        c === "text_policy" && review.checks[c] === "fail"
          ? "STORYBOARD_TEXT_DETECTED"
          : "REFERENCE_REVIEW_REQUIRED",
        `${path}.checks.${c}`,
        "A required visual check has not passed.",
      ),
    );
}

function imageRejectedAfter(
  state: State,
  projectId: string,
  pin: RevisionPin,
  asset: string,
): boolean {
  let rejected = false;
  const revisions = Object.values(
    state.materials[key(projectId, pin.id)]?.revisions ?? {},
  )
    .filter((r) => r.revision > pin.revision)
    .sort((a, b) => a.revision - b.revision);
  for (const r of revisions) {
    const items =
      r.document.kind === "reference_pack"
        ? r.document.views
        : r.document.kind === "storyboard_sequence"
          ? r.document.panels
          : [];
    const matches = items.filter((i) => i.asset === asset);
    if (matches.some((i) => i.review?.decision === "rejected")) rejected = true;
    else if (
      r.status === "approved" &&
      matches.some((i) => i.review?.decision === "accepted")
    )
      rejected = false;
  }
  return rejected;
}

export function validateMaterial(
  state: State,
  projectId: string,
  document: MaterialDocument,
  visual = true,
): AuthoringValidation {
  const diagnostics = structuralMaterialDiagnostics(document);
  const add = (d: AuthoringDiagnostic) => diagnostics.push(d);
  const asset = (id: string) => state.assets[key(projectId, id)];
  for (const id of materialAssetIds(document))
    if (!asset(id)?.mimeType.startsWith("image/"))
      add(
        diagnostic(
          "MISSING_ASSET_REFERENCE",
          `assets.${id}`,
          "A required image asset is missing in this project.",
        ),
      );
  const items =
    document.kind === "reference_pack"
      ? document.views
      : document.kind === "storyboard_sequence"
        ? document.panels
        : [];
  const rects: Array<{
    id: string;
    source: NonNullable<(typeof items)[number]["source"]>;
  }> = [];
  for (const item of items) {
    const image = asset(item.asset);
    if (
      image &&
      (!image.width ||
        !image.height ||
        (image.lineage?.mediaDimensions as { verified?: boolean } | undefined)
          ?.verified !== true)
    )
      add(
        diagnostic(
          "MEDIA_DIMENSIONS_UNVERIFIED",
          `items.${item.id}`,
          "Image dimensions were not parsed from the uploaded media.",
          "Upload a supported PNG/JPEG or re-register the original bytes with a new immutable asset ID.",
        ),
      );
    if (item.source) {
      if (item.asset === item.source.asset)
        add(
          diagnostic(
            "GRID_CELL_REQUIRED",
            `items.${item.id}.source`,
            "A crop needs an independent tile asset, not the original board.",
          ),
        );
      const original = asset(item.source.asset),
        r = item.source.regionPx;
      if (
        !original ||
        original.sha256 !== item.source.sha256 ||
        !original.width ||
        !original.height ||
        r.x + r.width > original.width ||
        r.y + r.height > original.height ||
        image?.width !== r.width ||
        image?.height !== r.height
      )
        add(
          diagnostic(
            "STORYBOARD_LAYOUT_INVALID",
            `items.${item.id}.source`,
            "Crop source hash, bounds or independent tile dimensions do not match.",
          ),
        );
      rects.push({ id: item.id, source: item.source });
    }
  }
  rects.forEach((a, i) =>
    rects.slice(i + 1).forEach((b) => {
      const x = a.source.regionPx,
        y = b.source.regionPx;
      if (
        a.source.asset === b.source.asset &&
        x.x < y.x + y.width &&
        y.x < x.x + x.width &&
        x.y < y.y + y.height &&
        y.y < x.y + x.height
      )
        add(
          diagnostic(
            "STORYBOARD_LAYOUT_INVALID",
            "cells",
            `Crop regions ${a.id} and ${b.id} overlap.`,
          ),
        );
    }),
  );
  if (document.kind === "scene") {
    if (
      !Object.keys(document.anchors).length ||
      !Object.keys(document.environmentVariants).length
    )
      add(
        diagnostic(
          "REFERENCE_SCOPE_MISMATCH",
          "scene",
          "A scene needs geometry anchors and environment variants.",
        ),
      );
    if (visual)
      diagnostics.push(
        ...reviewDiagnostics(document.review, "scene", "review"),
      );
  }
  if (document.kind === "reference_pack") {
    if (document.category === "single_frame" && !document.sources.length)
      add(
        diagnostic(
          "DEPENDENCY_ERROR",
          "sources",
          "A generated single frame needs pinned canonical source views.",
        ),
      );
    if (document.category === "moodboard")
      add(
        diagnostic(
          "REFERENCE_USAGE_AMBIGUOUS",
          "category",
          "Mixed moodboards are archive-only; split and review canonical views.",
        ),
      );
    for (const v of document.views) {
      if (visual) {
        const conflict = Object.values(state.materials).some(
          (r) =>
            r.projectId === projectId &&
            Object.values(r.revisions).some(
              (rev) =>
                rev.status === "approved" &&
                rev.document.kind === "reference_pack" &&
                rev.document.views.some(
                  (other) =>
                    other.asset === v.asset &&
                    (other.owner.kind !== v.owner.kind ||
                      other.owner.id !== v.owner.id ||
                      (["character_face", "character_body"].includes(
                        document.category,
                      ) &&
                        ["character_face", "character_body"].includes(
                          rev.document.kind === "reference_pack"
                            ? rev.document.category
                            : "",
                        ) &&
                        rev.document.kind === "reference_pack" &&
                        rev.document.category !== document.category)),
                ),
            ),
        );
        if (conflict)
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `views.${v.id}.asset`,
              "The same immutable image is already canonical for another identity or the opposite face/body purpose. Upload an independently authored view.",
            ),
          );
      }
      diagnostics.push(...ownerDiagnostics(state, projectId, v.owner, false));
      if (v.owner.kind === "scene" && v.environmentVariant !== v.owner.variant)
        add(
          diagnostic(
            "REFERENCE_SCOPE_MISMATCH",
            `views.${v.id}.environmentVariant`,
            "Pin one explicit environment variant for each scene view.",
          ),
        );
      if (visual)
        diagnostics.push(
          ...reviewDiagnostics(
            v.review,
            document.category,
            `views.${v.id}.review`,
          ),
        );
    }
  }
  if (document.kind === "storyboard_sequence") {
    const comp =
      state.compositions[key(projectId, document.compositionId)]?.revisions[
        document.compositionRevision
      ]?.document;
    if (!comp)
      add(
        diagnostic(
          "DEPENDENCY_ERROR",
          "compositionRevision",
          "Sequence composition revision is missing.",
        ),
      );
    let previousMoment = -1;
    for (const panel of document.panels) {
      const shotIndex = comp?.sequence.indexOf(panel.shotId) ?? -1;
      const absoluteMoment =
        (comp?.sequence
          .slice(0, shotIndex)
          .reduce((sum, id) => sum + (comp.shots[id].durationFrames ?? 0), 0) ??
          0) + panel.momentFrame;
      if (absoluteMoment <= previousMoment)
        add(
          diagnostic(
            "STORYBOARD_LAYOUT_INVALID",
            `panels.${panel.id}.momentFrame`,
            "Panel moments must follow composition chronology.",
          ),
        );
      previousMoment = absoluteMoment;
      const scene = materialRevision(state, projectId, panel.scene);
      if (
        !scene ||
        scene.document.kind !== "scene" ||
        !scene.document.environmentVariants[panel.environmentVariant]
      )
        add(
          diagnostic(
            "REFERENCE_SCOPE_MISMATCH",
            `panels.${panel.id}.scene`,
            "Scene or environment variant is missing.",
          ),
        );
      if (!comp?.shots[panel.shotId])
        add(
          diagnostic(
            "DEPENDENCY_ERROR",
            `panels.${panel.id}.shotId`,
            "Panel shot does not exist in the pinned composition.",
          ),
        );
      if (
        comp?.shots[panel.shotId]?.durationFrames !== undefined &&
        panel.momentFrame >= comp.shots[panel.shotId].durationFrames!
      )
        add(
          diagnostic(
            "STORYBOARD_LAYOUT_INVALID",
            `panels.${panel.id}.momentFrame`,
            "Panel moment exceeds the shot duration.",
          ),
        );
      const shotBindings = comp?.shots[panel.shotId]?.subjects ?? [];
      const entityKey = (owner: ReferenceOwner) => `${owner.kind}:${owner.id}`;
      if (
        new Set(panel.entities.map((e) => entityKey(e.subject))).size !==
        panel.entities.length
      )
        add(
          diagnostic(
            "REFERENCE_SCOPE_MISMATCH",
            `panels.${panel.id}.entities`,
            "Do not duplicate the same character/prop in one panel.",
          ),
        );
      for (const binding of shotBindings)
        if (
          !panel.entities.some(
            (e) =>
              e.subject.id === binding.subjectId &&
              e.subject.revision === binding.subjectRevision,
          )
        )
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `panels.${panel.id}.entities`,
              "Declare every pinned shot participant as visible/hidden/entering/exiting, even in close-ups.",
            ),
          );
      const hasEnvironment = panel.sources.some((pin) => {
        const pack = materialRevision(state, projectId, pin.pack)?.document;
        const view =
          pack?.kind === "reference_pack"
            ? pack.views.find((v) => v.id === pin.viewId)
            : undefined;
        return (
          view?.purpose === "environment" &&
          view.owner.kind === "scene" &&
          view.owner.id === panel.scene.id &&
          view.owner.revision === panel.scene.revision &&
          view.owner.variant === panel.environmentVariant
        );
      });
      if (!hasEnvironment)
        add(
          diagnostic(
            "REFERENCE_SCOPE_MISMATCH",
            `panels.${panel.id}.sources`,
            "Pin an approved visual environment view for this exact scene/environment variant.",
          ),
        );
      for (const entity of panel.entities) {
        if (
          !shotBindings.some(
            (b) =>
              b.subjectId === entity.subject.id &&
              b.subjectRevision === entity.subject.revision &&
              (b.variant ??
                state.subjects[key(projectId, b.subjectId)]?.revisions[
                  b.subjectRevision
                ]?.defaultVariant) === entity.subject.variant,
          )
        )
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `panels.${panel.id}.entities`,
              "Panel entities must match this shot's pinned subjects and variants.",
            ),
          );
        diagnostics.push(
          ...ownerDiagnostics(state, projectId, entity.subject, true),
        );
        const matching = panel.sources.some((pin) => {
          const pack = materialRevision(state, projectId, pin.pack)?.document;
          return (
            pack?.kind === "reference_pack" &&
            pack.views.some(
              (v) =>
                v.id === pin.viewId &&
                canonicalizeJson(v.owner) === canonicalizeJson(entity.subject),
            )
          );
        });
        if (!matching)
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `panels.${panel.id}.entities`,
              "Each entity needs its own pinned reference view in this panel.",
            ),
          );
        if (
          entity.subject.kind === "character" &&
          entity.visibility !== "hidden" &&
          !entity.supportAnchor
        )
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `panels.${panel.id}.supportAnchor`,
              "Record the character's support surface even when outside a close-up frame.",
            ),
          );
        if (
          entity.heldProp &&
          !panel.entities.some(
            (e) =>
              e.subject.kind === "prop" && e.subject.id === entity.heldProp,
          )
        )
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `panels.${panel.id}.heldProp`,
              "Held prop must have an explicit entity state and reference.",
            ),
          );
        if (
          entity.supportAnchor &&
          (scene?.document.kind !== "scene" ||
            !scene.document.anchors[entity.supportAnchor]?.supportSurface)
        )
          add(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              `panels.${panel.id}.supportAnchor`,
              "Support anchor is missing or is not a support surface.",
            ),
          );
      }
      if (visual)
        diagnostics.push(
          ...reviewDiagnostics(
            panel.review,
            "storyboard_sequence",
            `panels.${panel.id}.review`,
          ),
        );
    }
  }
  // Walk pinned revisions, not mutable latest IDs; reject cycles and missing dependencies.
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const walk = (pin: RevisionPin) => {
    const p = `${pin.id}@${pin.revision}`;
    if (visiting.has(p)) {
      add(
        diagnostic(
          "DEPENDENCY_ERROR",
          "sources",
          "Reference lineage contains a cycle.",
        ),
      );
      return;
    }
    if (visited.has(p)) return;
    const dep = materialRevision(state, projectId, pin);
    if (!dep) {
      add(
        diagnostic(
          "DEPENDENCY_ERROR",
          `sources.${p}`,
          "Pinned reference dependency is missing.",
        ),
      );
      return;
    }
    if (visual && dep.status !== "approved")
      add(
        diagnostic(
          "REFERENCE_REVIEW_REQUIRED",
          `sources.${p}`,
          "Pinned source is not approved.",
        ),
      );
    const depItems =
      dep.document.kind === "reference_pack"
        ? dep.document.views
        : dep.document.kind === "storyboard_sequence"
          ? dep.document.panels
          : [];
    if (
      visual &&
      depItems.some((item) =>
        imageRejectedAfter(state, projectId, pin, item.asset),
      )
    )
      add(
        diagnostic(
          "REFERENCE_REVIEW_REQUIRED",
          `sources.${p}`,
          "An upstream image was rejected; pending edits do not restore approval.",
        ),
      );
    visiting.add(p);
    materialPins(dep.document).forEach(walk);
    visiting.delete(p);
    visited.add(p);
  };
  materialPins(document).forEach(walk);
  const pins =
    document.kind === "reference_pack"
      ? document.sources
      : document.kind === "storyboard_sequence"
        ? document.panels.flatMap((p) => p.sources)
        : [];
  for (const pin of pins) {
    const dep = materialRevision(state, projectId, pin.pack)?.document;
    if (
      dep?.kind !== "reference_pack" ||
      !dep.views.some((v) => v.id === pin.viewId)
    )
      add(
        diagnostic(
          "DEPENDENCY_ERROR",
          "sources",
          "Pinned view does not exist.",
        ),
      );
  }
  return { ready: diagnostics.length === 0, diagnostics };
}

export class ReferenceAuthoringService {
  private readonly store: DomainStore;
  private readonly access: Access;
  constructor(store: DomainStore, access: Access) {
    this.store = store;
    this.access = access;
  }
  async workflow(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    language: "zh" | "en" = "zh",
  ) {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    const policy = projectPolicy(state, projectId);
    return {
      schemaVersion: AUTHORING_VERSION,
      policyVersion: AUTHORING_POLICY_VERSION,
      mode: isStrictProject(state, projectId) ? "strict" : "legacy",
      policy,
      workflowContext: {
        projectId,
        policyVersion: AUTHORING_POLICY_VERSION,
        policyRevision: policy?.revision ?? 1,
      } satisfies WorkflowContext,
      rules: AUTHORING_RULES[language],
      prompts: AUTHORING_PROMPTS,
      requiredReviewChecks: REQUIRED_REVIEW_CHECKS,
      templates: AUTHORING_PROMPTS.map((p) => ({
        name: p.name,
        content: renderAuthoringPrompt(p.name, {
          projectId,
          brief: "[本次制作要求 / task requirements]",
          language,
        }),
      })),
      steps: [
        "classify and create isolated views",
        "review each view",
        "approve reference packs",
        "pin storyboard sources",
        "review text-free panels",
        "prepare exact generation inputs",
        "record actual input evidence",
      ],
      materials: Object.values(state.materials)
        .filter((r) => r.projectId === projectId)
        .map((r) => ({
          id: r.id,
          revision: r.headRevision,
          status: r.revisions[r.headRevision].status,
          kind: r.revisions[r.headRevision].document.kind,
        })),
    };
  }
  async list(actor: ActorIdentity | null | undefined, projectId: string) {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    return Object.values(state.materials).filter(
      (r) => r.projectId === projectId,
    );
  }
  async impact(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    pin: RevisionPin,
  ) {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    if (!materialRevision(state, projectId, pin))
      throw new DomainError("NOT_FOUND", "Reference revision does not exist.");
    const affected = new Set<string>([`${pin.id}@${pin.revision}`]);
    const revisions = Object.values(state.materials)
      .filter((r) => r.projectId === projectId)
      .flatMap((r) => Object.values(r.revisions));
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of revisions) {
        const k = `${r.document.id}@${r.revision}`;
        if (
          !affected.has(k) &&
          materialPins(r.document).some((p) =>
            affected.has(`${p.id}@${p.revision}`),
          )
        ) {
          affected.add(k);
          changed = true;
        }
      }
    }
    const materials = revisions
      .filter((r) => affected.has(`${r.document.id}@${r.revision}`))
      .map((r) => ({
        id: r.document.id,
        revision: r.revision,
        kind: r.document.kind,
        status: r.status,
      }));
    const compositions = Object.values(state.compositions)
      .filter(
        (c) =>
          c.projectId === projectId &&
          !isTrashed(state, projectId, "composition", c.id),
      )
      .flatMap((c) =>
        Object.values(c.revisions)
          .filter((r) =>
            r.document.authoring?.materials.some((p) =>
              affected.has(`${p.id}@${p.revision}`),
            ),
          )
          .map((r) => ({
            id: c.id,
            revision: r.revision,
            shots: r.document.sequence,
          })),
      );
    return { material: pin, materials, compositions, historyChanged: false };
  }
  async get(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    id: string,
    revision?: number,
  ) {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    const record = state.materials[key(projectId, id)],
      value = record?.revisions[revision ?? record.headRevision];
    if (!value)
      throw new DomainError(
        "NOT_FOUND",
        "Reference document revision does not exist.",
      );
    return value;
  }
  async validate(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    raw: unknown,
  ) {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    const parsed = MaterialDocumentSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ready: false,
        diagnostics: parsed.error.issues.map((e) =>
          diagnostic("VALIDATION_FAILED", e.path.join("."), e.message),
        ),
      };
    return validateMaterial(state, projectId, parsed.data);
  }
  private async write(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      id: string;
      baseRevision: number;
      operationId: string;
      workflowContext?: WorkflowContext;
    },
    payload: unknown,
    edit: (
      state: DomainStateSnapshot,
      previous: MaterialRevision | undefined,
      actor: ActorIdentity,
    ) => { document: MaterialDocument; status: "candidate" | "approved" },
  ) {
    return this.store.runInTransaction("authoringWrite", (draft) => {
      const { actor: auth } = this.access(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      if (
        !input.operationId?.trim() ||
        !Number.isInteger(input.baseRevision) ||
        input.baseRevision < 0
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "baseRevision and operationId are required.",
        );
      const k = key(input.projectId, input.id),
        receiptKey = canonicalizeJson([
          "authoring",
          input.projectId,
          auth.actorId,
          input.operationId,
        ]);
      const fingerprint = canonicalizeJson({
        id: input.id,
        baseRevision: input.baseRevision,
        payload,
      });
      const receipt = draft.idempotencyRecords[receiptKey] as
        { fingerprint: string; result: MaterialRevision } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError(
            "VALIDATION_FAILED",
            "Idempotency key was reused with different data.",
          );
        return receipt.result;
      }
      const record = draft.materials[k];
      if ((record?.headRevision ?? 0) !== input.baseRevision)
        throw new DomainError(
          "REVISION_CONFLICT",
          "Reference document changed; reload and reconcile.",
          { headRevision: record?.headRevision ?? 0 },
        );
      const edited = edit(draft, record?.revisions[record.headRevision], auth);
      if (edited.document.id !== input.id)
        throw new DomainError(
          "VALIDATION_FAILED",
          "Document ID does not match its key.",
        );
      const result: MaterialRevision = {
        projectId: input.projectId,
        revision: input.baseRevision + 1,
        status: edited.status,
        actorId: auth.actorId,
        createdAt: new Date().toISOString(),
        operationId: input.operationId,
        document: edited.document,
      };
      if (
        record &&
        record.revisions[record.headRevision].document.kind !==
          result.document.kind
      )
        throw new DomainError(
          "REFERENCE_SCOPE_MISMATCH",
          "Document kind is immutable.",
        );
      const next = record ?? {
        projectId: input.projectId,
        id: input.id,
        headRevision: 0,
        revisions: {},
      };
      next.revisions[result.revision] = result;
      next.headRevision = result.revision;
      draft.materials[k] = next;
      draft.idempotencyRecords[receiptKey] = { fingerprint, result };
      return result;
    });
  }
  async put(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      baseRevision: number;
      operationId: string;
      document: MaterialDocument;
      workflowContext?: WorkflowContext;
    },
  ) {
    return this.write(
      actor,
      { ...input, id: input.document?.id },
      { action: "put", document: input.document },
      (state, previous) => {
        const parsed = MaterialDocumentSchema.safeParse(input.document);
        if (!parsed.success)
          throw new DomainError(
            "VALIDATION_FAILED",
            "Invalid reference manifest.",
            { errors: parsed.error.issues },
          );
        const doc = parsed.data;
        if (doc.kind === "policy") {
          if (
            !previous ||
            doc.id !== "workflow-policy" ||
            previous.document.kind !== "policy" ||
            doc.mode !== previous.document.mode
          )
            throw new DomainError(
              "IMMUTABILITY_VIOLATION",
              "Project mode cannot be downgraded through a manifest write.",
            );
        }
        // Reviews cannot be supplied through CRUD. Unchanged items may retain their recorded review.
        if (doc.kind === "scene") delete doc.review;
        if (
          doc.kind === "reference_pack" ||
          doc.kind === "storyboard_sequence"
        ) {
          const oldItems =
            previous?.document.kind === doc.kind
              ? previous.document.kind === "reference_pack"
                ? previous.document.views
                : previous.document.panels
              : [];
          const items =
            doc.kind === "reference_pack"
              ? doc.views
              : doc.kind === "storyboard_sequence"
                ? doc.panels
                : [];
          for (const item of items) {
            delete item.review;
            const old = oldItems.find((v) => v.id === item.id);
            if (
              old &&
              previous?.document.kind === doc.kind &&
              canonicalizeJson({
                ...previous.document,
                ...(previous.document.kind === "reference_pack"
                  ? { views: [] }
                  : { panels: [] }),
              }) ===
                canonicalizeJson({
                  ...doc,
                  ...(doc.kind === "reference_pack"
                    ? { views: [] }
                    : { panels: [] }),
                })
            ) {
              const copy = structuredClone(old);
              delete copy.review;
              if (canonicalizeJson(copy) === canonicalizeJson(item))
                item.review = old.review;
            }
          }
        }
        const result = validateMaterial(state, input.projectId, doc, false);
        const hard = result.diagnostics.filter(
          (d) =>
            ![
              "REFERENCE_USAGE_AMBIGUOUS",
              "REFERENCE_REVIEW_REQUIRED",
              "REFERENCE_CONFLICT_UNRESOLVED",
            ].includes(d.code),
        );
        if (hard.length)
          throw new DomainError(
            hard[0].code as import("./types.ts").DomainErrorCode,
            hard[0].message,
            { diagnostics: hard },
          );
        return { document: doc, status: "candidate" };
      },
    );
  }
  async review(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      id: string;
      baseRevision: number;
      operationId: string;
      workflowContext?: WorkflowContext;
      targets: string[];
      review: import("@vflow/protocol").MaterialReview;
    },
  ) {
    return this.write(
      actor,
      input,
      { action: "review", targets: input.targets, review: input.review },
      (_state, previous, auth) => {
        if (!previous)
          throw new DomainError(
            "NOT_FOUND",
            "Reference document does not exist.",
          );
        const parsed = ReviewSchema.safeParse({
          ...input.review,
          reviewer: auth.actorId,
        });
        if (!parsed.success || !Array.isArray(input.targets))
          throw new DomainError(
            "VALIDATION_FAILED",
            "Invalid review or targets.",
          );
        const review = parsed.data;
        if (review.method === "human" && auth.actorKind !== "human")
          throw new DomainError(
            "FORBIDDEN",
            "Agents must label visual reviews as external, not human.",
          );
        const doc = structuredClone(previous.document);
        const category =
          doc.kind === "reference_pack" ? doc.category : doc.kind;
        if (category === "policy")
          throw new DomainError(
            "VALIDATION_FAILED",
            "Policies do not use visual review.",
          );
        if (
          review.decision === "accepted" &&
          REQUIRED_REVIEW_CHECKS[category].some(
            (c) => review.checks[c] !== "pass",
          )
        )
          throw new DomainError(
            "REFERENCE_REVIEW_REQUIRED",
            "Accepted reviews must explicitly pass every required check.",
            { requiredChecks: REQUIRED_REVIEW_CHECKS[category] },
          );
        if (doc.kind === "scene") {
          if (input.targets.length !== 1 || input.targets[0] !== "$document")
            throw new DomainError(
              "VALIDATION_FAILED",
              "Review scene as $document.",
            );
          doc.review = review;
        } else {
          const items =
            doc.kind === "reference_pack"
              ? doc.views
              : doc.kind === "storyboard_sequence"
                ? doc.panels
                : [];
          if (
            !input.targets.length ||
            new Set(input.targets).size !== input.targets.length ||
            input.targets.some((id) => !items.some((i) => i.id === id))
          )
            throw new DomainError(
              "VALIDATION_FAILED",
              "Select existing unique views/panels to review.",
            );
          items
            .filter((i) => input.targets.includes(i.id))
            .forEach((i) => {
              i.review = review;
            });
        }
        return { document: doc, status: "candidate" };
      },
    );
  }
  async approve(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      id: string;
      baseRevision: number;
      operationId: string;
      workflowContext?: WorkflowContext;
    },
  ) {
    return this.write(
      actor,
      input,
      { action: "approve" },
      (state, previous) => {
        if (!previous)
          throw new DomainError(
            "NOT_FOUND",
            "Reference document does not exist.",
          );
        const result = validateMaterial(
          state,
          input.projectId,
          previous.document,
        );
        if (!result.ready)
          throw new DomainError(
            "REFERENCE_REVIEW_REQUIRED",
            "Reference material is not ready for approval.",
            { diagnostics: result.diagnostics },
          );
        return {
          document: structuredClone(previous.document),
          status: "approved",
        };
      },
    );
  }
  async prepare(
    actor: ActorIdentity | null | undefined,
    projectId: string,
    raw: unknown,
    context?: WorkflowContext,
  ): Promise<{
    ready: boolean;
    diagnostics: AuthoringDiagnostic[];
    packet?: GenerationInputPacket;
  }> {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    assertWorkflowContext(state, projectId, context);
    return this.prepareInState(state, projectId, raw);
  }
  private async prepareInState(
    state: State,
    projectId: string,
    raw: unknown,
  ): Promise<{
    ready: boolean;
    diagnostics: AuthoringDiagnostic[];
    packet?: GenerationInputPacket;
  }> {
    const parsed = GenerationInputRequestSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ready: false,
        diagnostics: parsed.error.issues.map((e) =>
          diagnostic(
            "TARGET_CAPABILITIES_REQUIRED",
            e.path.join("."),
            e.message,
            "Verify target input capabilities and complete the request.",
          ),
        ),
      };
    const request = parsed.data,
      diagnostics: AuthoringDiagnostic[] = [],
      inputs: GenerationInputPacket["inputs"] = [];
    assertCompositionActive(state, projectId, request.compositionId);
    const comp =
      state.compositions[key(projectId, request.compositionId)]?.revisions[
        request.compositionRevision
      ]?.document;
    const shot = comp?.shots[request.shotId];
    if (!shot)
      diagnostics.push(
        diagnostic(
          "DEPENDENCY_ERROR",
          "shot",
          "Pinned composition/shot is missing.",
        ),
      );
    const pinned = new Set<string>();
    const include = (pin: RevisionPin) => {
      const id = `${pin.id}@${pin.revision}`;
      if (pinned.has(id)) return;
      pinned.add(id);
      const material = materialRevision(state, projectId, pin);
      if (material) materialPins(material.document).forEach(include);
    };
    comp?.authoring?.materials.forEach(include);
    for (const [i, item] of request.inputs.entries()) {
      const path = `inputs[${i}]`;
      const selectedPin = item.source?.pack ?? item.sequence;
      if (
        selectedPin &&
        !pinned.has(`${selectedPin.id}@${selectedPin.revision}`)
      )
        diagnostics.push(
          diagnostic(
            "REFERENCE_SCOPE_MISMATCH",
            path,
            "Reference revision is not pinned to this composition.",
            "Pin the reviewed material with set_authoring, then prepare using the new composition revision.",
          ),
        );
      if (!request.capabilities.roles.includes(item.role))
        diagnostics.push(
          diagnostic(
            "REFERENCE_USAGE_AMBIGUOUS",
            path,
            "Target capability does not support this input role.",
          ),
        );
      if (item.wholeBoard) {
        diagnostics.push(
          diagnostic(
            "GRID_CELL_REQUIRED",
            path,
            "This adapter prepares independent image inputs only. Extract explicit tiles even if a target accepts grids.",
          ),
        );
        continue;
      }
      if (Boolean(item.source) === Boolean(item.sequence)) {
        diagnostics.push(
          diagnostic(
            "REFERENCE_USAGE_AMBIGUOUS",
            path,
            "Choose exactly one pinned view or one pinned storyboard panel.",
          ),
        );
        continue;
      }
      let image: string | undefined, owner: ReferenceOwner | undefined;
      let source: GenerationInputPacket["inputs"][number]["source"] | undefined,
        sourceBoard: string | undefined;
      if (item.source) {
        const material = materialRevision(state, projectId, item.source.pack);
        const pack = material?.document;
        if (
          !material ||
          material.status !== "approved" ||
          pack?.kind !== "reference_pack"
        ) {
          diagnostics.push(
            diagnostic(
              "REFERENCE_REVIEW_REQUIRED",
              path,
              "Input pack must be an approved fixed revision.",
            ),
          );
          continue;
        }
        diagnostics.push(
          ...validateMaterial(state, projectId, pack).diagnostics,
        );
        if (["first_frame", "last_frame"].includes(item.role))
          diagnostics.push(
            diagnostic(
              "REFERENCE_USAGE_AMBIGUOUS",
              path,
              "Prepare first/last frames from an approved storyboard panel with scene and entity state, not an identity/reference pack.",
            ),
          );
        const view = pack.views.find((v) => v.id === item.source!.viewId);
        if (!view) {
          diagnostics.push(
            diagnostic("DEPENDENCY_ERROR", path, "View is missing."),
          );
          continue;
        }
        if (imageRejectedAfter(state, projectId, item.source.pack, view.asset))
          diagnostics.push(
            diagnostic(
              "REFERENCE_REVIEW_REQUIRED",
              path,
              "This image was rejected in a later revision; only an explicit approved review can restore production eligibility.",
            ),
          );
        if (view.purpose !== item.role)
          diagnostics.push(
            diagnostic(
              "REFERENCE_USAGE_AMBIGUOUS",
              path,
              "Input role conflicts with the approved view purpose.",
            ),
          );
        diagnostics.push(
          ...ownerDiagnostics(state, projectId, view.owner, true),
        );
        if (
          view.owner.kind !== "scene" &&
          !shot?.subjects.some(
            (s) =>
              s.subjectId === view.owner.id &&
              s.subjectRevision === view.owner.revision &&
              (s.variant ??
                state.subjects[key(projectId, s.subjectId)]?.revisions[
                  s.subjectRevision
                ].defaultVariant) === view.owner.variant,
          )
        )
          diagnostics.push(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              path,
              "Reference owner is not pinned to this shot.",
            ),
          );
        image = view.asset;
        owner = view.owner;
        source = item.source;
        sourceBoard = view.source?.asset;
      } else if (item.sequence && item.panelId) {
        const material = materialRevision(state, projectId, item.sequence),
          seq = material?.document;
        if (
          !material ||
          material.status !== "approved" ||
          seq?.kind !== "storyboard_sequence"
        ) {
          diagnostics.push(
            diagnostic(
              "REFERENCE_REVIEW_REQUIRED",
              path,
              "Sequence must be approved.",
            ),
          );
          continue;
        }
        diagnostics.push(
          ...validateMaterial(state, projectId, seq).diagnostics,
        );
        const panel = seq.panels.find((p) => p.id === item.panelId);
        if (
          !panel ||
          panel.shotId !== request.shotId ||
          seq.compositionId !== request.compositionId ||
          canonicalizeJson(
            state.compositions[key(projectId, seq.compositionId)]?.revisions[
              seq.compositionRevision
            ]?.document.shots[request.shotId],
          ) !== canonicalizeJson(shot)
        ) {
          diagnostics.push(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              path,
              "Panel does not belong to the pinned shot/composition revision.",
            ),
          );
          continue;
        }
        if (imageRejectedAfter(state, projectId, item.sequence, panel.asset))
          diagnostics.push(
            diagnostic(
              "REFERENCE_REVIEW_REQUIRED",
              path,
              "This storyboard image was rejected in a later revision.",
            ),
          );
        const baseline =
          state.compositions[key(projectId, seq.compositionId)]?.revisions[
            seq.compositionRevision
          ]?.document;
        if (
          canonicalizeJson(baseline?.sequence) !==
            canonicalizeJson(comp?.sequence) ||
          canonicalizeJson(baseline?.format) !== canonicalizeJson(comp?.format)
        )
          diagnostics.push(
            diagnostic(
              "REFERENCE_SCOPE_MISMATCH",
              path,
              "Sequence order or frame format changed from the approved storyboard baseline.",
            ),
          );
        if (!["first_frame", "last_frame"].includes(item.role))
          diagnostics.push(
            diagnostic(
              "REFERENCE_USAGE_AMBIGUOUS",
              path,
              "Storyboard panels may only supply explicit first/last frames.",
            ),
          );
        image = panel.asset;
        source = { sequence: item.sequence, panelId: panel.id };
        sourceBoard = panel.source?.asset;
      } else {
        diagnostics.push(
          diagnostic(
            "REFERENCE_USAGE_AMBIGUOUS",
            path,
            "Sequence input needs a panelId.",
          ),
        );
        continue;
      }
      const asset = image ? state.assets[key(projectId, image)] : undefined;
      if (asset && source)
        inputs.push({
          asset: asset.id,
          sha256: asset.sha256,
          role: item.role,
          ...(owner ? { owner } : {}),
          source,
          ...(sourceBoard ? { sourceBoard } : {}),
        });
    }
    if (inputs.length > request.capabilities.maxImages)
      diagnostics.push(
        diagnostic(
          "REFERENCE_BUDGET_EXCEEDED",
          "inputs",
          "Input count exceeds verified target capability; no inputs were silently dropped.",
        ),
      );
    if (
      request.inputs.filter((i) => i.role === "first_frame").length > 1 ||
      request.inputs.filter((i) => i.role === "last_frame").length > 1
    )
      diagnostics.push(
        diagnostic(
          "REFERENCE_USAGE_AMBIGUOUS",
          "inputs",
          "Only one first and one last frame are allowed.",
        ),
      );
    if (diagnostics.length) return { ready: false, diagnostics };
    const body = {
      schemaVersion: AUTHORING_VERSION,
      projectId,
      policyVersion: AUTHORING_POLICY_VERSION,
      request,
      inputs,
    };
    return {
      ready: true,
      diagnostics: [],
      packet: {
        ...body,
        hash: await computeSha256Hex(
          new TextEncoder().encode(canonicalizeJson(body)),
        ),
      },
    };
  }
  async recordEvidence(
    actor: ActorIdentity | null | undefined,
    input: {
      projectId: string;
      id: string;
      operationId: string;
      workflowContext?: WorkflowContext;
      packet: GenerationInputPacket;
      actualInputs: GenerationEvidence["actualInputs"];
      outputs: string[];
      method: GenerationEvidence["method"];
      evidence: string;
    },
  ) {
    return this.store.runInTransaction("authoringEvidence", async (draft) => {
      const { actor: auth } = this.access(
        draft,
        input.projectId,
        actor,
        "writer",
      );
      assertWorkflowContext(draft, input.projectId, input.workflowContext);
      if (
        !AuthoringIdSchema.safeParse(input.id).success ||
        !ActualGenerationInputsSchema.safeParse(input.actualInputs).success
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "Evidence requires a stable ID and valid ordered actual inputs with hashes and roles.",
        );
      const prepared = await this.prepareInState(
        draft,
        input.projectId,
        input.packet?.request,
      );
      if (
        !prepared.packet ||
        prepared.packet.hash !== input.packet.hash ||
        canonicalizeJson(prepared.packet) !== canonicalizeJson(input.packet)
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "Packet is invalid, changed or references material that is no longer ready.",
        );
      if (
        !input.id?.trim() ||
        !input.operationId?.trim() ||
        !input.evidence?.trim() ||
        !Array.isArray(input.outputs) ||
        input.outputs.some((a) => !draft.assets[key(input.projectId, a)])
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "Evidence requires an ID, operationId, explanation and existing output assets.",
        );
      if (
        !["manual_unknown", "agent_reported", "request_capture"].includes(
          input.method,
        ) ||
        !Array.isArray(input.actualInputs) ||
        input.actualInputs.some(
          (a) =>
            !draft.assets[key(input.projectId, a.asset)] ||
            draft.assets[key(input.projectId, a.asset)].sha256 !== a.sha256,
        )
      )
        throw new DomainError(
          "VALIDATION_FAILED",
          "Invalid actual input evidence.",
        );
      const k = key(input.projectId, input.id),
        receiptKey = canonicalizeJson([
          "authoring-evidence",
          input.projectId,
          auth.actorId,
          input.operationId,
        ]),
        fingerprint = canonicalizeJson(input);
      const receipt = draft.idempotencyRecords[receiptKey] as
        { fingerprint: string; result: GenerationEvidence } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError(
            "VALIDATION_FAILED",
            "Idempotency key was reused.",
          );
        return receipt.result;
      }
      if (draft.generationEvidence[k])
        throw new DomainError(
          "IMMUTABILITY_VIOLATION",
          "Generation evidence is immutable.",
        );
      const expected = input.packet.inputs.map(({ asset, sha256, role }) => ({
        asset,
        sha256,
        role,
      }));
      const record: GenerationEvidence = {
        id: input.id,
        projectId: input.projectId,
        packet: input.packet,
        actualInputs: input.actualInputs,
        outputs: input.outputs,
        method: input.method,
        evidence: input.evidence,
        actorId: auth.actorId,
        createdAt: new Date().toISOString(),
        matchesPlan:
          input.method !== "manual_unknown" &&
          canonicalizeJson(expected) === canonicalizeJson(input.actualInputs),
      };
      draft.generationEvidence[k] = record;
      draft.idempotencyRecords[receiptKey] = { fingerprint, result: record };
      return record;
    });
  }
  async evidence(actor: ActorIdentity | null | undefined, projectId: string) {
    const state = await this.store.readState();
    this.access(state, projectId, actor, "reader");
    return Object.values(state.generationEvidence).filter(
      (r) => r.projectId === projectId,
    );
  }
}

export function assertStrictSubjectReferences(
  state: State,
  projectId: string,
  subject: import("@vflow/protocol").SubjectSnapshot,
  context?: WorkflowContext,
): void {
  if (!isStrictProject(state, projectId)) return;
  assertWorkflowContext(state, projectId, context);
  for (const [variant, data] of Object.entries(subject.variants)) {
    for (const entry of data.referencePack) {
      const covered = Object.values(state.materials).some(
        (r) =>
          r.projectId === projectId &&
          Object.values(r.revisions).some(
            (rev) =>
              rev.status === "approved" &&
              rev.document.kind === "reference_pack" &&
              rev.document.category !== "moodboard" &&
              rev.document.views.some(
                (v) =>
                  v.asset === entry.asset &&
                  v.owner.id === subject.id &&
                  v.owner.revision === subject.revision &&
                  v.owner.variant === variant &&
                  v.owner.kind === subject.kind &&
                  v.review?.decision === "accepted",
              ),
          ),
      );
      if (!covered)
        throw new DomainError(
          "REFERENCE_REVIEW_REQUIRED",
          "Each canonical subject reference needs a separately reviewed typed reference view.",
          {
            asset: entry.asset,
            subjectId: subject.id,
            action:
              "authoring_document_put / authoring_document_review / authoring_document_approve",
          },
        );
    }
  }
}
