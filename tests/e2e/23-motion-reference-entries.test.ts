import { describe, expect, it } from "vitest";
import {
  AUTHORING_POLICY_VERSION,
  type CompositionDocument,
} from "@vflow/protocol";
import { createTestHarness } from "./helpers.ts";
import {
  motionAssets,
  motionDocument,
  motionProject as projectId,
  seedMotion,
} from "./motion-fixture.ts";
import { seedReferences } from "./reference-fixture.ts";

describe("E2E 23 — every legal entry applies the same motion_reference rules", () => {
  it("N01 patch, proposal, create and MCP composition entries refuse a candidate motion pin; approved pins are accepted", async () => {
    const h = createTestHarness();
    const f = await seedMotion(h.writerClient);
    const candidate = await h.writerClient.putAuthoringDocument({
      projectId,
      document: { ...f.motion.document, title: "改版" } as never,
      baseRevision: f.motion.revision,
      operationId: "candidate-edit",
    });
    expect(candidate.status).toBe("candidate");
    const pins = (revision: number) => [
      ...f.document.authoring!.materials,
      { id: "spell-motion", revision },
    ];
    const setAuthoring = (revision: number) => ({
      op: "set_authoring" as const,
      authoring: { policyVersion: AUTHORING_POLICY_VERSION, materials: pins(revision) },
    });

    // composition_patch
    await expect(
      h.writerClient.patchComposition({ projectId, compositionId: "main", baseRevision: 2, operationId: "p1", operations: [setAuthoring(candidate.revision)] }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    // proposals (submit validates, approve re-validates through the same rule)
    await expect(
      h.writerClient.submitProposal({ projectId, compositionId: "main", baseRevision: 2, operationId: "pr1", description: "pin candidate", operations: [setAuthoring(candidate.revision)] }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    const proposal = await h.writerClient.submitProposal({ projectId, compositionId: "main", baseRevision: 2, operationId: "pr2", description: "keep approved pin", operations: [setAuthoring(f.motion.revision)] });
    expect(proposal.status).toBe("open");
    // composition_create of a new composition
    const fresh: CompositionDocument = { ...structuredClone(f.document), id: "alt", title: "alt", authoring: { policyVersion: AUTHORING_POLICY_VERSION, materials: pins(candidate.revision) } };
    await expect(h.writerClient.createComposition({ projectId, document: fresh })).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    expect(await h.writerClient.listCompositions(projectId)).toHaveLength(1);
    await h.writerClient.createComposition({ projectId, document: { ...fresh, authoring: { policyVersion: AUTHORING_POLICY_VERSION, materials: pins(f.motion.revision) } } });
    // MCP composition entries
    await expect(
      h.writerClient.callMcpTool("composition_patch", { projectId, compositionId: "main", baseRevision: 2, operationId: "m1", operations: [setAuthoring(candidate.revision)] }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTEXT_REQUIRED" });
    const { workflowContext } = await h.writerClient.getAuthoringWorkflow(projectId);
    await expect(
      h.writerClient.callMcpTool("composition_patch", { projectId, compositionId: "main", baseRevision: 2, operationId: "m2", workflowContext, operations: [setAuthoring(candidate.revision)] }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    // None of the refusals changed history.
    expect((await h.writerClient.getComposition(projectId, "main")).headRevision).toBe(2);
    // Reader and outsider cannot pin at all.
    await expect(
      h.readerClient.patchComposition({ projectId, compositionId: "main", baseRevision: 2, operationId: "r", operations: [setAuthoring(f.motion.revision)] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.outsiderClient.patchComposition({ projectId, compositionId: "main", baseRevision: 2, operationId: "o", operations: [setAuthoring(f.motion.revision)] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("N02 trashed compositions refuse preparation and export; restoring brings the exact pinned state back", async () => {
    const h = createTestHarness();
    const f = await seedMotion(h.writerClient);
    const trash = { projectId, kind: "composition" as const, id: "main", baseRevision: 0, expectedHeadRevision: 2, operationId: "trash" };
    await h.writerClient.changeResource({ ...trash, action: "trash" });
    await expect(h.writerClient.prepareGenerationInputs(projectId, f.request)).rejects.toMatchObject({ code: "RESOURCE_TRASHED" });
    await expect(h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" })).rejects.toMatchObject({ code: "RESOURCE_TRASHED" });
    await h.writerClient.changeResource({ ...trash, baseRevision: 1, operationId: "restore", action: "restore" });
    expect((await h.writerClient.prepareGenerationInputs(projectId, f.request)).ready).toBe(true);
    expect((await h.writerClient.exportCompositionBundle({ projectId, compositionId: "main", format: "json" })).bundle.dependencies.materials?.some((m) => m.document.id === "spell-motion")).toBe(true);
  });

  it("N03 legacy projects apply the same domain rules (no strict-only shortcut)", async () => {
    const h = createTestHarness();
    const f = await seedReferences(h.writerClient, "legacy");
    await motionAssets(h.writerClient);
    const doc = motionDocument(f);
    await expect(
      h.writerClient.putAuthoringDocument({ projectId, document: { ...doc, subjects: doc.subjects.slice(0, 1) }, baseRevision: 0, operationId: "legacy-bad" }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
    expect(
      await h.writerClient.putAuthoringDocument({ projectId, document: doc, baseRevision: 0, operationId: "legacy-ok" }),
    ).toMatchObject({ status: "candidate" });
    await expect(
      h.writerClient.approveAuthoringDocument({ projectId, id: doc.id, baseRevision: 1, operationId: "legacy-approve" }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
  });
});
