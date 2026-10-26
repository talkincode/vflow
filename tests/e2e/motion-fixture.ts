import fs from "node:fs/promises";
import path from "node:path";
import type { VFlowClient } from "@vflow/client";
import {
  AUTHORING_POLICY_VERSION,
  AUTHORING_VERSION,
  REQUIRED_REVIEW_CHECKS,
  type GenerationInputRequest,
  type MotionReference,
} from "@vflow/protocol";
import { seedReferences, referenceProject } from "./reference-fixture.ts";

export const motionProject = referenceProject;
/** Synthetic bytes standing in for an externally produced archive of the white-model project. */
export const archiveBytes = new TextEncoder().encode(
  "synthetic white-model project archive; vflow never opens it",
);

/** Upload the five media roles a white-model motion reference needs. */
export async function motionAssets(
  client: VFlowClient,
  projectId = motionProject,
) {
  const read = (name: string) =>
    fs
      .readFile(path.resolve(import.meta.dirname, "../fixtures", name))
      .then((b) => new Uint8Array(b));
  const png = await read("preview.png");
  await client.uploadAsset({
    projectId,
    assetId: "mo-video",
    mimeType: "video/mp4",
    bytes: await read("preview.mp4"),
    durationFrames: 96,
  });
  for (const id of ["mo-overview", "mo-kf-start", "mo-kf-mid", "mo-kf-end"])
    await client.uploadAsset({
      projectId,
      assetId: id,
      mimeType: "image/png",
      bytes: png,
    });
  await client.uploadAsset({
    projectId,
    assetId: "mo-source",
    mimeType: "application/zip",
    bytes: archiveBytes,
  });
}

/** A document that is valid against the `seedReferences` composition (main@1, shot spell). */
export function motionDocument(
  f: Awaited<ReturnType<typeof seedReferences>>,
  id = "spell-motion",
): MotionReference {
  return {
    schemaVersion: AUTHORING_VERSION,
    id,
    title: "施法镜头白模",
    kind: "motion_reference",
    compositionId: "main",
    compositionRevision: 1,
    shotId: "spell",
    scene: { id: "bridge", revision: f.scene.revision },
    environmentVariant: "night",
    subjects: [
      { kind: "character", id: "suwei", revision: 1, variant: "default" },
      { kind: "prop", id: "boat", revision: 1, variant: "default" },
    ],
    fps: 24,
    durationFrames: 96,
    video: { asset: "mo-video" },
    overview: { asset: "mo-overview" },
    keyframes: [
      {
        id: "kf-start",
        asset: "mo-kf-start",
        momentFrame: 0,
        purpose: "blocking",
        note: "苏苇伏在石栏，船在画外西侧",
      },
      {
        id: "kf-mid",
        asset: "mo-kf-mid",
        momentFrame: 48,
        purpose: "camera_motion",
      },
      {
        id: "kf-end",
        asset: "mo-kf-end",
        momentFrame: 95,
        purpose: "action_timing",
      },
    ],
    source: { asset: "mo-source" },
    usage: ["camera_motion", "blocking", "action_timing"],
    provenance:
      "外部 3D 工具生成的无贴图白模渲染；视频与归档工程由外部上传，vflow 不执行渲染。",
  };
}

const passAll = (checks: string[]) =>
  Object.fromEntries(checks.map((c) => [c, "pass" as const]));

/** put → review (accepted, every required check passed) → approve. */
export async function approveMotion(
  client: VFlowClient,
  document: MotionReference,
  projectId = motionProject,
) {
  let rev = await client.putAuthoringDocument({
    projectId,
    document,
    baseRevision: 0,
    operationId: `put-${document.id}`,
  });
  rev = await client.reviewAuthoringDocument({
    projectId,
    id: document.id,
    baseRevision: rev.revision,
    operationId: `review-${document.id}`,
    targets: ["$document"],
    review: {
      method: "human",
      reviewer: "fixture-user",
      decision: "accepted",
      evidence:
        "Synthetic acceptance fixture: full playback inspected, keyframes match declared moments.",
      checks: passAll(REQUIRED_REVIEW_CHECKS.motion_reference),
    },
  });
  return client.approveAuthoringDocument({
    projectId,
    id: document.id,
    baseRevision: rev.revision,
    operationId: `approve-${document.id}`,
  });
}

/** Seed references, motion assets and an approved motion reference pinned by composition main@2. */
export async function seedMotion(client: VFlowClient) {
  const f = await seedReferences(client);
  await motionAssets(client);
  const motion = await approveMotion(client, motionDocument(f));
  await client.patchComposition({
    projectId: motionProject,
    compositionId: "main",
    baseRevision: 1,
    operationId: "pin-motion",
    operations: [
      {
        op: "set_authoring",
        authoring: {
          policyVersion: AUTHORING_POLICY_VERSION,
          materials: [
            ...f.document.authoring!.materials,
            { id: motion.document.id, revision: motion.revision },
          ],
        },
      },
    ],
  });
  const request: GenerationInputRequest = {
    ...f.request,
    compositionRevision: 2,
    capabilities: {
      ...f.request.capabilities,
      motion: {
        video: { maxVideos: 1, maxDurationMs: 10000, usages: ["camera_motion", "blocking", "action_timing"] },
        keyframes: { usages: ["camera_motion", "blocking", "action_timing"] },
      },
    },
    motion: {
      reference: { id: motion.document.id, revision: motion.revision },
      usage: ["camera_motion", "blocking", "action_timing"],
      delivery: "video",
    },
  };
  return { ...f, motion, request };
}
