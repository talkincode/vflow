import { describe, expect, it } from "vitest";
import { handleMcpJsonRpc } from "@video-compose/api";
import {
  AUTHORING_POLICY_VERSION,
  AUTHORING_PROMPTS,
  AUTHORING_RULES,
  AUTHORING_VERSION,
  MATERIAL_DOCUMENT_JSON_SCHEMA,
  REQUIRED_REVIEW_CHECKS,
  renderAuthoringPrompt,
  type ReferencePack,
  type StoryboardSequence,
  type MaterialDocument,
} from "@video-compose/protocol";
import { createTestHarness } from "./helpers.ts";
import {
  referenceAssets,
  referencePack,
  referenceProject as projectId,
  seedReferences,
} from "./reference-fixture.ts";
const actor = { actorId: "alice@talkincode.net", actorKind: "human" as const };
const invoke = async (
  domain: ReturnType<typeof createTestHarness>["domain"],
  method: string,
  params = {},
  who = actor,
) =>
  handleMcpJsonRpc(domain, who, { jsonrpc: "2.0", id: "test", method, params });
const diagnostics = (value: { diagnostics: Array<{ code: string }> }) =>
  value.diagnostics.map((d) => d.code);

describe("E2E 14 — reference authoring rules, exact inputs and portability", () => {
  it("A01/A02/A18 exposes versioned guidance through lifecycle, prompts, resources and tools; old writes cannot skip context", async () => {
    const h = createTestHarness();
    await h.writerClient.createProject({ id: projectId, name: "严格制作" });
    await expect(
      h.writerClient.callMcpTool("project_create", {
        id: "invalid-mode",
        name: "Invalid",
        authoringMode: "skip-rules",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const init = await invoke(h.domain, "initialize", {
      protocolVersion: "unsupported-future",
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: expect.stringContaining("authoring_workflow_get"),
    });
    expect((await invoke(h.domain, "prompts/list")).result).toMatchObject({
      prompts: AUTHORING_PROMPTS,
    });
    expect((await invoke(h.domain, "resources/list")).result).toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ uri: "video-compose://authoring/rules/zh" }),
      ]),
    });
    expect(
      (
        await invoke(h.domain, "resources/read", {
          uri: `video-compose://projects/${projectId}/authoring/workflow`,
        })
      ).result,
    ).toBeDefined();
    expect(
      (
        await invoke(h.domain, "prompts/get", {
          name: "unknown",
          arguments: { projectId, brief: "a" },
        })
      ).error?.code,
    ).toBe(-32602);
    expect(
      (
        await invoke(h.domain, "prompts/get", {
          name: "create_character_face_reference",
          arguments: { projectId },
        })
      ).error?.code,
    ).toBe(-32602);
    const prompt = await invoke(h.domain, "prompts/get", {
      name: "create_storyboard_sequence",
      arguments: { projectId, brief: "施法特写" },
    });
    expect(JSON.stringify(prompt)).toContain("No labels");
    expect(MATERIAL_DOCUMENT_JSON_SCHEMA).not.toHaveProperty("$ref");
    for (const p of AUTHORING_PROMPTS)
      expect(
        renderAuthoringPrompt(p.name, {
          projectId,
          brief: "test",
          language: "en",
        }),
      ).toContain(AUTHORING_RULES.en);
    expect(AUTHORING_RULES.zh).toContain("面部板和身体/服装板分文件");
    expect(AUTHORING_RULES.en).toContain("No captions");
    expect(AUTHORING_RULES.en).toContain("Multi-prop grids");
    expect(AUTHORING_RULES.en).toContain("weather/time variants");
    const scene: MaterialDocument = {
      schemaVersion: AUTHORING_VERSION,
      kind: "scene",
      id: "bridge",
      title: "旧桥",
      geometry: "固定三拱",
      anchors: { rail: { description: "石栏", supportSurface: true } },
      environmentVariants: {
        night: { time: "夜", weather: "雾", state: "正常水位" },
      },
    };
    await expect(
      h.writerClient.callMcpTool("authoring_document_put", {
        projectId,
        document: scene,
        baseRevision: 0,
        operationId: "put",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTEXT_REQUIRED" });
    const workflow = await h.writerClient.callMcpTool<{
      workflowContext: unknown;
    }>("authoring_workflow_get", { projectId });
    const args = {
      projectId,
      document: scene,
      baseRevision: 0,
      operationId: "put",
      workflowContext: workflow.workflowContext,
    };
    expect(
      await h.writerClient.callMcpTool("authoring_document_put", args),
    ).toMatchObject({ revision: 1, status: "candidate" });
    expect(
      await h.writerClient.getAuthoringDocument(projectId, "bridge"),
    ).toMatchObject({ revision: 1 });
    await expect(
      h.writerClient.callMcpTool("authoring_document_put", {
        ...args,
        workflowContext: {
          projectId,
          policyVersion: AUTHORING_POLICY_VERSION,
          policyRevision: 99,
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_VERSION_MISMATCH" });
    await expect(
      h.writerClient.callMcpTool("composition_create", {
        projectId,
        document: { apiVersion: "video-compose/v1" },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTEXT_REQUIRED" });
  });

  it("A03/A04/A06/A10/A11/A12/A14/A15 creates separate canonical packs, blocks wrong inputs, and records actual-use differences atomically", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    const prepared = await h.writerClient.prepareGenerationInputs(
      projectId,
      f.request,
    );
    expect(prepared.ready).toBe(true);
    const packet = prepared.packet!;
    expect(packet.inputs).toHaveLength(1);
    expect(packet.inputs[0]).toMatchObject({
      asset: "face-front",
      owner: f.suwei,
      role: "face_identity",
    });
    expect(
      (await h.writerClient.prepareGenerationInputs(projectId, f.request))
        .packet?.hash,
    ).toBe(packet.hash);
    await h.readerClient.getAuthoringWorkflow(projectId);
    expect(
      (await h.readerClient.prepareGenerationInputs(projectId, f.request))
        .packet,
    ).toEqual(packet);
    await expect(
      h.readerClient.approveAuthoringDocument({
        projectId,
        id: f.face.document.id,
        baseRevision: 3,
        operationId: "reader",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.outsiderClient.getAuthoringDocument(projectId, f.face.document.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (
        await invoke(
          h.domain,
          "resources/read",
          { uri: `video-compose://projects/${projectId}/authoring/workflow` },
          { actorId: "outsider", actorKind: "human" },
        )
      ).error?.data,
    ).toMatchObject({ code: "FORBIDDEN" });
    const rawBoard = {
      schemaVersion: AUTHORING_VERSION,
      id: "archive",
      title: "混合概念板",
      kind: "reference_pack",
      category: "moodboard",
      board: {
        asset: "raw-board",
        rows: 1,
        columns: 1,
        readingOrder: "row-major",
      },
      views: [],
      sources: [],
      conflicts: [],
    } as ReferencePack;
    await h.writerClient.putAuthoringDocument({
      projectId,
      document: rawBoard,
      baseRevision: 0,
      operationId: "archive",
    });
    await expect(
      h.writerClient.approveAuthoringDocument({
        projectId,
        id: "archive",
        baseRevision: 1,
        operationId: "archive-approve",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    const badOwner = referencePack("mixed", "character_face", f.suwei, "face");
    badOwner.views[1].owner = f.boat;
    await expect(
      h.writerClient.putAuthoringDocument({
        projectId,
        document: badOwner,
        baseRevision: 0,
        operationId: "mixed",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
    expect(
      diagnostics(
        await h.writerClient.prepareGenerationInputs(projectId, {
          ...f.request,
          inputs: [{ ...f.request.inputs[0], wholeBoard: true }],
        }),
      ),
    ).toContain("GRID_CELL_REQUIRED");
    expect(
      diagnostics(
        await h.writerClient.prepareGenerationInputs(projectId, {
          ...f.request,
          capabilities: { ...f.request.capabilities, maxImages: 1 },
          inputs: [
            f.request.inputs[0],
            {
              source: {
                pack: { id: f.body.document.id, revision: 3 },
                viewId: "front",
              },
              role: "wardrobe",
            },
          ],
        }),
      ),
    ).toContain("REFERENCE_BUDGET_EXCEEDED");
    expect(
      diagnostics(
        await h.writerClient.prepareGenerationInputs(projectId, {
          ...f.request,
          capabilities: {},
        }),
      ),
    ).toContain("TARGET_CAPABILITIES_REQUIRED");
    expect(
      diagnostics(
        await h.writerClient.prepareGenerationInputs(projectId, {
          ...f.request,
          inputs: [{ ...f.request.inputs[0], role: "first_frame" }],
        }),
      ),
    ).toContain("REFERENCE_USAGE_AMBIGUOUS");
    const wrongEnvironment = referencePack(
      "bad-env",
      "scene_views",
      { kind: "scene", id: "bridge", revision: 3, variant: "night" },
      "scene",
    );
    wrongEnvironment.views[1].environmentVariant = "dawn";
    await expect(
      h.writerClient.putAuthoringDocument({
        projectId,
        document: wrongEnvironment,
        baseRevision: 0,
        operationId: "bad-env",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
    const args = {
      projectId,
      id: "actual-one",
      operationId: "evidence-one",
      packet,
      actualInputs: [
        {
          asset: "face-side",
          sha256: packet.inputs[0].sha256,
          role: "face_identity" as const,
        },
      ],
      outputs: ["panel-one"],
      method: "request_capture" as const,
      evidence:
        "External request capture shows the side view was used instead of front.",
    };
    h.domain.store.injectFaultOnce("authoringEvidence");
    await expect(
      h.writerClient.recordGenerationEvidence(args),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await h.writerClient.listGenerationEvidence(projectId)).toHaveLength(
      0,
    );
    const report = await h.writerClient.recordGenerationEvidence(args);
    expect(report.matchesPlan).toBe(false);
    expect(await h.writerClient.recordGenerationEvidence(args)).toEqual(report);
    await expect(
      h.writerClient.recordGenerationEvidence({ ...args, evidence: "changed" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.writerClient.recordGenerationEvidence({
        ...args,
        id: "forged",
        packet: { ...packet, hash: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.readerClient.recordGenerationEvidence({ ...args, id: "reader" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.writerClient.deleteAsset(projectId, "face-front"),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
    const staged = referencePack("recovery", "character_body", f.suwei, "body");
    h.domain.store.injectFaultOnce("authoringWrite");
    const put = {
      projectId,
      document: staged,
      baseRevision: 0,
      operationId: "recover",
    };
    await expect(
      h.writerClient.putAuthoringDocument(put),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      h.writerClient.getAuthoringDocument(projectId, "recovery"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const revision = await h.writerClient.putAuthoringDocument(put);
    expect(await h.writerClient.putAuthoringDocument(put)).toEqual(revision);
    await expect(
      h.writerClient.putAuthoringDocument({ ...put, operationId: "conflict" }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      h.writerClient.approveAuthoringDocument({
        projectId,
        id: "recovery",
        baseRevision: 1,
        operationId: "unknown",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
  });

  it("A07/A08/A13/A16 builds text-free sequences from pinned sources; v2 export/import keeps the baseline and rejects lossy v1", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    const seq: StoryboardSequence = {
      schemaVersion: AUTHORING_VERSION,
      id: "spell-sequence",
      title: "施法序列",
      kind: "storyboard_sequence",
      compositionId: "main",
      compositionRevision: 1,
      captionPolicy: "forbidden",
      panels: ["panel-one", "panel-two"].map((asset, i) => ({
        id: `panel-${i}`,
        order: i,
        momentFrame: i * 90,
        shotId: "spell",
        asset,
        scene: { id: "bridge", revision: 3 },
        environmentVariant: "night",
        cameraView: i ? "hand close-up from south" : "face close-up from south",
        sources: [
          { pack: { id: "suwei-face", revision: 3 }, viewId: "front" },
          { pack: { id: "bridge-night", revision: 3 }, viewId: "front" },
          { pack: { id: "boat-views", revision: 3 }, viewId: "front" },
        ],
        entities: [
          {
            subject: f.suwei,
            visibility: "visible",
            bounds: [0.1, 0.1, 0.5, 0.8],
            facing: "east",
            supportAnchor: "stone_rail",
            state: i ? "手势牵引水势" : "伏在石栏抬手",
            occlusion: "石栏遮挡腰部",
          },
          {
            subject: f.boat,
            visibility: "hidden",
            bounds: [0, 0, 0, 0],
            facing: "east",
            state: "船在特写画外，沿河向东",
            occlusion: "outside the frame",
          },
        ],
        transition: i ? "手势延续，水流向东" : "苏苇出现于石栏",
        textPolicy: "forbidden",
      })),
    };
    let rev = await h.writerClient.putAuthoringDocument({
      projectId,
      document: seq,
      baseRevision: 0,
      operationId: "seq-put",
    });
    const exception = structuredClone(seq);
    exception.panels[0].textPolicy = "diegetic_exception";
    expect(
      (await h.writerClient.validateAuthoringDocument(projectId, exception))
        .diagnostics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "STORYBOARD_TEXT_DETECTED" }),
      ]),
    );
    exception.panels[0].textException =
      "Only the pre-existing engraved bridge name is allowed; no captions or explanatory labels.";
    expect(
      (
        await h.writerClient.validateAuthoringDocument(projectId, exception)
      ).diagnostics.some((d) => d.code === "STORYBOARD_TEXT_DETECTED"),
    ).toBe(false);
    expect(
      diagnostics(
        await h.writerClient.validateAuthoringDocument(projectId, rev.document),
      ),
    ).toContain("REFERENCE_REVIEW_REQUIRED");
    await expect(
      h.writerClient.reviewAuthoringDocument({
        projectId,
        id: seq.id,
        baseRevision: 1,
        operationId: "ocr-fail",
        targets: ["panel-0"],
        review: {
          decision: "accepted",
          reviewer: "x",
          method: "human",
          evidence: "有说明文字",
          checks: {
            identity_consistent: "pass",
            spatial_continuity: "pass",
            state_consistent: "pass",
            text_policy: "fail",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    rev = await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: seq.id,
      baseRevision: 1,
      operationId: "review-good",
      targets: seq.panels.map((p) => p.id),
      review: {
        decision: "accepted",
        method: "human",
        reviewer: "x",
        evidence:
          "Independent frames checked: no captions, support surface and eastward motion consistent.",
        checks: Object.fromEntries(
          REQUIRED_REVIEW_CHECKS.storyboard_sequence.map((c) => [c, "pass"]),
        ),
      },
    });
    rev = await h.writerClient.approveAuthoringDocument({
      projectId,
      id: seq.id,
      baseRevision: rev.revision,
      operationId: "seq-approve",
    });
    await h.writerClient.patchComposition({
      projectId,
      compositionId: "main",
      baseRevision: 1,
      operationId: "pin-sequence",
      operations: [
        {
          op: "set_authoring",
          authoring: {
            policyVersion: AUTHORING_POLICY_VERSION,
            materials: [
              ...f.document.authoring!.materials,
              { id: seq.id, revision: rev.revision },
            ],
          },
        },
      ],
    });
    const request = {
      ...f.request,
      compositionRevision: 2,
      inputs: [
        {
          sequence: { id: seq.id, revision: 3 },
          panelId: "panel-0",
          role: "first_frame",
        },
      ],
    };
    expect(
      (await h.writerClient.prepareGenerationInputs(projectId, request)).packet
        ?.inputs[0].asset,
    ).toBe("panel-one");
    const exported = await h.writerClient.exportCompositionBundle({
      projectId,
      compositionId: "main",
      format: "json",
    });
    expect(exported.bundle.apiVersion).toBe("video-compose/v2");
    expect(exported.bundle.dependencies.compositionBaselines).toHaveLength(1);
    await expect(
      h.writerClient.exportCompositionBundle({
        projectId,
        compositionId: "main",
        format: "json",
        targetVersion: "video-compose/v1",
      }),
    ).rejects.toMatchObject({ code: "UNREPRESENTABLE_IN_V1" });
    await h.writerClient.createProject({ id: "restored", name: "恢复" });
    await h.writerClient.getAuthoringWorkflow("restored");
    await referenceAssets(h.writerClient, "restored");
    const imported = await h.writerClient.importCompositionBundle({
      projectId: "restored",
      payload: exported.serialized,
      format: "json",
      operationId: "portable-once",
      baseRevision: 0,
    });
    expect(
      await h.writerClient.importCompositionBundle({
        projectId: "restored",
        payload: exported.serialized,
        format: "json",
        operationId: "portable-once",
        baseRevision: 0,
      }),
    ).toEqual(imported);
    await expect(
      h.writerClient.importCompositionBundle({
        projectId: "restored",
        payload: exported.serialized,
        format: "json",
        operationId: "new-import-needs-base",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(imported.document.shots).toEqual(f.document.shots);
    expect(imported.document.sequence).toEqual(f.document.sequence);
    expect(
      (
        await h.writerClient.prepareGenerationInputs("restored", {
          ...request,
          compositionRevision: imported.revision,
        })
      ).ready,
    ).toBe(true);
    // A later explicit rejection invalidates production selection but leaves pinned historical bytes and documents intact.
    await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: "suwei-face",
      baseRevision: 3,
      operationId: "reject-upstream",
      targets: ["front"],
      review: {
        decision: "rejected",
        method: "human",
        reviewer: "x",
        evidence: "Review correction: the identity is inconsistent.",
        checks: { identity_consistent: "fail" },
      },
    });
    expect(
      diagnostics(
        await h.writerClient.prepareGenerationInputs(projectId, request),
      ),
    ).toContain("REFERENCE_REVIEW_REQUIRED");
    const rejected = await h.writerClient.getAuthoringDocument(
      projectId,
      "suwei-face",
    );
    const pending = structuredClone(rejected.document) as ReferencePack;
    pending.views[0].view = "front pending correction";
    await h.writerClient.putAuthoringDocument({
      projectId,
      document: pending,
      baseRevision: rejected.revision,
      operationId: "pending-cannot-unreject",
    });
    expect(
      diagnostics(
        await h.writerClient.prepareGenerationInputs(projectId, request),
      ),
    ).toContain("REFERENCE_REVIEW_REQUIRED");
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, "suwei-face", 3))
        .status,
    ).toBe("approved");
    expect(
      (await h.writerClient.getComposition(projectId, "main")).headRevision,
    ).toBe(2);
  });
});
