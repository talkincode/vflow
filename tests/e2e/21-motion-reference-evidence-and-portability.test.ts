import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  type GenerationInputPacket,
  type MaterialRevision,
  type MotionReference,
} from "@vflow/protocol";
import { createTestHarness } from "./helpers.ts";
import {
  motionAssets,
  motionProject as projectId,
  seedMotion,
} from "./motion-fixture.ts";
import { referenceAssets } from "./reference-fixture.ts";

async function setup() {
  const h = createTestHarness();
  const f = await seedMotion(h.writerClient);
  const sha = async (id: string) =>
    (await h.writerClient.listAssets(projectId)).find((a) => a.id === id)!.sha256;
  return { h, f, sha };
}
const prepared = async (
  h: Awaited<ReturnType<typeof setup>>["h"],
  request: unknown,
): Promise<GenerationInputPacket> => {
  const result = await h.writerClient.prepareGenerationInputs(projectId, request);
  if (!result.packet) throw new Error(JSON.stringify(result.diagnostics));
  return result.packet;
};

describe("E2E 21 — motion evidence, retention and portable export/import", () => {
  it("E01 records the motion actually delivered and compares it with the packet, alongside the image inputs", async () => {
    const { h, f, sha } = await setup();
    const packet = await prepared(h, f.request);
    const base = {
      projectId,
      packet,
      actualInputs: packet.inputs.map(({ asset, sha256, role }) => ({ asset, sha256, role })),
      outputs: ["panel-one"],
      method: "agent_reported" as const,
      evidence: "External run log: reference video and one identity image were attached.",
    };
    const video = { asset: "mo-video", sha256: await sha("mo-video") };
    const args = { ...base, id: "run-1", operationId: "run-1", actualMotion: { delivery: "video" as const, video } };
    h.domain.store.injectFaultOnce("authoringEvidence");
    await expect(h.writerClient.recordGenerationEvidence(args)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await h.writerClient.listGenerationEvidence(projectId)).toHaveLength(0);
    const report = await h.writerClient.recordGenerationEvidence(args);
    expect(report.matchesPlan).toBe(true);
    expect(report.actualMotion).toEqual({ delivery: "video", video });
    expect(await h.writerClient.recordGenerationEvidence(args)).toEqual(report);
    await expect(
      h.writerClient.recordGenerationEvidence({ ...args, evidence: "changed" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await h.readerClient.listGenerationEvidence(projectId)).toEqual([report]);
    await h.readerClient.getAuthoringWorkflow(projectId);
    await expect(
      h.readerClient.recordGenerationEvidence({ ...args, id: "reader", operationId: "reader" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.outsiderClient.listGenerationEvidence(projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // MCP lists the same evidence.
    expect(await h.writerClient.callMcpTool("generation_evidence_list", { projectId })).toEqual([report]);
  });

  it("E02 any difference between planned and reported motion is visible and never claimed as a match", async () => {
    const { h, f, sha } = await setup();
    const packet = await prepared(h, f.request);
    const images = packet.inputs.map(({ asset, sha256, role }) => ({ asset, sha256, role }));
    const record = (id: string, extra: object, method: "agent_reported" | "manual_unknown" = "agent_reported", p = packet, actualInputs = images) =>
      h.writerClient.recordGenerationEvidence({
        projectId,
        id,
        operationId: id,
        packet: p,
        actualInputs,
        outputs: ["panel-one"],
        method,
        evidence: "reported",
        ...extra,
      } as never);
    const video = { asset: "mo-video", sha256: await sha("mo-video") };
    const kf = { asset: "mo-kf-start", sha256: await sha("mo-kf-start") };
    // Planned video, reported none / keyframes instead / manual unknown.
    expect((await record("none", {})).matchesPlan).toBe(false);
    expect((await record("kf", { actualMotion: { delivery: "keyframes", keyframes: [kf] } })).matchesPlan).toBe(false);
    expect((await record("unknown", { actualMotion: { delivery: "video", video } }, "manual_unknown")).matchesPlan).toBe(false);
    // Images differ while motion matches.
    expect((await record("img", { actualMotion: { delivery: "video", video } }, "agent_reported", packet, [{ ...images[0], asset: "face-side" }])).matchesPlan).toBe(false);
    // Unplanned motion reported against a packet that had none.
    const plain = await prepared(h, { ...f.request, motion: undefined });
    expect((await record("plain-ok", {}, "agent_reported", plain)).matchesPlan).toBe(true);
    expect((await record("plain-motion", { actualMotion: { delivery: "video", video } }, "agent_reported", plain)).matchesPlan).toBe(false);
    // Degraded plan: exact keyframe list in order is a match, fewer is not.
    const roomy = { ...f.request, capabilities: { ...f.request.capabilities, maxImages: 4 } };
    const degraded = await prepared(h, { ...roomy, motion: { ...f.request.motion!, delivery: "keyframes", keyframeIds: ["kf-start", "kf-mid", "kf-end"] } });
    const all = await Promise.all(["mo-kf-start", "mo-kf-mid", "mo-kf-end"].map(async (asset) => ({ asset, sha256: await sha(asset) })));
    expect((await record("deg-ok", { actualMotion: { delivery: "keyframes", keyframes: all } }, "agent_reported", degraded)).matchesPlan).toBe(true);
    expect((await record("deg-fewer", { actualMotion: { delivery: "keyframes", keyframes: all.slice(0, 2) } }, "agent_reported", degraded)).matchesPlan).toBe(false);
    expect((await record("deg-order", { actualMotion: { delivery: "keyframes", keyframes: [...all].reverse() } }, "agent_reported", degraded)).matchesPlan).toBe(false);
    expect((await record("deg-video", { actualMotion: { delivery: "video", video } }, "agent_reported", degraded)).matchesPlan).toBe(false);
  });

  it("E03 evidence rejects forged packets, malformed or hash-mismatched motion reports", async () => {
    const { h, f, sha } = await setup();
    const packet = await prepared(h, f.request);
    const images = packet.inputs.map(({ asset, sha256, role }) => ({ asset, sha256, role }));
    const video = { asset: "mo-video", sha256: await sha("mo-video") };
    const attempt = (id: string, extra: object, p: unknown = packet) =>
      h.writerClient.recordGenerationEvidence({
        projectId,
        id,
        operationId: id,
        packet: p,
        actualInputs: images,
        outputs: ["panel-one"],
        method: "agent_reported",
        evidence: "reported",
        ...extra,
      } as never);
    await expect(attempt("wrong-sha", { actualMotion: { delivery: "video", video: { ...video, sha256: "0".repeat(64) } } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(attempt("unknown-asset", { actualMotion: { delivery: "video", video: { asset: "absent", sha256: video.sha256 } } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(attempt("both", { actualMotion: { delivery: "video", video, keyframes: [video] } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(attempt("neither", { actualMotion: { delivery: "keyframes" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(attempt("extra", { actualMotion: { delivery: "video", video, engine: "x" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const forged = structuredClone(packet);
    forged.motion!.video!.sha256 = "1".repeat(64);
    await expect(attempt("forged", { actualMotion: { delivery: "video", video } }, forged)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const swapped = structuredClone(packet);
    swapped.motion!.delivery = "keyframes";
    await expect(attempt("swapped", { actualMotion: { delivery: "video", video } }, swapped)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await h.writerClient.listGenerationEvidence(projectId)).toHaveLength(0);
    // A packet whose motion reference stops being ready can no longer be reported against.
    await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: "spell-motion",
      baseRevision: f.motion.revision,
      operationId: "reject-later",
      targets: ["$document"],
      review: { method: "human", reviewer: "x", decision: "rejected", evidence: "wrong path", checks: { timing_verified: "fail" } },
    });
    await expect(attempt("late", { actualMotion: { delivery: "video", video } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("E04 motion media and archives are retained by their material and by evidence; they cannot be deleted", async () => {
    const { h, f, sha } = await setup();
    for (const asset of ["mo-video", "mo-overview", "mo-kf-start", "mo-source"])
      await expect(h.writerClient.deleteAsset(projectId, asset), asset).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
    await expect(h.readerClient.deleteAsset(projectId, "mo-video")).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An unreferenced sibling is still deletable: retention is per reference, not per prefix.
    await h.writerClient.uploadAsset({ projectId, assetId: "mo-spare", mimeType: "application/zip", bytes: new Uint8Array([5]) });
    await h.writerClient.deleteAsset(projectId, "mo-spare");
    // Even an output recorded only in evidence is retained.
    const packet = await prepared(h, f.request);
    await h.writerClient.recordGenerationEvidence({
      projectId,
      id: "run",
      operationId: "run",
      packet,
      actualInputs: packet.inputs.map(({ asset, sha256, role }) => ({ asset, sha256, role })),
      actualMotion: { delivery: "video", video: { asset: "mo-video", sha256: await sha("mo-video") } },
      outputs: ["panel-two"],
      method: "agent_reported",
      evidence: "run",
    });
    await expect(h.writerClient.deleteAsset(projectId, "panel-two")).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
  });

  it("E05 export carries every motion dependency (document, assets, baseline, subjects) and refuses lossy v1", async () => {
    const { h, f } = await setup();
    const exported = await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" });
    const { bundle } = exported;
    expect(bundle.apiVersion).toBe("vflow/v2");
    const material = bundle.dependencies.materials!.find((m) => m.document.id === "spell-motion")!;
    expect(material).toMatchObject({ status: "approved", revision: f.motion.revision });
    expect(material.document.kind).toBe("motion_reference");
    const doc = material.document as MotionReference;
    const assets = new Map(bundle.dependencies.assets.map((a) => [a.id, a]));
    for (const id of ["mo-video", "mo-overview", "mo-kf-start", "mo-kf-mid", "mo-kf-end", "mo-source"]) {
      expect(assets.get(id), id).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    }
    expect(assets.get("mo-video")).toMatchObject({ mimeType: "video/mp4", durationFrames: 96 });
    expect(assets.get("mo-source")).toMatchObject({ mimeType: "application/zip" });
    expect(bundle.dependencies.compositionBaselines).toEqual([
      expect.objectContaining({ id: "main", revision: 1 }),
    ]);
    expect(bundle.dependencies.subjects.map((s) => `${s.id}@${s.revision}`).sort()).toEqual(["boat@1", "suwei@1"]);
    expect(doc.scene.id).toBe("bridge");
    expect(bundle.dependencies.materials!.some((m) => m.document.id === "bridge")).toBe(true);
    // Unpinned composition revisions do not drag the motion reference along.
    const rev1 = await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json", revision: 1 });
    expect(rev1.bundle.dependencies.materials!.some((m) => m.document.id === "spell-motion")).toBe(false);
    // JSON/YAML round trip preserves semantics.
    const yaml = await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "yaml" });
    expect(YAML.parse(yaml.serialized)).toEqual(JSON.parse(exported.serialized));
    // v1 readers cannot silently lose the motion dependency.
    await expect(
      h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json", targetVersion: "vflow/v1" }),
    ).rejects.toMatchObject({ code: "UNREPRESENTABLE_IN_V1" });
    // Reader may export, outsider may not.
    expect((await h.readerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" })).serialized).toBe(exported.serialized);
    await expect(h.outsiderClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The MCP export returns the identical bundle.
    const viaMcp = await h.writerClient.callMcpTool<{ serialized: string }>("composition_export", { projectId, compositionId: "main", format: "json" });
    expect(viaMcp.serialized).toBe(exported.serialized);
    // Export is deterministic.
    expect((await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" })).serialized).toBe(exported.serialized);
  });

  it("E06 import needs the whole closure: missing media/material/baseline roll back atomically, a complete import prepares identically", async () => {
    const { h, f } = await setup();
    const exported = await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" });
    await h.writerClient.createProject({ id: "restored", name: "恢复" });
    await h.writerClient.getAuthoringWorkflow("restored");
    await referenceAssets(h.writerClient, "restored");
    const importInto = (payload: string, operationId: string) =>
      h.writerClient.importCompositionBundle({ projectId: "restored", payload, format: "json", operationId, baseRevision: 0 });
    const untouched = async () => {
      expect(await h.writerClient.listCompositions("restored")).toHaveLength(0);
      expect((await h.writerClient.listAuthoringDocuments("restored")).map((r) => r.id)).toEqual(["workflow-policy"]);
    };

    // 1. Motion media not uploaded to the target yet.
    await expect(importInto(exported.serialized, "no-media")).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
    await untouched();
    await motionAssets(h.writerClient, "restored");

    // 2. Hash mismatch on the video (same id, different bytes) is an immutability violation.
    const tampered = structuredClone(exported.bundle);
    tampered.dependencies.assets.find((a) => a.id === "mo-video")!.sha256 = "2".repeat(64);
    await expect(importInto(JSON.stringify(tampered), "bad-hash")).rejects.toMatchObject({ code: "IMMUTABILITY_VIOLATION" });
    await untouched();

    // 3. The pinned material dropped from the bundle.
    const noMotion = structuredClone(exported.bundle);
    noMotion.dependencies.materials = noMotion.dependencies.materials!.filter((m) => m.document.id !== "spell-motion");
    await expect(importInto(JSON.stringify(noMotion), "no-material")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await untouched();

    // 4. The fixed baseline dropped: the motion reference cannot be re-validated.
    const noBaseline = structuredClone(exported.bundle);
    noBaseline.dependencies.compositionBaselines = [];
    await expect(importInto(JSON.stringify(noBaseline), "no-baseline")).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    await untouched();

    // 5. A motion revision smuggled in as approved but never reviewed.
    const unreviewed = structuredClone(exported.bundle);
    const entry = unreviewed.dependencies.materials!.find((m) => m.document.id === "spell-motion") as MaterialRevision;
    delete (entry.document as MotionReference).review;
    await expect(importInto(JSON.stringify(unreviewed), "no-review")).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    await untouched();

    // 6. Storage failure mid-import leaves nothing behind; the retry then succeeds.
    h.domain.store.injectFaultOnce("importCompositionBundle");
    await expect(importInto(exported.serialized, "fault")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await untouched();
    const imported = await importInto(exported.serialized, "ok");
    expect(await importInto(exported.serialized, "ok")).toEqual(imported);
    const restoredMotion = await h.writerClient.getAuthoringDocument("restored", "spell-motion", f.motion.revision);
    expect(restoredMotion).toMatchObject({ status: "approved" });
    expect(restoredMotion.document).toEqual(f.motion.document);
    // The restored project produces the same exact motion packet.
    const original = await prepared(h, f.request);
    const restoredRequest = { ...f.request, compositionRevision: imported.revision };
    const restored = (await h.writerClient.prepareGenerationInputs("restored", restoredRequest)).packet!;
    expect(restored.motion).toEqual(original.motion);
    // Restored media is retained as well.
    await expect(h.writerClient.deleteAsset("restored", "mo-source")).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
  });

  it("E07 impact queries show what depends on a pinned scene, motion reference and composition revision", async () => {
    const { h, f } = await setup();
    const impact = await h.writerClient.getAuthoringImpact(projectId, "bridge", f.scene.revision);
    expect(impact.materials.map((m) => m.id)).toEqual(expect.arrayContaining(["bridge", "spell-motion", "bridge-night"]));
    expect(impact.compositions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "main", revision: 2 })]));
    expect(await h.writerClient.callMcpTool("authoring_dependencies_get", { projectId, id: "bridge", revision: f.scene.revision })).toEqual(impact);
    await expect(h.outsiderClient.getAuthoringImpact(projectId, "bridge", f.scene.revision)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("E08 export keeps the motion baseline and every subject it names even after the head composition drifted; the closure round-trips", async () => {
    const { h, f } = await setup();
    const shot = f.document.shots.spell;
    // Head main@3 drops `boat` from the shot: the motion document and its baseline still name it.
    await h.writerClient.patchComposition({
      projectId,
      compositionId: "main",
      baseRevision: 2,
      operationId: "drift-drop-boat",
      operations: [
        { op: "upsert_shot", shotId: "spell", shot: { ...shot, subjects: shot.subjects.filter((s) => s.subjectId !== "boat") } },
      ],
    });
    const { bundle, serialized } = await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" });
    expect(bundle.revision).toBe(3);
    expect(bundle.composition.shots.spell.subjects.map((s) => s.subjectId)).toEqual(["suwei"]);
    const baselines = bundle.dependencies.compositionBaselines!;
    expect(baselines.map((b) => `${b.id}@${b.revision}`)).toEqual(["main@1"]);
    expect(baselines[0].document.shots.spell.subjects.map((s) => s.subjectId)).toEqual(["suwei", "boat"]);
    expect(baselines[0].document.format).toEqual(f.document.format);
    // Subjects come from the motion document and from baseline shots, not only the exported head.
    expect(bundle.dependencies.subjects.map((x) => `${x.id}@${x.revision}`).sort()).toEqual(["boat@1", "suwei@1"]);
    // Consumer-side drift is therefore decidable from the bundle alone.
    const motion = bundle.dependencies.materials!.find((m) => m.document.kind === "motion_reference")!.document as MotionReference;
    const baseShot = baselines.find((b) => b.id === motion.compositionId && b.revision === motion.compositionRevision)!.document.shots[motion.shotId];
    expect(baseShot.durationFrames).toBe(bundle.composition.shots.spell.durationFrames);
    expect(baseShot.subjects.length).not.toBe(bundle.composition.shots.spell.subjects.length);
    // Import into a fresh project reproduces the closure and the server rejects the drifted shot.
    await h.writerClient.createProject({ id: "roundtrip", name: "往返" });
    await h.writerClient.getAuthoringWorkflow("roundtrip");
    await referenceAssets(h.writerClient, "roundtrip");
    await motionAssets(h.writerClient, "roundtrip");
    const imported = await h.writerClient.importCompositionBundle({ projectId: "roundtrip", payload: serialized, format: "json", operationId: "roundtrip", baseRevision: 0 });
    const again = await h.writerClient.exportCompositionBundle({ projectId: "roundtrip", compositionId: "main", format: "json", revision: imported.revision });
    expect(again.bundle.dependencies.compositionBaselines!.map((b) => `${b.id}@${b.revision}`)).toEqual(["main@1"]);
    expect(again.bundle.dependencies.subjects.map((x) => `${x.id}@${x.revision}`).sort()).toEqual(["boat@1", "suwei@1"]);
    const restored = await h.writerClient.prepareGenerationInputs("roundtrip", { ...f.request, compositionRevision: imported.revision });
    expect(restored.ready).toBe(false);
    expect(restored.diagnostics.map((d) => d.code)).toContain("MOTION_BASELINE_DRIFT");
  });
});
