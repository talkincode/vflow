import { AUTHORING_TOOLS, AUTHORING_SERVER_INSTRUCTIONS, WORKFLOW_CONTEXT_SCHEMA, authoringRpc } from "./authoring-mcp.ts";
import type { WorkflowContext } from "@video-compose/protocol";
import {
  DomainError,
  type TypedOperation,
  type VideoComposeDomainService,
} from "@video-compose/domain";
import type {
  ActorIdentity,
  CompositionDocument,
  ReferencePackEntry,
  RevisionStatus,
  ShotSubjectBinding,
  SubjectKind,
  SubjectVariant,
} from "@video-compose/protocol";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const MCP_TOOLS_MANIFEST: McpToolDefinition[] = [
  ...AUTHORING_TOOLS,
  {
    name: "project_list",
    description: "List projects accessible to the caller",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "project_get",
    description: "Get project details and member roles",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "project_overview",
    description: "Get authorized project overview, composition list and shared resource counts",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "project_create",
    description: "Create a new project",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique project ID" },
        name: { type: "string", description: "Project display name" },
        description: { type: "string", description: "Project description" },
        members: {
          type: "object",
          description: "Map of actorId to role ('reader' | 'writer')",
        },
        operationId: { type: "string", description: "Idempotency key" },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "composition_get",
    description: "Get composition revision and resolved subjects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        revision: {
          type: "number",
          description: "Specific revision number (defaults to latest)",
        },
      },
      required: ["projectId", "compositionId"],
    },
  },
  {
    name: "composition_create",
    description: "Create a new composition in a project",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        document: {
          type: "object",
          description: "Complete declarative CompositionDocument",
        },
        operationId: { type: "string", description: "Idempotency key" },
      },
      required: ["projectId", "document"],
    },
  },
  {
    name: "composition_list",
    description: "List compositions accessible within a project",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "composition_patch",
    description: "Apply ID-addressed typed patch to a composition",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        baseRevision: {
          type: "number",
          description: "Base revision number for optimistic concurrency",
        },
        operationId: { type: "string", description: "Idempotency key" },
        operations: {
          type: "array",
          description: "List of typed patch operations",
          items: { type: "object" },
        },
        message: { type: "string", description: "Commit / change message" },
      },
      required: [
        "projectId",
        "compositionId",
        "baseRevision",
        "operationId",
        "operations",
      ],
    },
  },
  {
    name: "composition_history",
    description: "List immutable revision and change history",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
      },
      required: ["projectId", "compositionId"],
    },
  },
  {
    name: "composition_restore",
    description: "Restore a historical composition revision",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        targetRevision: {
          type: "number",
          description: "Historical revision number to restore",
        },
        operationId: { type: "string", description: "Idempotency key" },
      },
      required: [
        "projectId",
        "compositionId",
        "targetRevision",
        "operationId",
      ],
    },
  },
  {
    name: "composition_export",
    description: "Export portable composition bundle (JSON/YAML)",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        revision: {
          type: "number",
          description: "Revision to export (defaults to latest)",
        },
        format: {
          type: "string",
          enum: ["json", "yaml"],
          description: "Serialization format",
        },
      },
      required: ["projectId", "compositionId"],
    },
  },
  {
    name: "composition_import",
    description: "Import portable composition bundle (JSON/YAML)",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        payload: {
          type: "string",
          description: "Portable bundle JSON or YAML text",
        },
        format: {
          type: "string",
          enum: ["json", "yaml"],
          description: "Payload format",
        },
        targetCompositionId: {
          type: "string",
          description: "Optional composition ID to import as",
        },
        operationId: { type: "string", description: "Idempotency key" },
      },
      required: ["projectId", "payload"],
    },
  },
  {
    name: "asset_search",
    description: "Search immutable project assets",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        mimePrefix: {
          type: "string",
          description: "Filter by MIME prefix (e.g. 'image/', 'video/')",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "asset_upload",
    description: "Upload and verify SHA-256 media asset",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        assetId: { type: "string", description: "Asset identifier" },
        contentBase64: {
          type: "string",
          description: "Base64 encoded binary data",
        },
        mimeType: { type: "string", description: "MIME type" },
        expectedSha256: {
          type: "string",
          description: "Optional expected SHA-256 hex digest",
        },
        width: { type: "number", description: "Width in pixels" },
        height: { type: "number", description: "Height in pixels" },
        durationFrames: { type: "number", description: "Duration in frames" },
      },
      required: ["projectId", "assetId", "contentBase64", "mimeType"],
    },
  },
  {
    name: "asset_link",
    description: "Attach a candidate or selected asset to a shot (maximum 5 candidate images per shot)",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        shotId: { type: "string", description: "Target shot ID" },
        assetId: { type: "string", description: "Asset ID to attach" },
        mediaKind: {
          type: "string",
          enum: ["images", "videos", "audios"],
          description: "Media kind",
        },
        role: { type: "string", description: "Role tag" },
        notes: { type: "string", description: "Notes on candidate" },
      },
      required: [
        "projectId",
        "compositionId",
        "baseRevision",
        "operationId",
        "shotId",
        "assetId",
      ],
    },
  },
  {
    name: "asset_unlink",
    description: "Detach a candidate asset from a shot",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        shotId: { type: "string", description: "Target shot ID" },
        assetId: { type: "string", description: "Asset ID to detach" },
        mediaKind: {
          type: "string",
          enum: ["images", "videos", "audios"],
          description: "Media kind (default: images)",
        },
      },
      required: [
        "projectId",
        "compositionId",
        "baseRevision",
        "operationId",
        "shotId",
        "assetId",
      ],
    },
  },
  {
    name: "asset_update_candidate",
    description: "Update metadata (role, notes, actor) of a shot's candidate asset",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        shotId: { type: "string", description: "Target shot ID" },
        assetId: { type: "string", description: "Target candidate asset ID" },
        mediaKind: {
          type: "string",
          enum: ["images", "videos", "audios"],
          description: "Media kind (default: images)",
        },
        role: { type: "string", description: "Role tag" },
        actor: { type: "string", description: "Actor or contributor identifier" },
        notes: { type: "string", description: "Notes on candidate" },
      },
      required: [
        "projectId",
        "compositionId",
        "baseRevision",
        "operationId",
        "shotId",
        "assetId",
      ],
    },
  },
  {
    name: "asset_delete",
    description: "Delete an unreferenced asset from the project library",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        assetId: { type: "string", description: "Asset ID to delete" },
      },
      required: ["projectId", "assetId"],
    },
  },
  {
    name: "subject_list",
    description: "List character and prop subjects in a project",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        kind: {
          type: "string",
          enum: ["character", "prop"],
          description: "Filter by subject kind",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "subject_get",
    description: "Get subject definition and specific revision snapshot",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        subjectId: { type: "string", description: "Subject ID" },
        revision: {
          type: "number",
          description: "Specific revision number (defaults to latest)",
        },
      },
      required: ["projectId", "subjectId"],
    },
  },
  {
    name: "subject_create",
    description: "Create a character or prop subject",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        id: { type: "string", description: "Subject ID" },
        kind: {
          type: "string",
          enum: ["character", "prop"],
          description: "Subject kind",
        },
        name: { type: "string", description: "Display name" },
        defaultVariant: {
          type: "string",
          description: "Default variant name",
        },
        status: {
          type: "string",
          enum: ["candidate", "approved"],
          description: "Initial status",
        },
        definition: {
          type: "object",
          description: "Subject definition { description, invariants }",
        },
        variants: {
          type: "object",
          description: "Map of variant definitions",
        },
      },
      required: ["projectId", "id", "kind", "name", "definition", "variants"],
    },
  },
  {
    name: "subject_patch",
    description: "Create a candidate subject revision with changes",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        subjectId: { type: "string", description: "Subject ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        changes: {
          type: "object",
          description: "Changes to apply to the subject",
        },
      },
      required: [
        "projectId",
        "subjectId",
        "baseRevision",
        "operationId",
        "changes",
      ],
    },
  },
  {
    name: "subject_reference_attach",
    description: "Attach a reference asset to a subject variant",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        subjectId: { type: "string", description: "Subject ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        variant: { type: "string", description: "Target variant name" },
        entry: {
          type: "object",
          description: "Reference pack entry { asset, view, notes, status }",
        },
      },
      required: [
        "projectId",
        "subjectId",
        "baseRevision",
        "operationId",
        "variant",
        "entry",
      ],
    },
  },
  {
    name: "subject_approve_revision",
    description: "Promote a candidate subject revision to approved",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        subjectId: { type: "string", description: "Subject ID" },
        revision: {
          type: "number",
          description: "Revision number to approve",
        },
        operationId: { type: "string", description: "Idempotency key" },
      },
      required: ["projectId", "subjectId", "revision", "operationId"],
    },
  },
  {
    name: "shot_subject_bind",
    description: "Pin a shot to a specific approved subject revision and variant",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        shotId: { type: "string", description: "Target shot ID" },
        binding: {
          type: "object",
          description: "Binding { subjectId, subjectRevision, variant }",
        },
      },
      required: [
        "projectId",
        "compositionId",
        "baseRevision",
        "operationId",
        "shotId",
        "binding",
      ],
    },
  },
  {
    name: "subject_usage",
    description: "Inspect which compositions and shots bind a subject",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        subjectId: { type: "string", description: "Subject ID" },
        revision: {
          type: "number",
          description: "Optional revision number",
        },
      },
      required: ["projectId", "subjectId"],
    },
  },
  {
    name: "review_submit",
    description: "Submit a review proposal for a composition",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        compositionId: { type: "string", description: "Target composition ID" },
        baseRevision: { type: "number", description: "Base revision number" },
        operationId: { type: "string", description: "Idempotency key" },
        description: { type: "string", description: "Proposal description" },
        operations: {
          type: "array",
          description: "Proposed operations",
          items: { type: "object" },
        },
      },
      required: [
        "projectId",
        "compositionId",
        "baseRevision",
        "operationId",
        "description",
        "operations",
      ],
    },
  },
  {
    name: "review_approve",
    description: "Approve and merge a review proposal",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        proposalId: { type: "string", description: "Proposal ID to approve" },
        operationId: { type: "string", description: "Idempotency key" },
      },
      required: ["projectId", "proposalId", "operationId"],
    },
  },
];

