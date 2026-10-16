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

export const MCP_TOOLS_MANIFEST = [
  { name: "project_list", description: "List projects accessible to the caller" },
  { name: "project_get", description: "Get project details and member roles" },
  { name: "project_create", description: "Create a new project" },
  { name: "composition_get", description: "Get composition revision and resolved subjects" },
  { name: "composition_create", description: "Create a new composition in a project" },
  { name: "composition_patch", description: "Apply ID-addressed typed patch to a composition" },
  { name: "composition_history", description: "List immutable revision and change history" },
  { name: "composition_restore", description: "Restore a historical composition revision" },
  { name: "composition_export", description: "Export portable composition bundle (JSON/YAML)" },
  { name: "composition_import", description: "Import portable composition bundle (JSON/YAML)" },
  { name: "asset_search", description: "Search immutable project assets" },
  { name: "asset_upload", description: "Upload and verify SHA-256 media asset" },
  { name: "asset_link", description: "Attach a candidate or selected asset to a shot" },
  { name: "asset_delete", description: "Delete an unreferenced asset" },
  { name: "subject_list", description: "List character and prop subjects in a project" },
  { name: "subject_get", description: "Get subject definition and specific revision snapshot" },
  { name: "subject_create", description: "Create a character or prop subject" },
  { name: "subject_patch", description: "Create a candidate subject revision with changes" },
  { name: "subject_reference_attach", description: "Attach a reference asset to a subject variant" },
  { name: "subject_approve_revision", description: "Promote a candidate subject revision to approved" },
  { name: "shot_subject_bind", description: "Pin a shot to a specific approved subject revision and variant" },
  { name: "subject_usage", description: "Inspect which compositions and shots bind a subject" },
  { name: "review_submit", description: "Submit a review proposal for a composition" },
  { name: "review_approve", description: "Approve and merge a review proposal" },
] as const;

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
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: {
            name: "video-compose-mcp",
            version: "0.1.0",
          },
          capabilities: {
            tools: {},
          },
        },
      };
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
          structuredContent: data,
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
  switch (toolName) {
    case "project_list":
      return domain.listProjects(actor);

    case "project_get":
      return domain.getProject(actor, String(args.projectId ?? ""));

    case "project_create":
      return domain.createProject(actor, {
        id: String(args.id ?? ""),
        name: String(args.name ?? ""),
        description: args.description ? String(args.description) : undefined,
        members: args.members as Record<string, "reader" | "writer"> | undefined,
      });

    case "composition_get":
      return domain.getComposition(
        actor,
        String(args.projectId ?? ""),
        String(args.compositionId ?? ""),
        typeof args.revision === "number" ? args.revision : undefined,
      );

    case "composition_create":
      return domain.createComposition(actor, {
        projectId: String(args.projectId ?? ""),
        document: args.document as CompositionDocument,
        operationId: args.operationId ? String(args.operationId) : undefined,
      });

    case "composition_patch":
      return domain.patchComposition(actor, {
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
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        targetRevision: Number(args.targetRevision),
        operationId: String(args.operationId ?? ""),
      });

    case "composition_export":
      return domain.exportCompositionBundle(actor, {
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        revision: typeof args.revision === "number" ? args.revision : undefined,
        format: (args.format === "yaml" ? "yaml" : "json") as "json" | "yaml",
      });

    case "composition_import":
      return domain.importCompositionBundle(actor, {
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
        projectId: String(args.projectId ?? ""),
        compositionId: String(args.compositionId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        operations: [
          {
            op: "attach_shot_candidate",
            shotId: String(args.shotId ?? ""),
            mediaKind: (args.mediaKind ?? "videos") as "images" | "videos" | "audios",
            candidate: {
              asset: String(args.assetId ?? ""),
              actor: actor.actorId,
              ...(args.role ? { role: String(args.role) } : {}),
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
        projectId: String(args.projectId ?? ""),
        subjectId: String(args.subjectId ?? ""),
        baseRevision: Number(args.baseRevision),
        operationId: String(args.operationId ?? ""),
        changes: (args.changes ?? {}) as Record<string, unknown>,
      });

    case "subject_reference_attach":
      return domain.attachSubjectReference(actor, {
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
        projectId: String(args.projectId ?? ""),
        subjectId: String(args.subjectId ?? ""),
        revision: Number(args.revision),
        operationId: String(args.operationId ?? ""),
      });

    case "shot_subject_bind":
      return domain.patchComposition(actor, {
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
