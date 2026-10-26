import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { createApiApp, handleMcpJsonRpc } from "@vflow/api";
import {
  AUTHORING_PROMPTS,
  AUTHORING_VERSION,
  GENERATION_INPUT_JSON_SCHEMA,
  MATERIAL_DOCUMENT_JSON_SCHEMA,
  REQUIRED_REVIEW_CHECKS,
  type GenerationInputPacket,
  type MaterialRevision,
  type MotionReference,
} from "@vflow/protocol";
import { createTestHarness } from "./helpers.ts";
import { TEST_AUTH_CONFIG, WRITER_AUTH } from "./auth-fixture.ts";
import {
  motionAssets,
  motionDocument,
  motionProject as projectId,
} from "./motion-fixture.ts";
import { seedReferences } from "./reference-fixture.ts";

const actor = { actorId: "alice@talkincode.net", actorKind: "human" as const };
const rpc = (
  domain: ReturnType<typeof createTestHarness>["domain"],
  method: string,
  params: Record<string, unknown> = {},
  who = actor,
) => handleMcpJsonRpc(domain, who, { jsonrpc: "2.0", id: "t", method, params });
type Json = Record<string, unknown>;

async function toolsList() {
  const { app } = createApiApp(undefined, TEST_AUTH_CONFIG);
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { ...WRITER_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/list" }),
  });
  return (
    (await response.json()) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: Json }> };
    }
  ).result.tools;
}