for (const tool of MCP_TOOLS_MANIFEST) {
  if (["composition_create", "composition_patch", "composition_import", "shot_subject_bind", "subject_create", "subject_patch", "subject_reference_attach", "composition_restore", "subject_approve_revision", "asset_link", "asset_unlink", "asset_update_candidate", "review_approve"].includes(tool.name)) {
    tool.inputSchema.properties.workflowContext = WORKFLOW_CONTEXT_SCHEMA;
    tool.description += " In strict projects, read authoring_workflow_get first and provide workflowContext. Raw mixed boards cannot become canonical references.";
  }
  if (tool.name === "composition_import") tool.inputSchema.properties.baseRevision = { type: "integer", minimum: 0, description: "Required when importing into an existing strict composition." };
  if (tool.name === "composition_export") tool.inputSchema.properties.targetVersion = { enum: ["video-compose/v1", "video-compose/v2"], description: "v2 material dependencies cannot be dropped for v1 readers." };
  if (tool.name === "project_create") tool.inputSchema.properties.authoringMode = { enum: ["strict", "legacy"], description: "New projects default to strict. legacy is an explicit archive/compatibility mode." };
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function handleMcpJsonRpc(
  domain: VideoComposeDomainService,
  actor: ActorIdentity | null,
  rpc: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = rpc.id ?? null;

  if (!actor) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32001,
        message: "UNAUTHORIZED: Missing or invalid Cloudflare Access credentials.",
        data: { code: "UNAUTHORIZED" },
      },
    };
  }

  try {
    if (rpc.method === "initialize") {
      const requestedVersion = String(
        (rpc.params as Record<string, unknown> | undefined)?.protocolVersion ??
          "2024-11-05",
      );
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(requestedVersion) ? requestedVersion : "2025-11-25",
          instructions: AUTHORING_SERVER_INSTRUCTIONS,
          serverInfo: {
            name: "video-compose-mcp",
            version: "0.1.0",
          },
          capabilities: {
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            tools: {
              listChanged: false,
            },
          },
        },
      };
    }

    if (rpc.method === "notifications/initialized") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
      };
    }

    if (rpc.method === "ping") {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    if (["prompts/list", "prompts/get", "resources/list", "resources/templates/list", "resources/read"].includes(rpc.method)) {
      try { return { jsonrpc: "2.0", id, result: await authoringRpc(domain, actor, rpc) }; }
      catch (err) { if (err instanceof DomainError) throw err; return { jsonrpc: "2.0", id, error: { code: -32602, message: err instanceof Error ? err.message : String(err) } }; }
    }

    if (rpc.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS_MANIFEST,
        },
      };
    }

    if (rpc.method === "tools/call") {
      const toolName = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      const data = await dispatchMcpTool(domain, actor, toolName, args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(data) }],
          // MCP structuredContent must be an object; list results stay in text.
          ...(data !== null && typeof data === "object" && !Array.isArray(data)
            ? { structuredContent: data }
            : {}),
          isError: false,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method '${rpc.method}' not found.`,
      },
    };
  } catch (err) {
    if (err instanceof DomainError) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err.message,
          data: {
            code: err.code,
            ...(err.details ?? {}),
          },
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function dispatchMcpTool(
  domain: VideoComposeDomainService,
  actor: ActorIdentity,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const projectId = String(args.projectId ?? "");
  switch (toolName) {
    case "authoring_dependencies_get": return domain.authoring.impact(actor, projectId, { id: String(args.id ?? ""), revision: Number(args.revision) });
    case "authoring_workflow_get": return domain.authoring.workflow(actor, projectId, args.language === "en" ? "en" : "zh");
    case "authoring_document_list": return domain.authoring.list(actor, projectId);
    case "authoring_document_get": return domain.authoring.get(actor, projectId, String(args.id ?? ""), args.revision === undefined ? undefined : Number(args.revision));
    case "reference_plan_validate": return domain.authoring.validate(actor, projectId, args.document);
    case "authoring_document_put": return domain.authoring.put(actor, args as unknown as Parameters<typeof domain.authoring.put>[1]);
    case "authoring_document_review": return domain.authoring.review(actor, args as unknown as Parameters<typeof domain.authoring.review>[1]);
    case "authoring_document_approve": return domain.authoring.approve(actor, args as unknown as Parameters<typeof domain.authoring.approve>[1]);
    case "generation_inputs_prepare": return domain.authoring.prepare(actor, projectId, args.request, args.workflowContext as WorkflowContext | undefined);
    case "generation_evidence_record": return domain.authoring.recordEvidence(actor, args as unknown as Parameters<typeof domain.authoring.recordEvidence>[1]);
    case "generation_evidence_list": return domain.authoring.evidence(actor, projectId);
  }

  switch (toolName) {
    case "project_list":
      return domain.listProjects(actor);

    case "project_get":
      return domain.getProject(actor, String(args.projectId ?? ""));

    case "project_overview":
      return domain.getProjectOverview(actor, String(args.projectId ?? ""));

    case "project_create":
      return domain.createProject(actor, {
        id: String(args.id ?? ""),
        name: String(args.name ?? ""),
        authoringMode: args.authoringMode as "strict" | "legacy" | undefined,
        description: args.description ? String(args.description) : undefined,
        members: args.members as Record<string, "reader" | "writer"> | undefined,
        operationId: args.operationId ? String(args.operationId) : undefined,
      });

    case "composition_get":
      return domain.getComposition(
        actor,
        String(args.projectId ?? ""),
        String(args.compositionId ?? ""),
        typeof args.revision === "number" ? args.revision : undefined,
      );

    case "composition_list":
      return domain.listCompositions(actor, String(args.projectId ?? ""));

    case "composition_create":
      return domain.createComposition(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        document: args.document as CompositionDocument,
        operationId: args.operationId ? String(args.operationId) : undefined,
      });

    case "composition_patch":
      return domain.patchComposition(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        operations: (args.operations ?? []) as TypedOperation[],
        message: args.message ? String(args.message) : undefined,
      });

    case "composition_history":
      return domain.listCompositionHistory(
        actor,
        String(args.projectId ?? ""),
        String(args.compositionId ?? ""),
      );

    case "composition_restore":
      return domain.restoreCompositionRevision(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        targetRevision: Number(args.targetRevision),
        operationId: String(args.operationId ?? ""),
      });

    case "composition_export":
      return domain.exportCompositionBundle(actor, {
        targetVersion: args.targetVersion === "video-compose/v1" ? "video-compose/v1" : undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        revision: typeof args.revision === "number" ? args.revision : undefined,
        format: (args.format === "yaml" ? "yaml" : "json") as "json" | "yaml",
      });

    case "composition_import":
      return domain.importCompositionBundle(actor, {
        baseRevision: typeof args.baseRevision === "number" ? args.baseRevision : undefined,
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        payload: String(args.payload ?? ""),
        format: (args.format === "yaml" ? "yaml" : "json") as "json" | "yaml",
        targetCompositionId: args.targetCompositionId
          ? String(args.targetCompositionId)
          : undefined,
        operationId: args.operationId ? String(args.operationId) : undefined,
      });

    case "asset_search":
      return domain.listAssets(
        actor,
        String(args.projectId ?? ""),
        args.mimePrefix ? { mimePrefix: String(args.mimePrefix) } : undefined,
      );

    case "asset_upload": {
      const bytes = decodeBase64Bytes(String(args.contentBase64 ?? ""));
      return domain.registerAssetDirect(actor, {
        projectId: String(args.projectId ?? ""),
        assetId: String(args.assetId ?? ""),
        bytes,
        expectedSha256: args.expectedSha256
          ? String(args.expectedSha256)
          : undefined,
        mimeType: String(args.mimeType ?? ""),
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
        durationFrames:
          typeof args.durationFrames === "number" ? args.durationFrames : undefined,
      });
    }

    case "asset_link":
      return domain.patchComposition(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        operations: [
          {
            op: "attach_shot_candidate",
            shotId: String(args.shotId ?? ""),
            mediaKind: (args.mediaKind ?? "images") as "images" | "videos" | "audios",
            candidate: {
              asset: String(args.assetId ?? ""),
              actor: actor.actorId,
              ...(args.role ? { role: String(args.role) } : {}),
              ...(args.notes ? { notes: String(args.notes) } : {}),
            },
          },
        ],
      });

    case "asset_unlink":
      return domain.patchComposition(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        operations: [
          {
            op: "detach_shot_candidate",
            shotId: String(args.shotId ?? ""),
            mediaKind: (args.mediaKind ?? "images") as "images" | "videos" | "audios",
            assetId: String(args.assetId ?? ""),
          },
        ],
      });

    case "asset_update_candidate":
      return domain.patchComposition(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        operations: [
          {
            op: "update_shot_candidate",
            shotId: String(args.shotId ?? ""),
            mediaKind: (args.mediaKind ?? "images") as "images" | "videos" | "audios",
            assetId: String(args.assetId ?? ""),
            candidate: {
              ...(args.role !== undefined ? { role: String(args.role) } : {}),
              ...(args.actor !== undefined ? { actor: String(args.actor) } : {}),
              ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
            },
          },
        ],
      });

    case "asset_delete":
      return domain.deleteAsset(
        actor,
        String(args.projectId ?? ""),
        String(args.assetId ?? ""),
      );

    case "subject_list":
      return domain.listSubjects(
        actor,
        String(args.projectId ?? ""),
        args.kind ? (String(args.kind) as SubjectKind) : undefined,
      );

    case "subject_get":
      return domain.getSubject(
        actor,
        String(args.projectId ?? ""),
        String(args.subjectId ?? ""),
        typeof args.revision === "number" ? args.revision : undefined,
      );

    case "subject_create":
      return domain.createSubject(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        id: String(args.id ?? ""),
        kind: String(args.kind ?? "character") as SubjectKind,
        name: String(args.name ?? ""),
        defaultVariant: args.defaultVariant
          ? String(args.defaultVariant)
          : undefined,
        status: args.status ? (String(args.status) as RevisionStatus) : "candidate",
        definition: args.definition as { description: string; invariants: string[] },
        variants: args.variants as Record<string, SubjectVariant>,
      });

    case "subject_patch":
      return domain.patchSubject(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        subjectId: String(args.subjectId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        changes: (args.changes ?? {}) as Record<string, unknown>,
      });

    case "subject_reference_attach":
      return domain.attachSubjectReference(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        subjectId: String(args.subjectId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        variant: String(args.variant ?? ""),
        entry: args.entry as Omit<ReferencePackEntry, "status"> & {
          status?: RevisionStatus;
        },
      });

    case "subject_approve_revision":
      return domain.approveSubjectRevision(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        subjectId: String(args.subjectId ?? ""),
        revision: Number(args.revision),
        operationId: String(args.operationId ?? ""),
      });

    case "shot_subject_bind":
      return domain.patchComposition(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        operations: [
          {
            op: "bind_shot_subject",
            shotId: String(args.shotId ?? ""),
            binding: args.binding as ShotSubjectBinding,
          },
        ],
      });

    case "subject_usage":
      return domain.getSubjectUsage(
        actor,
        String(args.projectId ?? ""),
        String(args.subjectId ?? ""),
      );

    case "review_submit":
      return domain.submitProposal(actor, {
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        description: String(args.description ?? ""),
        operations: (args.operations ?? []) as TypedOperation[],
      });

    case "review_approve":
      return domain.approveProposal(actor, {
        workflowContext: args.workflowContext as WorkflowContext | undefined,
        projectId: String(args.projectId ?? ""),
        proposalId: String(args.proposalId ?? ""),
        operationId: String(args.operationId ?? ""),
      });

    default:
      throw new DomainError(
        "VALIDATION_FAILED",
        `Unknown MCP tool '${toolName}'.`,
      );
  }
}
