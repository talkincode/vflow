import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const AUTHORING_VERSION = "vflow/reference-workflow/v1" as const;
/** Pre-rename document identifier, still accepted so older material revisions stay readable. */
export const LEGACY_AUTHORING_VERSION =
  "video-compose/reference-workflow/v1" as const;
export type AuthoringSchemaVersion =
  | typeof AUTHORING_VERSION
  | typeof LEGACY_AUTHORING_VERSION;
export const AUTHORING_POLICY_VERSION = "reference-authoring/1" as const;
const id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (v) => !/^https?:/i.test(v) && !v.includes("::"),
    "Use a stable local ID, not a URL or composite key",
  );
export const AuthoringIdSchema = id;
const revision = z.number().int().positive();
export const RevisionPinSchema = z.object({ id, revision }).strict();
export type RevisionPin = z.infer<typeof RevisionPinSchema>;
export const WorkflowContextSchema = z
  .object({
    projectId: id,
    policyVersion: z.literal(AUTHORING_POLICY_VERSION),
    policyRevision: revision,
  })
  .strict();
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;
export const OwnerSchema = z
  .object({
    kind: z.enum(["character", "prop", "scene"]),
    id,
    revision,
    variant: id,
  })
  .strict();
export type ReferenceOwner = z.infer<typeof OwnerSchema>;
export const ReferencePurposeSchema = z.enum([
  "face_identity",
  "wardrobe",
  "prop",
  "environment",
  "layout",
  "first_frame",
  "last_frame",
  "style",
]);
export const ActualGenerationInputsSchema = z
  .array(
    z
      .object({
        asset: id,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        role: ReferencePurposeSchema,
      })
      .strict(),
  )
  .max(100);
export type ReferencePurpose = z.infer<typeof ReferencePurposeSchema>;
export const ReviewSchema = z
  .object({
    decision: z.enum(["accepted", "rejected", "unknown"]),
    method: z.enum(["human", "external"]),
    reviewer: z.string().min(1),
    evidence: z.string().trim().min(1).max(4000),
    checks: z.record(z.enum(["pass", "fail", "unknown"])),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type MaterialReview = z.infer<typeof ReviewSchema>;
export const CropSchema = z
  .object({
    asset: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    regionPx: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: revision,
        height: revision,
      })
      .strict(),
  })
  .strict();
export const ReferenceViewSchema = z
  .object({
    id,
    asset: id,
    owner: OwnerSchema,
    purpose: ReferencePurposeSchema,
    view: z.string().trim().min(1),
    cameraView: z.string().optional(),
    environmentVariant: z.string().optional(),
    source: CropSchema.optional(),
    review: ReviewSchema.optional(),
  })
  .strict();
export type ReferenceView = z.infer<typeof ReferenceViewSchema>;
export const ViewPinSchema = z
  .object({ pack: RevisionPinSchema, viewId: id })
  .strict();
export type ViewPin = z.infer<typeof ViewPinSchema>;
const common = {
  schemaVersion: z.union([
    z.literal(AUTHORING_VERSION),
    z.literal(LEGACY_AUTHORING_VERSION),
  ]),
  id,
  title: z.string().trim().min(1).max(300),
};
export const PolicyDocumentSchema = z
  .object({
    ...common,
    kind: z.literal("policy"),
    mode: z.enum(["strict", "legacy"]),
    policyVersion: z.literal(AUTHORING_POLICY_VERSION),
    constraints: z.array(z.string()).default([]),
  })
  .strict();
export const SceneDocumentSchema = z
  .object({
    ...common,
    kind: z.literal("scene"),
    geometry: z.string().trim().min(1),
    anchors: z.record(
      z
        .object({ description: z.string().min(1), supportSurface: z.boolean() })
        .strict(),
    ),
    environmentVariants: z.record(
      z
        .object({
          time: z.string().min(1),
          weather: z.string().min(1),
          state: z.string().min(1),
        })
        .strict(),
    ),
    review: ReviewSchema.optional(),
  })
  .strict();
