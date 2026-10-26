import { describe, expect, it } from "vitest";
import {
  AUTHORING_POLICY_VERSION,
  type MotionReference,
} from "@vflow/protocol";
import { createTestHarness } from "./helpers.ts";
import {
  approveMotion,
  motionAssets,
  motionDocument,
  motionProject as projectId,
} from "./motion-fixture.ts";
import { seedReferences, approveMaterial, referencePack } from "./reference-fixture.ts";

async function setup() {
  const h = createTestHarness();
  const f = await seedReferences(h.writerClient);
  await motionAssets(h.writerClient);
  return { h, f, doc: motionDocument(f) };
}
const diag = async (
  h: ReturnType<typeof createTestHarness>,
  doc: unknown,
): Promise<string[]> =>
  (await h.writerClient.validateAuthoringDocument(projectId, doc)).diagnostics.map(
    (d) => d.code,
  );
const putError = async (
  h: ReturnType<typeof createTestHarness>,
  doc: unknown,
  operationId: string,
) =>
  h.writerClient.putAuthoringDocument({
    projectId,
    document: doc as MotionReference,
    baseRevision: 0,
    operationId,
  });

describe("E2E 19 — motion_reference validation, scope and purpose isolation", () => {
  it("V01 rejects wrong media roles, unverified images, timing and keyframe mistakes before anything is stored", async () => {
    const { h, f, doc } = await setup();
    await h.writerClient.uploadAsset({
      projectId,
      assetId: "not-a-video",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await h.writerClient.uploadAsset({
      projectId,
      assetId: "wrong-length-video",
      mimeType: "video/mp4",
      bytes: new Uint8Array([9, 9, 9]),
      durationFrames: 100,
    });
    const cases: Array<[string, (d: MotionReference) => void, string]> = [
      ["video missing", (d) => (d.video.asset = "absent"), "MISSING_ASSET_REFERENCE"],
      ["video is an image", (d) => (d.video.asset = "not-a-video"), "MISSING_ASSET_REFERENCE"],
      ["overview is a video", (d) => (d.overview.asset = "wrong-length-video"), "MISSING_ASSET_REFERENCE"],
      ["overview undecodable header", (d) => (d.overview.asset = "not-a-video"), "MEDIA_DIMENSIONS_UNVERIFIED"],
      ["keyframe missing", (d) => (d.keyframes[0].asset = "absent"), "MISSING_ASSET_REFERENCE"],
      ["source missing", (d) => (d.source.asset = "absent"), "MISSING_ASSET_REFERENCE"],
      ["declared asset duration differs", (d) => (d.video.asset = "wrong-length-video"), "MOTION_TIMING_INVALID"],
      ["keyframe after the end", (d) => (d.keyframes[2].momentFrame = 96), "MOTION_TIMING_INVALID"],
      ["duplicate keyframe id", (d) => (d.keyframes[1].id = "kf-start"), "MOTION_TIMING_INVALID"],
      ["same moment and purpose", (d) => {
        d.keyframes[1].momentFrame = 0;
        d.keyframes[1].purpose = "blocking";
      }, "MOTION_TIMING_INVALID"],
      ["longer than the shot (97f@24 = 4.04s > 4s)", (d) => (d.durationFrames = 97), "MOTION_TIMING_INVALID"],
      ["shorter than the shot (95f@24 = 3.96s < 4s): L0 covers the whole shot", (d) => (d.durationFrames = 95), "MOTION_TIMING_INVALID"],
      ["same frames but another fps (96f@30 = 3.2s)", (d) => (d.fps = 30), "MOTION_TIMING_INVALID"],
      ["keyframe purpose outside usage", (d) => (d.keyframes[0].purpose = "framing"), "MOTION_USAGE_INVALID"],
      ["duplicate usage", (d) => d.usage.push("blocking"), "MOTION_USAGE_INVALID"],
      ["one asset for two roles", (d) => (d.keyframes[1].asset = "mo-kf-start"), "REFERENCE_SCOPE_MISMATCH"],
      ["overview reused as keyframe", (d) => (d.keyframes[1].asset = "mo-overview"), "REFERENCE_SCOPE_MISMATCH"],
      ["composition revision missing", (d) => (d.compositionRevision = 9), "DEPENDENCY_ERROR"],
      ["shot missing", (d) => (d.shotId = "ghost"), "DEPENDENCY_ERROR"],
      ["composition missing", (d) => (d.compositionId = "ghost"), "DEPENDENCY_ERROR"],
    ];
    for (const [name, mutate, code] of cases) {
      const bad = structuredClone(doc);
      mutate(bad);
      expect(await diag(h, bad), name).toContain(code);
      await expect(putError(h, bad, `bad-${name}`), name).rejects.toMatchObject({
        code,
      });
    }
    // Whole-shot coverage is about seconds, not frame counts: 120f@30 matches the 4s shot of 120f@30.
    await h.writerClient.uploadAsset({
      projectId,
      assetId: "video-30fps",
      mimeType: "video/mp4",
      bytes: new Uint8Array([8, 8, 8]),
      durationFrames: 120,
    });
    const sameSeconds = structuredClone(doc);
    sameSeconds.fps = 30;
    sameSeconds.durationFrames = 120;
    sameSeconds.video.asset = "video-30fps";
    expect(await diag(h, sameSeconds)).not.toContain("MOTION_TIMING_INVALID");
    // A shot without a declared duration has no checkable length, so it cannot take a whole-shot reference.
    await h.writerClient.createComposition({
      projectId,
      document: {
        ...structuredClone(f.document),
        id: "nodur",
        sequence: ["spell"],
        shots: { spell: { ...f.document.shots.spell, durationFrames: undefined } },
      },
    });
    const undated = { ...structuredClone(doc), compositionId: "nodur", compositionRevision: 1 };
    expect(await diag(h, undated)).toContain("MOTION_TIMING_INVALID");
    await expect(putError(h, undated, "undated")).rejects.toMatchObject({ code: "MOTION_TIMING_INVALID" });
    // None of the failed puts left a record behind.
    expect(await h.writerClient.listAuthoringDocuments(projectId)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: doc.id })]),
    );
    expect(await diag(h, doc)).toEqual(
      expect.not.arrayContaining(["MISSING_ASSET_REFERENCE", "MOTION_TIMING_INVALID"]),
    );
    expect(f.scene.revision).toBe(3);
  });

  it("V02 the schema is strict and engine-agnostic: unknown or vendor fields are refused", async () => {
    const { h, doc } = await setup();
    for (const extra of [{ engine: "blender" }, { blender: { version: "4.2" } }, { threejs: {} }]) {
      expect(await diag(h, { ...doc, ...extra })).toContain("VALIDATION_FAILED");
      await expect(putError(h, { ...doc, ...extra }, "extra")).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
    const keyframeExtra = structuredClone(doc) as unknown as { keyframes: Array<Record<string, unknown>> };
    keyframeExtra.keyframes[0].isFirstFrame = true;
    expect(await diag(h, keyframeExtra)).toContain("VALIDATION_FAILED");
    for (const key of ["video", "overview", "source", "scene", "fps", "durationFrames", "shotId", "usage", "keyframes"]) {
      const missing = structuredClone(doc) as unknown as Record<string, unknown>;
      delete missing[key];
      expect(await diag(h, missing), key).toContain("VALIDATION_FAILED");
    }
    const noKeyframes = structuredClone(doc);
    noKeyframes.keyframes = [];
    expect(await diag(h, noKeyframes)).toContain("VALIDATION_FAILED");
    const badFps = structuredClone(doc);
    badFps.fps = 23.976;
    expect(await diag(h, badFps)).toContain("VALIDATION_FAILED");
  });

  it("V03 scene, environment variant and subjects are exact pins that must match the shot", async () => {
    const { h, f, doc } = await setup();
    const unknownVariant = { ...structuredClone(doc), environmentVariant: "dusk" };
    expect(await diag(h, unknownVariant)).toContain("REFERENCE_SCOPE_MISMATCH");
    await expect(putError(h, unknownVariant, "variant")).rejects.toMatchObject({
      code: "REFERENCE_SCOPE_MISMATCH",
    });
    const unknownScene = { ...structuredClone(doc), scene: { id: "bridge", revision: 99 } };
    await expect(putError(h, unknownScene, "scene")).rejects.toMatchObject({
      code: "REFERENCE_SCOPE_MISMATCH",
    });
    const missingBoat = structuredClone(doc);
    missingBoat.subjects = missingBoat.subjects.filter((s) => s.id !== "boat");
    await expect(putError(h, missingBoat, "missing")).rejects.toMatchObject({
      code: "REFERENCE_SCOPE_MISMATCH",
    });
    const extra = structuredClone(doc);
    extra.subjects.push({ kind: "prop", id: "lantern", revision: 1, variant: "default" });
    await expect(putError(h, extra, "extra")).rejects.toMatchObject({
      code: "REFERENCE_SCOPE_MISMATCH",
    });
    const wrongVariant = structuredClone(doc);
    wrongVariant.subjects[0].variant = "wet";
    await expect(putError(h, wrongVariant, "wrong-variant")).rejects.toMatchObject({
      code: "REFERENCE_SCOPE_MISMATCH",
    });
    const wrongKind = structuredClone(doc);
    wrongKind.subjects[0].kind = "prop";
    await expect(putError(h, wrongKind, "wrong-kind")).rejects.toMatchObject({
      code: "REFERENCE_SCOPE_MISMATCH",
    });
    const duplicate = structuredClone(doc);
    duplicate.subjects.push(duplicate.subjects[0]);
    expect(await diag(h, duplicate)).toContain("REFERENCE_SCOPE_MISMATCH");
    // Approval additionally requires an approved scene revision.
    const sceneDraft = await h.writerClient.getAuthoringDocument(projectId, "bridge", 1);
    expect(sceneDraft.status).toBe("candidate");
    await h.writerClient.putAuthoringDocument({
      projectId,
      document: { ...structuredClone(doc), scene: { id: "bridge", revision: 1 } },
      baseRevision: 0,
      operationId: "cand-scene",
    });
    expect(
      (await h.writerClient.validateAuthoringDocument(projectId, {
        ...doc,
        scene: { id: "bridge", revision: 1 },
      })).diagnostics.map((d) => d.code),
    ).toContain("REFERENCE_REVIEW_REQUIRED");
    expect(f.suwei.revision).toBe(1);
  });

  it("V04 purpose isolation: motion images are never identity/environment/first-frame images, in either direction, and never direct shot references", async () => {
    const { h, f, doc } = await setup();
    // (a) An already-canonical identity view cannot be smuggled in as a keyframe.
    const stolen = motionDocument(f, "stolen-motion");
    stolen.keyframes[0].asset = "face-front";
    await h.writerClient.putAuthoringDocument({
      projectId,
      document: stolen,
      baseRevision: 0,
      operationId: "stolen-put",
    });
    await expect(
      h.writerClient.reviewAuthoringDocument({
        projectId,
        id: stolen.id,
        baseRevision: 1,
        operationId: "stolen-review",
        targets: ["$document"],
        review: {
          method: "human",
          reviewer: "x",
          decision: "accepted",
          evidence: "inspected",
          checks: Object.fromEntries(
            [
              "whitebox_only",
              "scene_geometry_match",
              "subject_blocking_match",
              "timing_verified",
              "keyframes_match_video",
              "text_policy",
            ].map((c) => [c, "pass"]),
          ),
        },
      }),
    ).resolves.toBeDefined();
    await expect(
      h.writerClient.approveAuthoringDocument({
        projectId,
        id: stolen.id,
        baseRevision: 2,
        operationId: "stolen-approve",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });

    // (b) Once a motion reference is approved, its frames cannot become canonical packs.
    const approved = await approveMotion(h.writerClient, doc);
    const reuse = referencePack("reuse-pack", "character_face", f.suwei, "face");
    reuse.views[0].asset = "mo-kf-mid";
    await expect(approveMaterial(h.writerClient, reuse)).rejects.toMatchObject({
      code: "REFERENCE_REVIEW_REQUIRED",
    });
    // (c) Motion frames are not approved reference images, so a strict shot cannot take them as direct references.
    await expect(
      h.writerClient.patchComposition({
        projectId,
        compositionId: "main",
        baseRevision: 1,
        operationId: "direct-ref",
        operations: [
          {
            op: "set_authoring",
            authoring: {
              policyVersion: AUTHORING_POLICY_VERSION,
              materials: [
                ...f.document.authoring!.materials,
                { id: approved.document.id, revision: approved.revision },
              ],
            },
          },
          {
            op: "upsert_shot",
            shotId: "spell",
            shot: {
              ...f.document.shots.spell,
              references: { images: [{ asset: "mo-kf-start" }], videos: [] },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    expect((await h.writerClient.getComposition(projectId, "main")).headRevision).toBe(1);
    // (d) Subject writers share the rule: motion media can never be a Subject reference image.
    const pngBytes = new Uint8Array(await (await import("node:fs/promises")).readFile(new URL("../fixtures/preview.png", import.meta.url)));
    await h.writerClient.uploadAsset({ projectId, assetId: "plain-subject-image", mimeType: "image/png", bytes: pngBytes });
    const subjectWith = (asset: string, id: string) => ({
      projectId,
      id,
      name: id,
      kind: "prop" as const,
      status: "candidate" as const,
      defaultVariant: "default",
      definition: { description: "d", invariants: ["i"] },
      variants: { default: { description: "d", referencePack: [{ asset, status: "candidate" as const }] } },
    });
    for (const asset of ["mo-kf-start", "mo-overview", "mo-source"])
      await expect(h.writerClient.createSubject(subjectWith(asset, `s-${asset}`)), asset).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
    await h.writerClient.createSubject(subjectWith("plain-subject-image", "lantern"));
    await expect(
      h.writerClient.attachSubjectReference({ projectId, subjectId: "lantern", baseRevision: 1, operationId: "attach-motion", variant: "default", entry: { asset: "mo-kf-end" } }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
    await expect(
      h.writerClient.patchSubject({ projectId, subjectId: "lantern", baseRevision: 1, operationId: "patch-motion", changes: { variants: { default: { description: "d", referencePack: [{ asset: "mo-kf-mid", status: "candidate" }] } } } }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
    expect((await h.writerClient.getSubject(projectId, "lantern")).subject.latestRevision).toBe(1);
    // ...and the reverse: media already used as a Subject reference image cannot become motion media.
    const reversed = motionDocument(f, "reversed-motion");
    reversed.keyframes[0].asset = "plain-subject-image";
    await h.writerClient.putAuthoringDocument({ projectId, document: reversed, baseRevision: 0, operationId: "reversed-put" });
    expect(await diag(h, reversed)).toContain("REFERENCE_REVIEW_REQUIRED");
    // (e) The motion reference itself is a document, not a Subject reference.
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, doc.id)).document.kind,
    ).toBe("motion_reference");
  });
});
