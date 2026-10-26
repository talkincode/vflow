import { describe, expect, it } from "vitest";
import {
  AUTHORING_POLICY_VERSION,
  REQUIRED_REVIEW_CHECKS,
  canonicalizeJson,
  type GenerationInputRequest,
} from "@vflow/protocol";
import { createTestHarness } from "./helpers.ts";
import { motionProject as projectId, seedMotion } from "./motion-fixture.ts";

async function setup() {
  const h = createTestHarness();
  const f = await seedMotion(h.writerClient);
  return { h, f };
}
type Harness = Awaited<ReturnType<typeof setup>>["h"];
const prepare = (h: Harness, request: unknown) =>
  h.writerClient.prepareGenerationInputs(projectId, request);
const codes = (r: { diagnostics: Array<{ code: string }> }) =>
  r.diagnostics.map((d) => d.code);
const withMotion = (
  request: GenerationInputRequest,
  change: Partial<NonNullable<GenerationInputRequest["motion"]>>,
): GenerationInputRequest => ({
  ...request,
  motion: { ...request.motion!, ...change },
});
const sha = async (h: Harness, id: string) =>
  (await h.writerClient.listAssets(projectId)).find((a) => a.id === id)!.sha256;

describe("E2E 20 — motion input packets: explicit video capability, explicit keyframe degrade, drift", () => {
  it("P01 prepares an exact, deterministic packet for the whole white-model video; hash covers the motion block", async () => {
    const { h, f } = await setup();
    const result = await prepare(h, f.request);
    expect(result.ready).toBe(true);
    const packet = result.packet!;
    expect(packet.motion).toEqual({
      reference: { id: "spell-motion", revision: f.motion.revision },
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      delivery: "video",
      usage: ["camera_motion", "blocking", "action_timing"],
      scene: { id: "bridge", revision: f.scene.revision },
      environmentVariant: "night",
      fps: 24,
      durationFrames: 96,
      video: { asset: "mo-video", sha256: await sha(h, "mo-video") },
    });
    // The identity image list is unchanged: motion never rides in `inputs`.
    expect(packet.inputs.map((i) => i.role)).toEqual(["face_identity"]);
    expect(packet.inputs.some((i) => i.asset.startsWith("mo-"))).toBe(false);
    // Deterministic across calls and across roles; reader can prepare.
    expect((await prepare(h, f.request)).packet?.hash).toBe(packet.hash);
    await h.readerClient.getAuthoringWorkflow(projectId);
    expect((await h.readerClient.prepareGenerationInputs(projectId, f.request)).packet).toEqual(packet);
    // contentHash lets a consumer verify its exported copy of the pinned document.
    const stored = await h.writerClient.getAuthoringDocument(projectId, "spell-motion", f.motion.revision);
    const bytes = new TextEncoder().encode(canonicalizeJson(stored.document));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    expect(
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    ).toBe(packet.motion!.contentHash);
    // Requests without motion stay byte-for-byte compatible: no `motion` key anywhere.
    const plain = await prepare(h, {
      ...f.request,
      motion: undefined,
      capabilities: { ...f.request.capabilities, motion: undefined },
    });
    expect(plain.ready).toBe(true);
    expect(plain.packet).not.toHaveProperty("motion");
    expect(canonicalizeJson(plain.packet!.request)).not.toContain("motion");
    // Source archive and overview are archival: never part of any packet input.
    expect(JSON.stringify(packet)).not.toContain("mo-source");
    expect(JSON.stringify(packet)).not.toContain("mo-overview");
  });

  it("P02 target video capability must be stated; there is no automatic fallback to keyframes", async () => {
    const { h, f } = await setup();
    const noMotionCaps = { ...f.request, capabilities: { ...f.request.capabilities, motion: undefined } };
    const unverified = await prepare(h, noMotionCaps);
    expect(unverified.ready).toBe(false);
    expect(unverified.packet).toBeUndefined();
    expect(codes(unverified)).toContain("MOTION_VIDEO_CAPABILITY_REQUIRED");
    // Keyframes being declared does not turn `video` delivery into a silent degrade.
    const onlyKeyframes = {
      ...f.request,
      capabilities: {
        ...f.request.capabilities,
        motion: { keyframes: { usages: ["camera_motion", "blocking", "action_timing"] } },
      },
    } as GenerationInputRequest;
    const refused = await prepare(h, onlyKeyframes);
    expect(codes(refused)).toContain("MOTION_VIDEO_CAPABILITY_REQUIRED");
    expect(refused.diagnostics.find((d) => d.code === "MOTION_VIDEO_CAPABILITY_REQUIRED")?.action).toMatch(/keyframes/);
    const tooLong = {
      ...f.request,
      capabilities: {
        ...f.request.capabilities,
        motion: { video: { maxVideos: 1, maxDurationMs: 3999, usages: ["camera_motion", "blocking", "action_timing"] } },
      },
    } as GenerationInputRequest;
    expect(codes(await prepare(h, tooLong))).toContain("MOTION_VIDEO_LIMIT_EXCEEDED");
    const exact = {
      ...tooLong,
      capabilities: {
        ...tooLong.capabilities,
        motion: { video: { maxVideos: 1, maxDurationMs: 4000, usages: ["camera_motion", "blocking", "action_timing"] } },
      },
    } as GenerationInputRequest;
    expect((await prepare(h, exact)).ready).toBe(true);
    const unsupportedUsage = {
      ...f.request,
      capabilities: {
        ...f.request.capabilities,
        motion: { video: { maxVideos: 1, usages: ["camera_motion"] } },
      },
    } as GenerationInputRequest;
    expect(codes(await prepare(h, unsupportedUsage))).toContain("MOTION_USAGE_UNSUPPORTED");
    // keyframeIds make no sense for whole-video delivery.
    expect(codes(await prepare(h, withMotion(f.request, { keyframeIds: ["kf-start"] })))).toContain(
      "MOTION_DELIVERY_AMBIGUOUS",
    );
    // Capability objects must be well formed (no zero-video capability).
    expect(
      codes(await prepare(h, {
        ...f.request,
        capabilities: { ...f.request.capabilities, motion: { video: { maxVideos: 0, usages: ["camera_motion"] } } },
      })),
    ).toContain("TARGET_CAPABILITIES_REQUIRED");
  });

  it("P03 keyframe degrade is an explicit choice: exact ids, requested usage covered, budget counted, nothing dropped", async () => {
    const { h, f } = await setup();
    // 1 identity image + 3 keyframes = 4 images.
    const roomy = { ...f.request, capabilities: { ...f.request.capabilities, maxImages: 4 } };
    const degraded = withMotion(roomy, {
      delivery: "keyframes",
      keyframeIds: ["kf-start", "kf-mid", "kf-end"],
    });
    const ok = await prepare(h, degraded);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.packet?.motion).toMatchObject({
      delivery: "keyframes",
      keyframes: [
        { id: "kf-start", asset: "mo-kf-start", momentFrame: 0, purpose: "blocking", sha256: await sha(h, "mo-kf-start") },
        { id: "kf-mid", asset: "mo-kf-mid", momentFrame: 48, purpose: "camera_motion", sha256: await sha(h, "mo-kf-mid") },
        { id: "kf-end", asset: "mo-kf-end", momentFrame: 95, purpose: "action_timing", sha256: await sha(h, "mo-kf-end") },
      ],
    });
    expect(ok.packet?.motion).not.toHaveProperty("video");
    // Listing order in the request does not change the resolved (momentFrame) order.
    const shuffled = await prepare(h, withMotion(roomy, { delivery: "keyframes", keyframeIds: ["kf-end", "kf-start", "kf-mid"] }));
    expect(shuffled.packet?.motion?.keyframes?.map((k) => k.id)).toEqual(["kf-start", "kf-mid", "kf-end"]);
    // A degrade must name its keyframes.
    expect(codes(await prepare(h, withMotion(f.request, { delivery: "keyframes" })))).toContain("MOTION_KEYFRAMES_REQUIRED");
    expect(codes(await prepare(h, withMotion(f.request, { delivery: "keyframes", keyframeIds: ["ghost"] })))).toContain("MOTION_KEYFRAMES_REQUIRED");
    expect(codes(await prepare(h, withMotion(f.request, { delivery: "keyframes", keyframeIds: ["kf-start", "kf-start", "kf-mid", "kf-end"] })))).toContain("MOTION_KEYFRAMES_REQUIRED");
    // A requested usage with no selected keyframe would be silently lost.
    const lossy = await prepare(h, withMotion(f.request, { delivery: "keyframes", keyframeIds: ["kf-start"] }));
    expect(lossy.ready).toBe(false);
    expect(lossy.diagnostics.filter((d) => d.code === "MOTION_KEYFRAMES_REQUIRED").map((d) => d.message).join(" ")).toMatch(/camera_motion/);
    // ...unless the request is narrowed on purpose.
    const narrowed = await prepare(h, withMotion(f.request, { delivery: "keyframes", keyframeIds: ["kf-start"], usage: ["blocking"] }));
    expect(narrowed.ready).toBe(true);
    expect(narrowed.packet?.motion?.usage).toEqual(["blocking"]);
    // A keyframe serving an unrequested purpose is refused rather than slipped in.
    expect(
      codes(await prepare(h, withMotion(f.request, { delivery: "keyframes", keyframeIds: ["kf-start", "kf-mid"], usage: ["blocking"] }))),
    ).toContain("MOTION_USAGE_UNSUPPORTED");
    // Keyframes are images: they consume the verified image budget, never truncated.
    const overBudget = await prepare(h, {
      ...degraded,
      capabilities: { ...degraded.capabilities, maxImages: 3 },
    });
    expect(overBudget.ready).toBe(false);
    expect(codes(overBudget)).toContain("REFERENCE_BUDGET_EXCEEDED");
    expect((await prepare(h, { ...degraded, capabilities: { ...degraded.capabilities, maxImages: 4 } })).ready).toBe(true);
    // Keyframe capability must be stated too.
    expect(
      codes(await prepare(h, {
        ...degraded,
        capabilities: { ...degraded.capabilities, motion: { video: { maxVideos: 1, usages: ["camera_motion", "blocking", "action_timing"] } } },
      })),
    ).toContain("MOTION_KEYFRAME_CAPABILITY_REQUIRED");
    expect(
      codes(await prepare(h, {
        ...degraded,
        capabilities: { ...degraded.capabilities, motion: { keyframes: { usages: ["blocking"] } } },
      })),
    ).toContain("MOTION_USAGE_UNSUPPORTED");
  });

  it("P04 usage must be declared by the document and requested explicitly", async () => {
    const { h, f } = await setup();
    expect(codes(await prepare(h, withMotion(f.request, { usage: ["framing"] })))).toContain("MOTION_USAGE_UNSUPPORTED");
    expect(codes(await prepare(h, withMotion(f.request, { usage: ["blocking", "blocking"] })))).toContain("REFERENCE_USAGE_AMBIGUOUS");
    expect(codes(await prepare(h, withMotion(f.request, { usage: [] })))).toContain("TARGET_CAPABILITIES_REQUIRED");
    const narrowed = await prepare(h, withMotion(f.request, { usage: ["action_timing", "camera_motion"] }));
    expect(narrowed.packet?.motion?.usage).toEqual(["camera_motion", "action_timing"]);
  });

  it("P05 only an approved, pinned, unrejected revision can be prepared; motion can never be an identity or first/last frame", async () => {
    const { h, f } = await setup();
    // The motion block cannot sneak in a first/last frame either: keyframes keep purpose, packet inputs stay identity-only.
    const kf = await prepare(h, withMotion({ ...f.request, capabilities: { ...f.request.capabilities, maxImages: 4 } }, { delivery: "keyframes", keyframeIds: ["kf-start", "kf-mid", "kf-end"] }));
    expect(kf.ready).toBe(true);
    expect(kf.packet?.inputs.every((i) => i.role !== "first_frame" && i.role !== "last_frame")).toBe(true);
    // Candidate revision (head after an edit) is not eligible even if someone pins it.
    const head = await h.writerClient.getAuthoringDocument(projectId, "spell-motion");
    const edited = { ...(head.document as object), title: "edited" };
    const candidate = await h.writerClient.putAuthoringDocument({
      projectId,
      document: edited as never,
      baseRevision: head.revision,
      operationId: "edit",
    });
    expect(candidate.status).toBe("candidate");
    expect(codes(await prepare(h, withMotion(f.request, { reference: { id: "spell-motion", revision: candidate.revision } })))).toEqual(
      expect.arrayContaining(["REFERENCE_SCOPE_MISMATCH"]),
    );
    await expect(
      h.writerClient.patchComposition({
        projectId,
        compositionId: "main",
        baseRevision: 2,
        operationId: "pin-candidate",
        operations: [
          {
            op: "set_authoring",
            authoring: {
              policyVersion: AUTHORING_POLICY_VERSION,
              materials: [
                ...f.document.authoring!.materials,
                { id: "spell-motion", revision: candidate.revision },
              ],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    // Unknown revision is not pinned either.
    expect(codes(await prepare(h, withMotion(f.request, { reference: { id: "spell-motion", revision: 99 } })))).toContain("REFERENCE_SCOPE_MISMATCH");
    expect(codes(await prepare(h, withMotion(f.request, { reference: { id: "bridge", revision: 3 } })))).toContain("REFERENCE_SCOPE_MISMATCH");
    // A later explicit rejection removes production eligibility; a pending edit cannot restore it.
    const rejected = await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: "spell-motion",
      baseRevision: candidate.revision,
      operationId: "reject",
      targets: ["$document"],
      review: {
        method: "human",
        reviewer: "x",
        decision: "rejected",
        evidence: "camera path wrong",
        checks: { timing_verified: "fail" },
      },
    });
    expect(codes(await prepare(h, f.request))).toContain("REFERENCE_REVIEW_REQUIRED");
    await h.writerClient.putAuthoringDocument({
      projectId,
      document: edited as never,
      baseRevision: rejected.revision,
      operationId: "edit-again",
    });
    expect(codes(await prepare(h, f.request))).toContain("REFERENCE_REVIEW_REQUIRED");
    // Purpose isolation at the request level.
    const motionPin = { id: "spell-motion", revision: f.motion.revision };
    const asView = await prepare(h, {
      ...f.request,
      motion: undefined,
      inputs: [{ source: { pack: motionPin, viewId: "kf-start" }, role: "first_frame" }],
    });
    expect(asView.ready).toBe(false);
    expect(codes(asView)).toContain("REFERENCE_USAGE_AMBIGUOUS");
    const asPanel = await prepare(h, {
      ...f.request,
      motion: undefined,
      inputs: [{ sequence: motionPin, panelId: "kf-start", role: "first_frame" }],
    });
    expect(asPanel.ready).toBe(false);
    expect(codes(asPanel)).toContain("REFERENCE_USAGE_AMBIGUOUS");
    expect(REQUIRED_REVIEW_CHECKS.motion_reference).toContain("whitebox_only");
  });

  it("P06 composition, subject and environment drift from the fixed baseline reject preparation", async () => {
    const { h, f } = await setup();
    const shot = f.document.shots.spell;
    const patch = (operationId: string, baseRevision: number, operations: Parameters<typeof h.writerClient.patchComposition>[0]["operations"]) =>
      h.writerClient.patchComposition({ projectId, compositionId: "main", baseRevision, operationId, operations });
    expect((await prepare(h, f.request)).ready).toBe(true);

    // (1) Production results on the shot (candidates, selected output) are NOT drift: regeneration stays possible.
    await patch("attach", 2, [
      { op: "attach_shot_candidate", shotId: "spell", mediaKind: "videos", candidate: { asset: "mo-video" } },
      { op: "select_shot_output", shotId: "spell", mediaKind: "video", assetId: "mo-video" },
    ]);
    expect((await prepare(h, { ...f.request, compositionRevision: 3 })).ready).toBe(true);

    // (2) Shot duration drift.
    await patch("duration", 3, [{ op: "update_shot_fields", shotId: "spell", durationFrames: 150 }]);
    const duration = await prepare(h, { ...f.request, compositionRevision: 4 });
    expect(duration.ready).toBe(false);
    expect(codes(duration)).toContain("MOTION_BASELINE_DRIFT");
    // The older composition revision is still preparable: history is not rewritten.
    expect((await prepare(h, f.request)).ready).toBe(true);
    await patch("restore-duration", 4, [{ op: "update_shot_fields", shotId: "spell", durationFrames: 120 }]);
    expect((await prepare(h, { ...f.request, compositionRevision: 5 })).ready).toBe(true);

    // (3) Subject drift: a participant removed from the shot.
    await patch("drop-boat", 5, [
      {
        op: "upsert_shot",
        shotId: "spell",
        shot: { ...shot, subjects: shot.subjects.filter((s) => s.subjectId !== "boat") },
      },
    ]);
    expect(codes(await prepare(h, { ...f.request, compositionRevision: 6 }))).toContain("MOTION_BASELINE_DRIFT");

    // (4) Environment drift: the composition re-pins a different revision of the same scene.
    const scene = await h.writerClient.getAuthoringDocument(projectId, "bridge");
    const sceneDoc = scene.document;
    const put = await h.writerClient.putAuthoringDocument({ projectId, document: sceneDoc, baseRevision: scene.revision, operationId: "scene-v2" });
    const reviewed = await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: "bridge",
      baseRevision: put.revision,
      operationId: "scene-v2-review",
      targets: ["$document"],
      review: {
        method: "human",
        reviewer: "x",
        decision: "accepted",
        evidence: "scene inspected",
        checks: Object.fromEntries(REQUIRED_REVIEW_CHECKS.scene.map((c) => [c, "pass"])),
      },
    });
    const approvedScene = await h.writerClient.approveAuthoringDocument({
      projectId,
      id: "bridge",
      baseRevision: reviewed.revision,
      operationId: "scene-v2-approve",
    });
    await patch("restore-boat", 6, [{ op: "upsert_shot", shotId: "spell", shot }]);
    expect((await prepare(h, { ...f.request, compositionRevision: 7 })).ready).toBe(true);
    await patch("repin-scene", 7, [
      {
        op: "set_authoring",
        authoring: {
          policyVersion: AUTHORING_POLICY_VERSION,
          materials: [
            ...(await h.writerClient.getComposition(projectId, "main")).revisionRecord.document.authoring!.materials.filter((m) => m.id !== "bridge"),
            { id: "bridge", revision: approvedScene.revision },
          ],
        },
      },
    ]);
    const environment = await prepare(h, { ...f.request, compositionRevision: 8 });
    expect(environment.ready).toBe(false);
    expect(codes(environment)).toContain("MOTION_BASELINE_DRIFT");
    expect(environment.diagnostics.find((d) => d.code === "MOTION_BASELINE_DRIFT")?.message).toMatch(/bridge/);
  });

  it("P06b design intent (description, prompts, dependsOn) is part of the baseline; production results are not", async () => {
    const { h, f } = await setup();
    const shot = f.document.shots.spell;
    let head = 2;
    const patch = async (operationId: string, operations: Parameters<typeof h.writerClient.patchComposition>[0]["operations"]) => {
      await h.writerClient.patchComposition({ projectId, compositionId: "main", baseRevision: head, operationId, operations });
      head += 1;
    };
    const status = async () => prepare(h, { ...f.request, compositionRevision: head });
    const drift = async (what: RegExp) => {
      const result = await status();
      expect(result.ready).toBe(false);
      expect(result.packet).toBeUndefined();
      expect(result.diagnostics.find((d) => d.code === "MOTION_BASELINE_DRIFT")?.message).toMatch(what);
    };
    expect((await status()).ready).toBe(true);

    // Changed action text means the white model may no longer describe the shot.
    await patch("description", [{ op: "update_shot_fields", shotId: "spell", description: "苏苇转身向东，不再施法" }]);
    await drift(/description/);
    await patch("description-restored", [{ op: "upsert_shot", shotId: "spell", shot }]);
    expect((await status()).ready).toBe(true);

    await patch("prompts", [{ op: "update_shot_fields", shotId: "spell", prompts: { video: "镜头快速横移" } }]);
    await drift(/prompts/);
    await patch("prompts-restored", [{ op: "upsert_shot", shotId: "spell", shot }]);
    expect((await status()).ready).toBe(true);

    await patch("depends", [{ op: "update_shot_fields", shotId: "spell", dependsOn: [{ shotId: "boat", kind: "continuity" }] }]);
    await drift(/dependsOn/);
    await patch("depends-restored", [{ op: "upsert_shot", shotId: "spell", shot }]);
    expect((await status()).ready).toBe(true);

    // Results do not count, even several of them on top of unchanged design intent.
    await patch("results", [
      { op: "attach_shot_candidate", shotId: "spell", mediaKind: "videos", candidate: { asset: "mo-video" } },
      { op: "attach_shot_candidate", shotId: "spell", mediaKind: "images", candidate: { asset: "panel-one" } },
      { op: "select_shot_output", shotId: "spell", mediaKind: "video", assetId: "mo-video" },
    ]);
    const kept = await status();
    expect(kept.ready, JSON.stringify(kept.diagnostics)).toBe(true);
  });

  it("P07 composition format drift and wrong shot/composition requests are rejected", async () => {
    const { h, f } = await setup();
    await h.domain.store.runInTransaction("format-drift-fixture", (draft) => {
      const stored = draft.compositions[JSON.stringify([projectId, "main"])];
      stored.revisions[2].document.format = { width: 1080, height: 1920, fps: 30 };
    });
    const drift = await prepare(h, f.request);
    expect(codes(drift)).toContain("MOTION_BASELINE_DRIFT");
    expect(drift.diagnostics.find((d) => d.code === "MOTION_BASELINE_DRIFT")?.message).toMatch(/format/);
    const { h: h2, f: f2 } = await setup();
    // Another shot of the same composition: the reference is fixed to shot `spell`.
    const other = await prepare(h2, { ...f2.request, shotId: "boat" });
    expect(other.ready).toBe(false);
    expect(codes(other)).toContain("MOTION_BASELINE_DRIFT");
    // Unknown composition revisions never resolve.
    expect(codes(await prepare(h2, { ...f2.request, compositionRevision: 99 }))).toContain("DEPENDENCY_ERROR");
  });

  it("P08 nonmember and unauthenticated callers cannot prepare", async () => {
    const { h, f } = await setup();
    await expect(h.outsiderClient.prepareGenerationInputs(projectId, f.request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.anonymousClient.prepareGenerationInputs(projectId, f.request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