describe("E2E 22 — motion_reference through MCP/REST/client parity and schema discovery", () => {
  it("D01 the public tool/resource schemas describe motion_reference, the motion request and the motion evidence", async () => {
    const tools = await toolsList();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const ajv = new Ajv({ allErrors: true });
    const h = createTestHarness();
    const f = await seedReferences(h.writerClient);
    const doc = motionDocument(f);

    // Protocol schema (resource) and the ChatGPT-projected tool schemas agree on a valid / invalid document.
    const bad = { ...doc, engine: "blender" };
    const unknownKind = { ...doc, kind: "blender_scene" };
    for (const schema of [
      MATERIAL_DOCUMENT_JSON_SCHEMA,
      (byName.get("authoring_document_put")!.inputSchema.properties as Json).document,
      (byName.get("reference_plan_validate")!.inputSchema.properties as Json).document,
    ]) {
      const validate = ajv.compile(schema as object);
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(validate(bad)).toBe(false);
      expect(validate(unknownKind)).toBe(false);
      for (const key of ["video", "overview", "source", "scene", "keyframes", "usage", "fps", "durationFrames", "compositionRevision", "shotId", "subjects", "provenance"]) {
        const incomplete = structuredClone(doc) as unknown as Json;
        delete incomplete[key];
        expect(validate(incomplete), key).toBe(false);
      }
      const badFps = { ...doc, fps: 0 };
      expect(validate(badFps)).toBe(false);
    }
    // Generation input schema exposes the explicit video/keyframe choice and verified capabilities.
    const request = JSON.stringify(GENERATION_INPUT_JSON_SCHEMA);
    expect(request).toContain('"delivery"');
    expect(request).toContain('"keyframeIds"');
    expect(request).toContain('"maxDurationMs"');
    const prepareSchema = byName.get("generation_inputs_prepare")!.inputSchema.properties as Json;
    const validatePrepare = ajv.compile(prepareSchema.request as object);
    const base = {
      compositionId: "main",
      compositionRevision: 2,
      shotId: "spell",
      inputs: [{ role: "face_identity", source: { pack: { id: "suwei-face", revision: 3 }, viewId: "front" } }],
      capabilities: { verifiedAt: new Date().toISOString(), evidence: "e", maxImages: 1, roles: ["face_identity"], supportsGridSequence: false },
      prompt: "p",
      templateVersion: "reference-authoring/1",
    };
    expect(validatePrepare(base)).toBe(true);
    const withMotion = { ...base, capabilities: { ...base.capabilities, motion: { video: { maxVideos: 1, usages: ["camera_motion"] } } }, motion: { reference: { id: "spell-motion", revision: 3 }, usage: ["camera_motion"], delivery: "video" } };
    expect(validatePrepare(withMotion), JSON.stringify(validatePrepare.errors)).toBe(true);
    expect(validatePrepare({ ...withMotion, motion: { ...withMotion.motion, delivery: "auto" } })).toBe(false);
    expect(validatePrepare({ ...withMotion, motion: { ...withMotion.motion, usage: ["identity"] } })).toBe(false);
    expect(validatePrepare({ ...withMotion, motion: { ...withMotion.motion, vendor: "x" } })).toBe(false);
    // Evidence tool declares actualMotion; no tuple items anywhere (ChatGPT importer constraint).
    const evidenceSchema = byName.get("generation_evidence_record")!.inputSchema.properties as Json;
    expect(evidenceSchema.actualMotion).toMatchObject({ properties: { delivery: { enum: ["video", "keyframes"] } }, required: ["delivery"] });
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const node = value as Json;
      if (node.type === "array") expect(node.items).toBeDefined();
      expect(Array.isArray(node.items)).toBe(false);
      for (const child of Object.values(node)) if (typeof child === "object") visit(child);
    };
    for (const tool of tools) visit(tool.inputSchema);

    // Resources serve the same schemas; workflow publishes required checks and guidance.
    const material = JSON.parse(
      ((await rpc(h.domain, "resources/read", { uri: "vflow://authoring/schema/material" })).result as { contents: Array<{ text: string }> }).contents[0].text,
    );
    expect(material).toEqual(JSON.parse(JSON.stringify(MATERIAL_DOCUMENT_JSON_SCHEMA)));
    expect(JSON.stringify(material)).toContain('"motion_reference"');
    const generation = ((await rpc(h.domain, "resources/read", { uri: "vflow://authoring/schema/generation-input" })).result as { contents: Array<{ text: string }> }).contents[0].text;
    expect(generation).toContain('"keyframeIds"');
    const workflow = await h.writerClient.getAuthoringWorkflow(projectId);
    expect(workflow.requiredReviewChecks.motion_reference).toEqual(REQUIRED_REVIEW_CHECKS.motion_reference);
    expect(workflow.rules).toContain("motion_reference");
    expect(workflow.templates.map((t) => t.name)).toContain("create_motion_reference");
    expect(AUTHORING_PROMPTS.map((p) => p.name)).toContain("create_motion_reference");
    const prompt = await rpc(h.domain, "prompts/get", { name: "create_motion_reference", arguments: { projectId, brief: "石桥施法镜头白模" } });
    expect(JSON.stringify(prompt)).toContain("never an identity");
    expect(JSON.stringify(prompt)).toContain("keyframe");
    expect(f.scene.document.kind).toBe("scene");
    expect(AUTHORING_VERSION).toBe("vflow/reference-workflow/v1");
  });

  it("D02 the whole lifecycle works through MCP tools alone and REST/client observe identical state", async () => {
    const h = createTestHarness();
    const f = await seedReferences(h.writerClient);
    await motionAssets(h.writerClient);
    const doc = motionDocument(f);
    const { workflowContext } = await h.writerClient.callMcpTool<{ workflowContext: unknown }>("authoring_workflow_get", { projectId });
    const call = <T>(name: string, args: Json, client = h.writerClient) =>
      client.callMcpTool<T>(name, { projectId, workflowContext, ...args });
    // Missing / stale context stops the write exactly like every other authoring document.
    await expect(h.writerClient.callMcpTool("authoring_document_put", { projectId, document: doc, baseRevision: 0, operationId: "nc" })).rejects.toMatchObject({ code: "WORKFLOW_CONTEXT_REQUIRED" });
    await expect(
      h.writerClient.callMcpTool("authoring_document_put", { projectId, document: doc, baseRevision: 0, operationId: "stale", workflowContext: { projectId, policyVersion: "reference-authoring/1", policyRevision: 99 } }),
    ).rejects.toMatchObject({ code: "WORKFLOW_VERSION_MISMATCH" });
    // reference_plan_validate is read-only and reports diagnostics through the same domain rules.
    const validation = await h.readerClient.callMcpTool<{ ready: boolean; diagnostics: Array<{ code: string }> }>("reference_plan_validate", { projectId, document: { ...doc, shotId: "ghost" } });
    expect(validation.ready).toBe(false);
    expect(validation.diagnostics.map((d) => d.code)).toContain("DEPENDENCY_ERROR");
    const put = await call<MaterialRevision>("authoring_document_put", { document: doc, baseRevision: 0, operationId: "m-put" });
    expect(put).toMatchObject({ revision: 1, status: "candidate" });
    // Error objects keep machine-readable codes over MCP.
    await expect(call("authoring_document_approve", { id: doc.id, baseRevision: 1, operationId: "m-early" })).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    const reviewed = await call<MaterialRevision>("authoring_document_review", {
      id: doc.id,
      baseRevision: 1,
      operationId: "m-review",
      targets: ["$document"],
      review: { method: "human", reviewer: "x", decision: "accepted", evidence: "full playback inspected", checks: Object.fromEntries(REQUIRED_REVIEW_CHECKS.motion_reference.map((c) => [c, "pass"])) },
    });
    const approved = await call<MaterialRevision>("authoring_document_approve", { id: doc.id, baseRevision: reviewed.revision, operationId: "m-approve" });
    expect(approved.status).toBe("approved");
    expect(await h.writerClient.getAuthoringDocument(projectId, doc.id, approved.revision)).toEqual(approved);
    expect(await call("authoring_document_get", { id: doc.id, revision: approved.revision })).toEqual(approved);
    // Pin through the composition tool, then prepare + record through MCP.
    await call("composition_patch", {
      compositionId: "main",
      baseRevision: 1,
      operationId: "m-pin",
      operations: [{ op: "set_authoring", authoring: { policyVersion: "reference-authoring/1", materials: [...f.document.authoring!.materials, { id: doc.id, revision: approved.revision }] } }],
    });
    const request = {
      ...f.request,
      compositionRevision: 2,
      capabilities: { ...f.request.capabilities, motion: { video: { maxVideos: 1, usages: ["camera_motion", "blocking", "action_timing"] } } },
      motion: { reference: { id: doc.id, revision: approved.revision }, usage: ["camera_motion", "blocking", "action_timing"], delivery: "video" },
    };
    const viaMcp = await call<{ ready: boolean; packet: GenerationInputPacket }>("generation_inputs_prepare", { request });
    const viaRest = await h.writerClient.prepareGenerationInputs(projectId, request);
    expect(viaMcp.ready).toBe(true);
    expect(viaMcp).toEqual(viaRest);
    // An unverified video capability is refused over MCP with diagnostics, not a packet.
    const refused = await call<{ ready: boolean; packet?: unknown; diagnostics: Array<{ code: string }> }>("generation_inputs_prepare", { request: { ...request, capabilities: { ...request.capabilities, motion: undefined } } });
    expect(refused.packet).toBeUndefined();
    expect(refused.diagnostics.map((d) => d.code)).toContain("MOTION_VIDEO_CAPABILITY_REQUIRED");
    const packet = viaMcp.packet;
    const evidence = await call<{ matchesPlan: boolean; actualMotion: unknown }>("generation_evidence_record", {
      id: "mcp-run",
      operationId: "mcp-run",
      packet,
      actualInputs: packet.inputs.map(({ asset, sha256, role }) => ({ asset, sha256, role })),
      actualMotion: { delivery: "video", video: packet.motion!.video },
      outputs: ["panel-one"],
      method: "agent_reported",
      evidence: "external run log",
    });
    expect(evidence.matchesPlan).toBe(true);
    expect(await h.writerClient.listGenerationEvidence(projectId)).toEqual([expect.objectContaining({ id: "mcp-run", actualMotion: evidence.actualMotion })]);
    // Authorization is the same domain check: reader cannot write, outsider cannot read.
    await h.readerClient.getAuthoringWorkflow(projectId);
    await expect(call("authoring_document_put", { document: { ...doc, id: "other" }, baseRevision: 0, operationId: "r" }, h.readerClient)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.outsiderClient.callMcpTool("authoring_document_get", { projectId, id: doc.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await call<MaterialRevision>("authoring_document_get", { id: doc.id }, h.readerClient)).document.kind).toBe("motion_reference");
    // The modern (2026) lifecycle reaches the same tools and returns the same document.
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "m", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
    const modern = await rpc(h.domain, "tools/call", { _meta: meta, name: "authoring_document_get", arguments: { projectId, id: doc.id, revision: approved.revision } });
    expect(JSON.stringify(modern.result)).toContain("motion_reference");
    expect((approved.document as MotionReference).review?.reviewer).toBe("alice@talkincode.net");
  });
});