export const ReferencePackSchema = z
  .object({
    ...common,
    kind: z.literal("reference_pack"),
    category: z.enum([
      "character_face",
      "character_body",
      "prop_views",
      "prop_catalog",
      "scene_views",
      "layout",
      "moodboard",
      "single_frame",
    ]),
    owner: OwnerSchema.optional(),
    board: z
      .object({
        asset: id,
        rows: revision,
        columns: revision,
        readingOrder: z.literal("row-major"),
      })
      .strict()
      .optional(),
    views: z.array(ReferenceViewSchema).max(100),
    sources: z.array(ViewPinSchema).default([]),
    conflicts: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ReferencePack = z.infer<typeof ReferencePackSchema>;
export const EntityStateSchema = z
  .object({
    subject: OwnerSchema,
    visibility: z.enum(["visible", "hidden", "entering", "exiting"]),
    bounds: z.tuple([
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
    ]),
    facing: z.string().min(1),
    supportAnchor: id.optional(),
    heldProp: id.optional(),
    state: z.string().min(1),
    occlusion: z.string().min(1),
  })
  .strict();
export const StoryboardPanelSchema = z
  .object({
    id,
    order: z.number().int().nonnegative(),
    momentFrame: z.number().int().nonnegative(),
    shotId: id,
    asset: id,
    source: CropSchema.optional(),
    scene: RevisionPinSchema,
    environmentVariant: id,
    cameraView: z.string().min(1),
    sources: z.array(ViewPinSchema).min(1),
    entities: z.array(EntityStateSchema),
    transition: z.string().min(1),
    textPolicy: z.enum(["forbidden", "diegetic_exception"]),
    textException: z.string().min(1).optional(),
    review: ReviewSchema.optional(),
  })
  .strict();
export const StoryboardSequenceSchema = z
  .object({
    ...common,
    kind: z.literal("storyboard_sequence"),
    compositionId: id,
    compositionRevision: revision,
    captionPolicy: z.literal("forbidden"),
    panels: z.array(StoryboardPanelSchema).min(1).max(100),
    board: z
      .object({
        asset: id,
        rows: revision,
        columns: revision,
        readingOrder: z.literal("row-major"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StoryboardSequence = z.infer<typeof StoryboardSequenceSchema>;
export const MaterialDocumentSchema = z.discriminatedUnion("kind", [
  PolicyDocumentSchema,
  SceneDocumentSchema,
  ReferencePackSchema,
  StoryboardSequenceSchema,
]);
export type MaterialDocument = z.infer<typeof MaterialDocumentSchema>;
export const MaterialRevisionSchema = z
  .object({
    projectId: id,
    revision,
    status: z.enum(["candidate", "approved"]),
    actorId: z.string().min(1),
    createdAt: z.string().datetime(),
    operationId: id,
    document: MaterialDocumentSchema,
  })
  .strict();
export type MaterialRevision = z.infer<typeof MaterialRevisionSchema>;
export interface MaterialRecord {
  projectId: string;
  id: string;
  headRevision: number;
  revisions: Record<number, MaterialRevision>;
}
export const CompositionAuthoringSchema = z
  .object({
    policyVersion: z.literal(AUTHORING_POLICY_VERSION),
    materials: z.array(RevisionPinSchema),
  })
  .strict();
export type CompositionAuthoring = z.infer<typeof CompositionAuthoringSchema>;
export const TargetCapabilitiesSchema = z
  .object({
    verifiedAt: z.string().datetime(),
    evidence: z.string().trim().min(1),
    maxImages: revision,
    roles: z.array(ReferencePurposeSchema).min(1),
    supportsGridSequence: z.boolean(),
  })
  .strict();
export const GenerationInputRequestSchema = z
  .object({
    compositionId: id,
    compositionRevision: revision,
    shotId: id,
    inputs: z
      .array(
        z
          .object({
            source: ViewPinSchema.optional(),
            sequence: RevisionPinSchema.optional(),
            panelId: id.optional(),
            role: ReferencePurposeSchema,
            wholeBoard: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    capabilities: TargetCapabilitiesSchema,
    prompt: z.string().trim().min(1),
    templateVersion: z.literal(AUTHORING_POLICY_VERSION),
  })
  .strict();
export type GenerationInputRequest = z.infer<
  typeof GenerationInputRequestSchema
>;
export interface ResolvedGenerationInput {
  asset: string;
  sha256: string;
  role: ReferencePurpose;
  owner?: ReferenceOwner;
  source: ViewPin | { sequence: RevisionPin; panelId: string };
  sourceBoard?: string;
}
export interface GenerationInputPacket {
  schemaVersion: AuthoringSchemaVersion;
  projectId: string;
  policyVersion: typeof AUTHORING_POLICY_VERSION;
  request: GenerationInputRequest;
  inputs: ResolvedGenerationInput[];
  hash: string;
}
export interface GenerationEvidence {
  id: string;
  projectId: string;
  packet: GenerationInputPacket;
  actualInputs: Array<{
    asset: string;
    sha256: string;
    role: ReferencePurpose;
  }>;
  outputs: string[];
  method: "agent_reported" | "request_capture" | "manual_unknown";
  evidence: string;
  actorId: string;
  createdAt: string;
  matchesPlan: boolean;
}
export interface AuthoringDiagnostic {
  code: string;
  path: string;
  message: string;
  action: string;
}
export interface AuthoringValidation {
  ready: boolean;
  diagnostics: AuthoringDiagnostic[];
}

export const REQUIRED_REVIEW_CHECKS: Record<
  ReferencePack["category"] | "scene" | "storyboard_sequence",
  string[]
> = {
  character_face: [
    "single_identity",
    "face_visible",
    "neutral_lighting",
    "identity_consistent",
  ],
  character_body: [
    "single_identity",
    "body_proportion",
    "wardrobe_consistent",
    "grounding",
  ],
  prop_views: ["single_prop", "shape_consistent", "scale_material_state"],
  prop_catalog: ["cell_ownership", "isolated_tiles", "scale_material_state"],
  scene_views: [
    "geometry_consistent",
    "environment_consistent",
    "camera_identified",
  ],
  layout: ["geometry_consistent", "axis_identified", "support_surfaces"],
  single_frame: [
    "identity_consistent",
    "spatial_continuity",
    "state_consistent",
  ],
  moodboard: [],
  scene: ["geometry_consistent", "support_surfaces", "environment_defined"],
  storyboard_sequence: [
    "identity_consistent",
    "spatial_continuity",
    "state_consistent",
    "text_policy",
  ],
};

export function materialAssetIds(document: MaterialDocument): string[] {
  if (document.kind === "reference_pack")
    return [
      ...new Set([
        ...(document.board ? [document.board.asset] : []),
        ...document.views.flatMap((v) => [
          v.asset,
          ...(v.source ? [v.source.asset] : []),
        ]),
      ]),
    ];
  if (document.kind === "storyboard_sequence")
    return [
      ...new Set([
        ...(document.board ? [document.board.asset] : []),
        ...document.panels.flatMap((p) => [
          p.asset,
          ...(p.source ? [p.source.asset] : []),
        ]),
      ]),
    ];
  return [];
}
export function materialPins(document: MaterialDocument): RevisionPin[] {
  if (document.kind === "reference_pack")
    return [
      ...document.sources.map((s) => s.pack),
      ...document.views
        .filter((v) => v.owner.kind === "scene")
        .map((v) => ({ id: v.owner.id, revision: v.owner.revision })),
    ];
  if (document.kind === "storyboard_sequence")
    return document.panels.flatMap((p) => [
      p.scene,
      ...p.sources.map((s) => s.pack),
    ]);
  return [];
}
export function structuralMaterialDiagnostics(
  document: MaterialDocument,
): AuthoringDiagnostic[] {
  const out: AuthoringDiagnostic[] = [];
  const add = (code: string, path: string, message: string) =>
    out.push({
      code,
      path,
      message,
      action: "Correct the manifest, then validate again.",
    });
  const items =
    document.kind === "reference_pack"
      ? document.views
      : document.kind === "storyboard_sequence"
        ? document.panels
        : [];
  const ids = new Set<string>();
  items.forEach((item, i) => {
    if (ids.has(item.id))
      add(
        "STORYBOARD_LAYOUT_INVALID",
        `items[${i}].id`,
        "Duplicate view/panel ID.",
      );
    ids.add(item.id);
  });
  if (document.kind === "reference_pack") {
    const owners = new Set(document.views.map((v) => JSON.stringify(v.owner)));
    if (
      document.category !== "prop_catalog" &&
      document.category !== "moodboard" &&
      (owners.size !== 1 ||
        !document.owner ||
        document.views.some(
          (v) => JSON.stringify(v.owner) !== JSON.stringify(document.owner),
        ))
    )
      add(
        "REFERENCE_SCOPE_MISMATCH",
        "owner",
        "A canonical pack must have exactly one owner identity and variant.",
      );
    const category = document.category;
    const expected =
      category === "character_face"
        ? "face_identity"
        : category === "character_body"
          ? "wardrobe"
          : category.startsWith("prop_")
            ? "prop"
            : category === "scene_views"
              ? "environment"
              : category === "layout"
                ? "layout"
                : undefined;
    document.views.forEach((view, i) => {
      const kind = category.startsWith("character_")
        ? "character"
        : category.startsWith("prop_")
          ? "prop"
          : ["scene_views", "layout"].includes(category)
            ? "scene"
            : undefined;
      if (
        category === "single_frame" &&
        !["first_frame", "last_frame"].includes(view.purpose)
      )
        add(
          "REFERENCE_USAGE_AMBIGUOUS",
          `views[${i}].purpose`,
          "Single-frame candidates cannot substitute for identity, wardrobe or environment packs.",
        );
      if (
        (kind && view.owner.kind !== kind) ||
        (expected && view.purpose !== expected)
      )
        add(
          "REFERENCE_SCOPE_MISMATCH",
          `views[${i}]`,
          "View owner or purpose conflicts with the pack category.",
        );
      if (
        category !== "moodboard" &&
        document.board &&
        (!view.source ||
          view.source.asset !== document.board.asset ||
          view.asset === document.board.asset)
      )
        add(
          "GRID_CELL_REQUIRED",
          `views[${i}]`,
          "A board cell needs its own tile asset and a source region.",
        );
    });
    if (
      [
        "character_face",
        "character_body",
        "prop_views",
        "scene_views",
      ].includes(category) &&
      new Set(document.views.map((v) => v.view)).size < 2
    )
      add(
        "REFERENCE_REVIEW_REQUIRED",
        "views",
        "At least two distinct views are required; face/body or different subjects cannot share a pack.",
      );
    if (
      category !== "moodboard" &&
      document.board &&
      document.board.rows * document.board.columns !== document.views.length
    )
      add(
        "STORYBOARD_LAYOUT_INVALID",
        "board",
        "Grid dimensions must equal the number of cells.",
      );
    document.conflicts.forEach((message, i) =>
      add("REFERENCE_CONFLICT_UNRESOLVED", `conflicts[${i}]`, message),
    );
  }
  if (document.kind === "storyboard_sequence") {
    const moments = new Set<string>();
    document.panels.forEach((p, i) => {
      if (p.order !== i || moments.has(`${p.shotId}@${p.momentFrame}`))
        add(
          "STORYBOARD_LAYOUT_INVALID",
          `panels[${i}]`,
          "Panels require unique chronological moments and contiguous order.",
        );
      moments.add(`${p.shotId}@${p.momentFrame}`);
      if (p.textPolicy === "diegetic_exception" && !p.textException)
        add(
          "STORYBOARD_TEXT_DETECTED",
          `panels[${i}].textException`,
          "Diegetic text requires an explicit exception.",
        );
      if (
        document.board &&
        (!p.source ||
          p.source.asset !== document.board.asset ||
          p.asset === document.board.asset)
      )
        add(
          "GRID_CELL_REQUIRED",
          `panels[${i}]`,
          "Sequence panels need independent tiles.",
        );
      p.entities.forEach((e, j) => {
        if (e.bounds[0] + e.bounds[2] > 1 || e.bounds[1] + e.bounds[3] > 1)
          add(
            "STORYBOARD_LAYOUT_INVALID",
            `panels[${i}].entities[${j}].bounds`,
            "Bounds exceed the frame.",
          );
      });
    });
    if (
      document.board &&
      document.board.rows * document.board.columns !== document.panels.length
    )
      add(
        "STORYBOARD_LAYOUT_INVALID",
        "board",
        "Grid dimensions must equal panel count.",
      );
  }
  return out;
}

export const MATERIAL_DOCUMENT_JSON_SCHEMA = /* @__PURE__ */ zodToJsonSchema(
  MaterialDocumentSchema,
  { target: "jsonSchema7", $refStrategy: "none" },
);
export const GENERATION_INPUT_JSON_SCHEMA = /* @__PURE__ */ zodToJsonSchema(
  GenerationInputRequestSchema,
  { target: "jsonSchema7", $refStrategy: "none" },
);
