import {
  DomainError,
  type DomainErrorCode,
  VideoComposeDomainService,
} from "@video-compose/domain";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AccessAuthConfig, extractActorFromHeaders } from "./auth.ts";
import { handleMcpJsonRpc, type JsonRpcRequest } from "./mcp.ts";

function statusForDomainError(code: DomainErrorCode): ContentfulStatusCode {
  switch (code) {
    case "RANGE_NOT_SATISFIABLE":
      return 416;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
    case "REVISION_CONFLICT":
    case "IMMUTABILITY_VIOLATION":
    case "DEPENDENCY_ERROR":
      return 409;
    case "VALIDATION_FAILED":
    case "ASSET_INTEGRITY_ERROR":
      return 422;
    case "INTERNAL_ERROR":
    default:
      return 500;
  }
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createApiApp(
  domain: VideoComposeDomainService = new VideoComposeDomainService(),
  authConfig?: AccessAuthConfig,
): { app: Hono; domain: VideoComposeDomainService } {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ?? {}),
          },
        },
        statusForDomainError(err.code),
      );
    }
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      500,
    );
  });

  // Remote MCP endpoint over authenticated Streamable HTTP
  app.post("/mcp", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const rpc = (await c.req.json()) as JsonRpcRequest;
    const response = await handleMcpJsonRpc(domain, actor, rpc);
    const status = response.error?.code === -32001 ? 401 : 200;
    return c.json(response, status);
  });

  // REST /v1/projects
  app.get("/v1/projects", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const projects = await domain.listProjects(actor);
    return c.json({ projects });
  });

  app.post("/v1/projects", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const project = await domain.createProject(actor, body);
    return c.json({ project }, 201);
  });

  app.get("/v1/projects/:projectId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const project = await domain.getProject(actor, c.req.param("projectId"));
    return c.json({ project });
  });

  app.get("/v1/projects/:projectId/access", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    return c.json(
      await domain.getProjectAccess(actor, c.req.param("projectId")),
    );
  });

  app.get("/v1/projects/:projectId/overview", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    return c.json(await domain.getProjectOverview(actor, c.req.param("projectId")));
  });

  app.put("/v1/projects/:projectId/members/:targetActorId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const project = await domain.setProjectMemberRole(actor, {
      projectId: c.req.param("projectId"),
      targetActorId: c.req.param("targetActorId"),
      role: body.role ?? null,
    });
    return c.json({ project });
  });

  // REST /v1/projects/:projectId/assets
  app.get("/v1/projects/:projectId/assets", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const mimePrefix = c.req.query("mimePrefix");
    const assets = await domain.listAssets(
      actor,
      c.req.param("projectId"),
      mimePrefix ? { mimePrefix } : undefined,
    );
    return c.json({ assets });
  });

  app.on(
    ["GET", "HEAD"],
    "/v1/projects/:projectId/assets/:assetId/content",
    async (c) => {
      const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
      const projectId = c.req.param("projectId");
      const assetId = c.req.param("assetId");
      const rawRange = c.req.header("Range");
      const match = rawRange?.match(/^bytes=(\d*)-(\d*)$/);
      if (rawRange && (!match || (!match[1] && !match[2]))) {
        const asset = await domain.getAsset(actor, projectId, assetId);
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${asset.sizeBytes}`,
            "Cache-Control": "private, no-store",
          },
        });
      }
      const range = match
        ? match[1]
          ? {
              start: Number(match[1]),
              ...(match[2] ? { end: Number(match[2]) } : {}),
            }
          : { suffix: Number(match[2]) }
        : undefined;
      try {
        const content = await domain.getAssetContent(
          actor,
          projectId,
          assetId,
          { range, head: c.req.method === "HEAD" },
        );
        const inline =
          /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|x-wav|flac|aac))$/i.test(
            content.asset.mimeType,
          );
        const headers = new Headers({
          "Content-Type": content.asset.mimeType,
          "Content-Length": String(
            content.range?.length ?? content.asset.sizeBytes,
          ),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": inline ? "inline" : "attachment",
          "Content-Security-Policy": "sandbox; default-src 'none'",
          ETag: `"${content.asset.sha256}"`,
        });
        if (content.range)
          headers.set(
            "Content-Range",
            `bytes ${content.range.offset}-${content.range.offset + content.range.length - 1}/${content.asset.sizeBytes}`,
          );
        return new Response(content.body, {
          status: content.range ? 206 : 200,
          headers,
        });
      } catch (error) {
        if (
          error instanceof DomainError &&
          error.code === "RANGE_NOT_SATISFIABLE"
        ) {
          return new Response(null, {
            status: 416,
            headers: {
              "Content-Range": `bytes */${error.details?.sizeBytes}`,
              "Cache-Control": "private, no-store",
            },
          });
        }
        throw error;
      }
    },
  );

  app.post("/v1/projects/:projectId/assets/prepare", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const session = await domain.prepareAssetUpload(actor, {
      ...body,
      projectId: c.req.param("projectId"),
    });
    return c.json({ session }, 201);
  });

  app.put("/v1/projects/:projectId/assets/upload/:sessionId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const contentType = c.req.header("content-type") ?? "";
    let bytes: Uint8Array;
    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      bytes = decodeBase64Bytes(String(body.contentBase64 ?? ""));
    } else {
      const ab = await c.req.arrayBuffer();
      bytes = new Uint8Array(ab);
    }
    await domain.putUploadSessionBytes(actor, {
      projectId: c.req.param("projectId"),
      sessionId: c.req.param("sessionId"),
      bytes,
    });
    return c.json({ uploaded: true });
  });

  app.post("/v1/projects/:projectId/assets/finalize", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const asset = await domain.finalizeAssetUpload(actor, {
      projectId: c.req.param("projectId"),
      sessionId: String(body.sessionId ?? ""),
    });
    return c.json({ asset }, 201);
  });

  app.delete("/v1/projects/:projectId/assets/:assetId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const result = await domain.deleteAsset(
      actor,
      c.req.param("projectId"),
      c.req.param("assetId"),
    );
    return c.json(result);
  });

  // REST /v1/projects/:projectId/subjects
  app.get("/v1/projects/:projectId/subjects", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const kind = c.req.query("kind") as "character" | "prop" | undefined;
    const subjects = await domain.listSubjects(
      actor,
      c.req.param("projectId"),
      kind,
    );
    return c.json({ subjects });
  });

  app.post("/v1/projects/:projectId/subjects", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const subject = await domain.createSubject(actor, {
      ...body,
      projectId: c.req.param("projectId"),
    });
    return c.json({ subject }, 201);
  });

  app.get("/v1/projects/:projectId/subjects/:subjectId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const revParam = c.req.query("revision");
    const result = await domain.getSubject(
      actor,
      c.req.param("projectId"),
      c.req.param("subjectId"),
      revParam ? Number(revParam) : undefined,
    );
    return c.json(result);
  });

  app.patch("/v1/projects/:projectId/subjects/:subjectId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const snapshot = await domain.patchSubject(actor, {
      projectId: c.req.param("projectId"),
      subjectId: c.req.param("subjectId"),
      baseRevision: Number(body.baseRevision),
      operationId: String(body.operationId ?? ""),
      changes: body.changes ?? {},
    });
    return c.json({ snapshot });
  });

  app.post("/v1/projects/:projectId/subjects/:subjectId/references", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const snapshot = await domain.attachSubjectReference(actor, {
      projectId: c.req.param("projectId"),
      subjectId: c.req.param("subjectId"),
      baseRevision: Number(body.baseRevision),
      operationId: String(body.operationId ?? ""),
      variant: String(body.variant ?? ""),
      entry: body.entry,
    });
    return c.json({ snapshot }, 201);
  });

  app.post("/v1/projects/:projectId/subjects/:subjectId/approve", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const snapshot = await domain.approveSubjectRevision(actor, {
      projectId: c.req.param("projectId"),
      subjectId: c.req.param("subjectId"),
      revision: Number(body.revision),
      operationId: String(body.operationId ?? ""),
    });
    return c.json({ snapshot });
  });

  app.get("/v1/projects/:projectId/subjects/:subjectId/usage", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const usage = await domain.getSubjectUsage(
      actor,
      c.req.param("projectId"),
      c.req.param("subjectId"),
    );
    return c.json({ usage });
  });

  // REST /v1/projects/:projectId/compositions
  app.get("/v1/projects/:projectId/compositions", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const compositions = await domain.listCompositions(
      actor,
      c.req.param("projectId"),
    );
    return c.json({ compositions });
  });

  app.post("/v1/projects/:projectId/compositions", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const revisionRecord = await domain.createComposition(actor, {
      projectId: c.req.param("projectId"),
      document: body.document,
      operationId: body.operationId,
    });
    return c.json({ revisionRecord }, 201);
  });

  app.post("/v1/projects/:projectId/compositions/import", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const revisionRecord = await domain.importCompositionBundle(actor, {
      projectId: c.req.param("projectId"),
      payload: String(body.payload ?? ""),
      format: body.format === "yaml" ? "yaml" : "json",
      targetCompositionId: body.targetCompositionId,
      operationId: body.operationId,
    });
    return c.json({ revisionRecord }, 201);
  });

  app.get("/v1/projects/:projectId/compositions/:compositionId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const revParam = c.req.query("revision");
    const result = await domain.getComposition(
      actor,
      c.req.param("projectId"),
      c.req.param("compositionId"),
      revParam ? Number(revParam) : undefined,
    );
    return c.json(result);
  });

  app.patch("/v1/projects/:projectId/compositions/:compositionId", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const result = await domain.patchComposition(actor, {
      projectId: c.req.param("projectId"),
      compositionId: c.req.param("compositionId"),
      baseRevision: Number(body.baseRevision),
      operationId: String(body.operationId ?? ""),
      operations: body.operations ?? [],
      message: body.message,
    });
    return c.json(result);
  });

  app.get(
    "/v1/projects/:projectId/compositions/:compositionId/history",
    async (c) => {
      const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
      const history = await domain.listCompositionHistory(
        actor,
        c.req.param("projectId"),
        c.req.param("compositionId"),
      );
      return c.json(history);
    },
  );

  app.post(
    "/v1/projects/:projectId/compositions/:compositionId/restore",
    async (c) => {
      const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
      const body = await c.req.json();
      const revisionRecord = await domain.restoreCompositionRevision(actor, {
        projectId: c.req.param("projectId"),
        compositionId: c.req.param("compositionId"),
        targetRevision: Number(body.targetRevision),
        operationId: String(body.operationId ?? ""),
      });
      return c.json({ revisionRecord });
    },
  );

  app.get(
    "/v1/projects/:projectId/compositions/:compositionId/export",
    async (c) => {
      const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
      const format = c.req.query("format") === "yaml" ? "yaml" : "json";
      const revParam = c.req.query("revision");
      const exported = await domain.exportCompositionBundle(actor, {
        projectId: c.req.param("projectId"),
        compositionId: c.req.param("compositionId"),
        revision: revParam ? Number(revParam) : undefined,
        format,
      });
      return c.json(exported);
    },
  );

  // REST /v1/projects/:projectId/proposals
  app.get("/v1/projects/:projectId/proposals", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const compositionId = c.req.query("compositionId");
    const proposals = await domain.listProposals(
      actor,
      c.req.param("projectId"),
      compositionId,
    );
    return c.json({ proposals });
  });

  app.post("/v1/projects/:projectId/proposals", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const proposal = await domain.submitProposal(actor, {
      projectId: c.req.param("projectId"),
      compositionId: String(body.compositionId ?? ""),
      baseRevision: Number(body.baseRevision),
      operationId: String(body.operationId ?? ""),
      description: String(body.description ?? ""),
      operations: body.operations ?? [],
    });
    return c.json({ proposal }, 201);
  });

  app.post("/v1/projects/:projectId/proposals/:proposalId/approve", async (c) => {
    const actor = extractActorFromHeaders(c.req.raw.headers, authConfig);
    const body = await c.req.json();
    const result = await domain.approveProposal(actor, {
      projectId: c.req.param("projectId"),
      proposalId: c.req.param("proposalId"),
      operationId: String(body.operationId ?? ""),
    });
    return c.json(result);
  });

  return { app, domain };
}
