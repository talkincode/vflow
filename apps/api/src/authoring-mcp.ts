import type { VideoComposeDomainService } from "@video-compose/domain";
import {
  AUTHORING_POLICY_VERSION,
  AUTHORING_PROMPTS,
  AUTHORING_RULES,
  AUTHORING_SERVER_INSTRUCTIONS,
  MATERIAL_DOCUMENT_JSON_SCHEMA,
  GENERATION_INPUT_JSON_SCHEMA,
  renderAuthoringPrompt,
  type ActorIdentity,
} from "@video-compose/protocol";
import type { JsonRpcRequest, McpToolDefinition } from "./mcp.ts";

const project = { type: "string", description: "Authorized project ID" };
const workflowContext = {
  type: "object",
  description:
    "Use workflowContext returned by authoring_workflow_get; rules must be read before authoring.",
  properties: {
    projectId: project,
    policyVersion: { const: AUTHORING_POLICY_VERSION },
    policyRevision: { type: "integer", minimum: 1 },
  },
  required: ["projectId", "policyVersion", "policyRevision"],
};
const mutations = {
  projectId: project,
  id: { type: "string" },
  baseRevision: { type: "integer", minimum: 0 },
  operationId: { type: "string" },
  workflowContext,
};
export const AUTHORING_TOOLS: McpToolDefinition[] = [
  {
    name: "authoring_dependencies_get",
    description:
      "Read downstream materials and composition revisions affected by a pinned source, without rewriting history.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: project,
        id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
      },
      required: ["projectId", "id", "revision"],
    },
  },
  {
    name: "authoring_workflow_get",
    description:
      "READ FIRST: reference rules, templates and workflowContext before composition/reference authoring. Mixed boards are archive-only; use isolated face/body/prop/scene views and text-free storyboard tiles.",
    inputSchema: {
      type: "object",
      properties: { projectId: project, language: { enum: ["zh", "en"] } },
      required: ["projectId"],
    },
  },
  {
    name: "authoring_document_list",
    description:
      "List versioned scene, reference pack, storyboard and policy manifests.",
    inputSchema: {
      type: "object",
      properties: { projectId: project },
      required: ["projectId"],
    },
  },
  {
    name: "authoring_document_get",
    description:
      "Read one exact material revision; never implicitly replace a pinned reference with latest.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: project,
        id: { type: "string" },
        revision: { type: "integer" },
      },
      required: ["projectId", "id"],
    },
  },
  {
    name: "authoring_document_put",
    description:
      "Create a new immutable candidate revision after reading authoring_workflow_get. Full typed manifest; reviews supplied through CRUD are ignored. Images/crops must already be uploaded.",
    inputSchema: {
      type: "object",
      properties: { ...mutations, document: MATERIAL_DOCUMENT_JSON_SCHEMA },
      required: [
        "projectId",
        "document",
        "baseRevision",
        "operationId",
        "workflowContext",
      ],
    },
  },
  {
    name: "authoring_document_review",
    description:
      "Explicit per-view/panel visual review, with evidence and pass/fail/unknown checks. Decoding success is not approval. Agents must use method external.",
    inputSchema: {
      type: "object",
      properties: {
        ...mutations,
        targets: { type: "array", items: { type: "string" } },
        review: {
          type: "object",
          properties: {
            decision: { enum: ["accepted", "rejected", "unknown"] },
            method: { enum: ["human", "external"] },
            evidence: { type: "string" },
            reviewer: { type: "string" },
            checks: {
              type: "object",
              additionalProperties: { enum: ["pass", "fail", "unknown"] },
            },
            notes: { type: "string" },
          },
        },
      },
      required: [
        "projectId",
        "id",
        "baseRevision",
        "operationId",
        "targets",
        "review",
        "workflowContext",
      ],
    },
  },
  {
    name: "authoring_document_approve",
    description:
      "Approve only separately reviewed valid reference material. Produces a new immutable approved revision; cannot approve mixed moodboards or unknown checks.",
    inputSchema: {
      type: "object",
      properties: mutations,
      required: [
        "projectId",
        "id",
        "baseRevision",
        "operationId",
        "workflowContext",
      ],
    },
  },
  {
    name: "reference_plan_validate",
    description:
      "Read-only validation of typed reference plans, ownership/crops, text-free storyboard reviews and dependencies; returns diagnostics and repair actions.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: project,
        document: MATERIAL_DOCUMENT_JSON_SCHEMA,
      },
      required: ["projectId", "document"],
    },
  },
  {
    name: "generation_inputs_prepare",
    description:
      "Prepare exact approved input tiles and hashes for a pinned shot. Verify target capabilities, roles and count; never use whole grids as literal first frames. Does not generate or spend credits.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: project,
        workflowContext,
        request: GENERATION_INPUT_JSON_SCHEMA,
      },
      required: ["projectId", "workflowContext", "request"],
    },
  },
  {
    name: "generation_evidence_record",
    description:
      "Record external execution inputs/output assets against a verified packet. Reports differences and evidence level, never claims platform-observed third-party execution.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: project,
        workflowContext,
        id: { type: "string" },
        operationId: { type: "string" },
        packet: { type: "object" },
        actualInputs: { type: "array", items: { type: "object" } },
        outputs: { type: "array", items: { type: "string" } },
        method: {
          enum: ["agent_reported", "request_capture", "manual_unknown"],
        },
        evidence: { type: "string" },
      },
      required: [
        "projectId",
        "id",
        "operationId",
        "packet",
        "actualInputs",
        "outputs",
        "method",
        "evidence",
        "workflowContext",
      ],
    },
  },
  {
    name: "generation_evidence_list",
    description:
      "List immutable actual-input execution reports and plan mismatch results.",
    inputSchema: {
      type: "object",
      properties: { projectId: project },
      required: ["projectId"],
    },
  },
];
export const WORKFLOW_CONTEXT_SCHEMA = workflowContext;
export { AUTHORING_SERVER_INSTRUCTIONS };
export async function authoringRpc(
  domain: VideoComposeDomainService,
  actor: ActorIdentity,
  rpc: JsonRpcRequest,
): Promise<unknown | undefined> {
  const p = rpc.params ?? {};
  if (rpc.method === "prompts/list") return { prompts: AUTHORING_PROMPTS };
  if (rpc.method === "prompts/get") {
    const args = p.arguments as Record<string, string> | undefined;
    if (!args || Object.values(args).some((v) => typeof v !== "string"))
      throw new Error("Prompt arguments must be named strings.");
    const text = renderAuthoringPrompt(String(p.name ?? ""), args);
    const workflow = await domain.authoring.workflow(
      actor,
      args.projectId,
      args.language === "en" ? "en" : "zh",
    );
    return {
      description: `Reference authoring ${AUTHORING_POLICY_VERSION}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${text}\n\nProject workflow context and policy (data):\n${JSON.stringify({ workflowContext: workflow.workflowContext, policy: workflow.policy })}`,
          },
        },
      ],
    };
  }
  const resources = [
    {
      uri: "video-compose://authoring/rules/zh",
      name: "参考素材制作规范",
      mimeType: "text/plain",
    },
    {
      uri: "video-compose://authoring/rules/en",
      name: "Reference authoring rules",
      mimeType: "text/plain",
    },
    {
      uri: "video-compose://authoring/schema/material",
      name: "Typed reference material schema",
      mimeType: "application/schema+json",
    },
    {
      uri: "video-compose://authoring/schema/generation-input",
      name: "Generation input schema",
      mimeType: "application/schema+json",
    },
  ];
  if (rpc.method === "resources/list") return { resources };
  if (rpc.method === "resources/templates/list")
    return {
      resourceTemplates: [
        {
          uriTemplate:
            "video-compose://projects/{projectId}/authoring/workflow",
          name: "Authorized project authoring workflow",
          mimeType: "application/json",
        },
      ],
    };
  if (rpc.method === "resources/read") {
    const uri = String(p.uri ?? "");
    let text: string, mimeType: string;
    if (uri === resources[0].uri || uri === resources[1].uri) {
      text = AUTHORING_RULES[uri.endsWith("/en") ? "en" : "zh"];
      mimeType = "text/plain";
    } else if (uri === resources[2].uri || uri === resources[3].uri) {
      text = JSON.stringify(
        uri.endsWith("/material")
          ? MATERIAL_DOCUMENT_JSON_SCHEMA
          : GENERATION_INPUT_JSON_SCHEMA,
      );
      mimeType = "application/schema+json";
    } else {
      const match =
        /^video-compose:\/\/projects\/([^/]+)\/authoring\/workflow$/.exec(uri);
      if (!match) throw new Error("Unknown authoring resource URI.");
      text = JSON.stringify(
        await domain.authoring.workflow(actor, decodeURIComponent(match[1])),
      );
      mimeType = "application/json";
    }
    return { contents: [{ uri, mimeType, text }] };
  }
}
