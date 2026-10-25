import fs from "node:fs/promises";
import path from "node:path";
import type { VideoComposeClient } from "@video-compose/client";
import {
  AUTHORING_VERSION,
  AUTHORING_POLICY_VERSION,
  REQUIRED_REVIEW_CHECKS,
  type ReferenceOwner,
  type ReferencePack,
  type MaterialDocument,
  type CompositionDocument,
  type GenerationInputRequest,
} from "@video-compose/protocol";
export const referenceProject = "reference-test";
export async function referenceAssets(
  client: VideoComposeClient,
  projectId = referenceProject,
) {
  const bytes = new Uint8Array(
    await fs.readFile(
      path.resolve(import.meta.dirname, "../fixtures/preview.png"),
    ),
  );
  for (const assetId of [
    "face-front",
    "face-side",
    "body-front",
    "body-side",
    "prop-front",
    "prop-side",
    "scene-front",
    "scene-side",
    "panel-one",
    "panel-two",
    "raw-board",
  ])
    await client.uploadAsset({
      projectId,
      assetId,
      mimeType: "image/png",
      bytes,
    });
}
export function referencePack(
  id: string,
  category: ReferencePack["category"],
  owner: ReferenceOwner,
  assetPrefix: string,
): ReferencePack {
  const purpose =
    category === "character_face"
      ? "face_identity"
      : category === "character_body"
        ? "wardrobe"
        : category.startsWith("prop_")
          ? "prop"
          : "environment";
  return {
    schemaVersion: AUTHORING_VERSION,
    id,
    title: id,
    kind: "reference_pack",
    category,
    owner,
    views: ["front", "side"].map((view) => ({
      id: view,
      asset: `${assetPrefix}-${view}`,
      view,
      owner,
      purpose,
      ...(owner.kind === "scene"
        ? {
            cameraView: view === "front" ? "wide" : "close",
            environmentVariant: owner.variant,
          }
        : {}),
    })),
    sources: [],
    conflicts: [],
  };
}
export async function approveMaterial(
  client: VideoComposeClient,
  document: MaterialDocument,
  projectId = referenceProject,
) {
  let rev = await client.putAuthoringDocument({
    projectId,
    document,
    baseRevision: 0,
    operationId: `put-${document.id}`,
  });
  const category =
    document.kind === "reference_pack" ? document.category : document.kind;
  if (category === "policy")
    throw new Error("Visual fixture must not be a policy");
  const targets =
    document.kind === "reference_pack"
      ? document.views.map((v) => v.id)
      : document.kind === "storyboard_sequence"
        ? document.panels.map((p) => p.id)
        : ["$document"];
  rev = await client.reviewAuthoringDocument({
    projectId,
    id: document.id,
    baseRevision: rev.revision,
    operationId: `review-${document.id}`,
    targets,
    review: {
      method: "human",
      reviewer: "fixture-user",
      decision: "accepted",
      evidence:
        "Synthetic acceptance fixture: each independent image and metadata inspected for this test.",
      checks: Object.fromEntries(
        REQUIRED_REVIEW_CHECKS[category].map((c) => [c, "pass"]),
      ),
    },
  });
  return client.approveAuthoringDocument({
    projectId,
    id: document.id,
    baseRevision: rev.revision,
    operationId: `approve-${document.id}`,
  });
}
export async function seedReferences(
  client: VideoComposeClient,
  authoringMode: "strict" | "legacy" = "strict",
) {
  const projectId = referenceProject;
  await client.createProject({
    authoringMode,
    id: projectId,
    name: "旧桥分水参考验收",
    members: {
      "bob-reader@talkincode.net": "reader",
      "agent-storyboard": "writer",
    },
  });
  const workflow = await client.getAuthoringWorkflow(projectId);
  await referenceAssets(client);
  for (const [id, kind, prefix] of [
    ["suwei", "character", "face"],
    ["boat", "prop", "prop"],
  ] as const) {
    await client.createSubject({
      projectId,
      id,
      kind,
      name: id,
      defaultVariant: "default",
      definition: {
        description:
          id === "suwei" ? "苏苇在石栏施法，不在水中" : "船首方向与船尾灯固定",
        invariants: ["固定身份与结构"],
      },
      variants: {
        default: {
          description: "默认状态",
          referencePack: ["front", "side"].map((v) => ({
            asset: `${prefix}-${v}`,
            status: "candidate",
          })),
        },
      },
    });
  }
  const suwei: ReferenceOwner = {
    kind: "character",
    id: "suwei",
    revision: 1,
    variant: "default",
  };
  const boat: ReferenceOwner = {
    kind: "prop",
    id: "boat",
    revision: 1,
    variant: "default",
  };
  const face = await approveMaterial(
    client,
    referencePack("suwei-face", "character_face", suwei, "face"),
  );
  const body = await approveMaterial(
    client,
    referencePack("suwei-body", "character_body", suwei, "body"),
  );
  const prop = await approveMaterial(
    client,
    referencePack("boat-views", "prop_views", boat, "prop"),
  );
  for (const subjectId of ["suwei", "boat"])
    await client.approveSubjectRevision({
      projectId,
      subjectId,
      revision: 1,
      operationId: `approve-${subjectId}`,
    });
  const scene = await approveMaterial(client, {
    schemaVersion: AUTHORING_VERSION,
    id: "bridge",
    title: "旧桥",
    kind: "scene",
    geometry: "三拱旧桥，船沿河道前进，摄影机保持河道南侧",
    anchors: {
      stone_rail: { description: "苏苇伏身的石栏", supportSurface: true },
      deck: { description: "船甲板", supportSurface: true },
    },
    environmentVariants: {
      night: { time: "夜晚", weather: "薄雾", state: "水位未上涨，水流向东" },
      dawn: { time: "黎明", weather: "晴", state: "水位正常" },
    },
  });
  const environment = await approveMaterial(
    client,
    referencePack(
      "bridge-night",
      "scene_views",
      {
        kind: "scene",
        id: "bridge",
        revision: scene.revision,
        variant: "night",
      },
      "scene",
    ),
  );
  const materials = [face, body, prop, scene, environment].map((r) => ({
    id: r.document.id,
    revision: r.revision,
  }));
  const document: CompositionDocument = {
    apiVersion: "video-compose/v2",
    id: "main",
    project: projectId,
    title: "关键镜头",
    format: { width: 1920, height: 1080, fps: 30 },
    audioTracks: [],
    authoring: { policyVersion: AUTHORING_POLICY_VERSION, materials },
    sequence: ["spell", "boat"],
    shots: Object.fromEntries(
      ["spell", "boat"].map((id) => [
        id,
        {
          description: id,
          durationFrames: 120,
          dependsOn: [],
          subjects: [
            { subjectId: "suwei", subjectRevision: 1 },
            { subjectId: "boat", subjectRevision: 1 },
          ],
          references: { images: [], videos: [] },
          prompts: {},
          candidates: { images: [], videos: [], audios: [] },
          selected: { video: null, audio: null },
        },
      ]),
    ),
  };
  await client.createComposition({ projectId, document });
  const request: GenerationInputRequest = {
    compositionId: "main",
    compositionRevision: 1,
    shotId: "spell",
    inputs: [
      {
        source: {
          pack: { id: "suwei-face", revision: face.revision },
          viewId: "front",
        },
        role: "face_identity",
        wholeBoard: false,
      },
    ],
    capabilities: {
      verifiedAt: new Date().toISOString(),
      evidence:
        "Fixture target supports 3 image references with independent roles.",
      maxImages: 3,
      roles: [
        "face_identity",
        "wardrobe",
        "prop",
        "environment",
        "first_frame",
        "last_frame",
      ],
      supportsGridSequence: false,
    },
    prompt: "苏苇伏于旧桥石栏，手指牵引水势，面部施法特写",
    templateVersion: AUTHORING_POLICY_VERSION,
  };
  return {
    workflow,
    document,
    request,
    suwei,
    boat,
    face,
    body,
    prop,
    scene,
    environment,
  };
}
