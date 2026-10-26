import {
  DomainError,
  type DomainErrorCode,
  VFlowDomainService,
} from "@vflow/domain";
import type { ActorIdentity } from "@vflow/protocol";
import { normalizeProtocolVersion } from "@vflow/protocol";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AccessAuthConfig, extractActorFromHeaders } from "./auth.ts";
import { mcpHttp } from "./mcp-http.ts";
import {
  hashToken,
  InMemoryOAuthStore,
  type McpClient,
  type McpGrant,
  type OAuthStore,
  randomToken,
  renderConsentPage,
  renderSignInPage,
  verifyPkce,
} from "./oauth.ts";

function statusForDomainError(code: DomainErrorCode): ContentfulStatusCode {
  switch (code) {
    case "RANGE_NOT_SATISFIABLE":
      return 416;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "RESOURCE_TRASHED":
      return 410;
    case "PARENT_TRASHED":
      return 409;
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
      return code === "INTERNAL_ERROR" ? 500 : 422;
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
  domain: VFlowDomainService = new VFlowDomainService(),
  authConfig?: AccessAuthConfig,
  oauthStore: OAuthStore = new InMemoryOAuthStore(),
): { app: Hono; domain: VFlowDomainService; oauthStore: OAuthStore } {
  const app = new Hono();

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, CF-Access-Client-Id, CF-Access-Client-Secret, x-agent-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  };

  async function resolveActor(headers: Headers): Promise<ActorIdentity | null> {
    const authHeader = headers.get("authorization")?.trim();
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const rawToken = authHeader.substring(7).trim();
      if (rawToken) {
        const hashed = await hashToken(rawToken);
        const token = await oauthStore.getTokenByHash(hashed);
        if (token && !token.revokedAt && token.expiresAt > Date.now()) {
          const explicitAgentId = headers.get("x-agent-id")?.trim();
          oauthStore
            .updateToken({ ...token, lastUsedAt: Date.now() })
            .catch(() => {});
          return {
            actorId: token.owner,
            actorKind: explicitAgentId ? "agent" : "human",
            userId: token.owner.trim().toLowerCase(),
          };
        }
      }
      return null;
    }
    return extractActorFromHeaders(headers, authConfig);
  }

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

  // CORS preflight for machine & OAuth endpoints
  app.options(
    "/mcp",
    () => new Response(null, { status: 204, headers: corsHeaders }),
  );
  app.options(
    "/oauth/*",
    () => new Response(null, { status: 204, headers: corsHeaders }),
  );
  app.options(
    "/.well-known/*",
    () => new Response(null, { status: 204, headers: corsHeaders }),
  );

  app.use("/v1/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Cookie, Authorization");
  });
  app.get("/v1/session", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    if (!actor)
      throw new DomainError("UNAUTHORIZED", "Authentication is required.");
    return c.json({ actor, logoutUrl: "/logout" });
  });
  app.get(
    "/logout",
    () =>
      new Response(null, {
        status: 302,
        headers: {
          Location: "/cdn-cgi/access/logout",
          "Clear-Site-Data": '"cache", "storage"',
          "Cache-Control": "no-store",
        },
      }),
  );
  app.get("/v1/trash", async (c) =>
    c.json({
      items: await domain.lifecycle.list(await resolveActor(c.req.raw.headers)),
    }),
  );
  app.delete("/v1/projects/:projectId", async (c) =>
    c.json(
      await domain.lifecycle.change(await resolveActor(c.req.raw.headers), {
        ...(await c.req.json()),
        projectId: c.req.param("projectId"),
        id: c.req.param("projectId"),
        kind: "project",
        action: "trash",
      }),
    ),
  );
  app.post("/v1/projects/:projectId/restore", async (c) =>
    c.json(
      await domain.lifecycle.change(await resolveActor(c.req.raw.headers), {
        ...(await c.req.json()),
        projectId: c.req.param("projectId"),
        id: c.req.param("projectId"),
        kind: "project",
        action: "restore",
      }),
    ),
  );
  app.delete("/v1/projects/:projectId/compositions/:compositionId", async (c) =>
    c.json(
      await domain.lifecycle.change(await resolveActor(c.req.raw.headers), {
        ...(await c.req.json()),
        projectId: c.req.param("projectId"),
        id: c.req.param("compositionId"),
        kind: "composition",
        action: "trash",
      }),
    ),
  );
  app.post(
    "/v1/projects/:projectId/compositions/:compositionId/restore-from-trash",
    async (c) =>
      c.json(
        await domain.lifecycle.change(await resolveActor(c.req.raw.headers), {
          ...(await c.req.json()),
          projectId: c.req.param("projectId"),
          id: c.req.param("compositionId"),
          kind: "composition",
          action: "restore",
        }),
      ),
  );

  // RFC 9728 Protected Resource Metadata
  const handleProtectedResource = (c: {
    req: { url: string };
    json: (
      data: unknown,
      status: ContentfulStatusCode,
      headers: Record<string, string>,
    ) => Response;
  }) => {
    const origin = new URL(c.req.url).origin;
    return c.json(
      {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: [
          "vflow.read",
          "vflow.write",
          "vflow.all",
        ],
        bearer_methods_supported: ["header"],
      },
      200,
      corsHeaders,
    );
  };
  app.get("/.well-known/oauth-protected-resource", (c) =>
    handleProtectedResource(c),
  );
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    handleProtectedResource(c),
  );

  // RFC 8414 Authorization Server Metadata
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(
      {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_post",
          "client_secret_basic",
        ],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [
          "vflow.read",
          "vflow.write",
          "vflow.all",
        ],
      },
      200,
      corsHeaders,
    );
  });

  // RFC 7591 Dynamic Client Registration
  app.post("/oauth/register", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: "Invalid JSON body",
        },
        400,
        corsHeaders,
      );
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as string[])
      : [];
    if (redirectUris.length === 0) {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: "redirect_uris is required",
        },
        400,
        corsHeaders,
      );
    }
    const clientId = `mcpc_${randomToken(16)}`;
    const clientName = String(body.client_name || "MCP Client").slice(0, 60);
    const authMethod = String(body.token_endpoint_auth_method || "none");
    let secret: string | undefined;
    let secretHash: string | undefined;
    if (authMethod !== "none") {
      secret = randomToken(32);
      secretHash = await hashToken(secret);
    }
    const client: McpClient = {
      id: clientId,
      name: clientName,
      redirectUris,
      grantTypes:
        Array.isArray(body.grant_types) && body.grant_types.length > 0
          ? (body.grant_types as string[])
          : ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scope: String(body.scope || "vflow.all"),
      authMethod,
      secretHash,
      disabled: false,
      createdAt: Date.now(),
    };
    await oauthStore.createClient(client);
    return c.json(
      {
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        token_endpoint_auth_method: client.authMethod,
        scope: client.scope,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        ...(secret
          ? { client_secret: secret, client_secret_expires_at: 0 }
          : {}),
      },
      201,
      corsHeaders,
    );
  });

  // RFC 8414 / OAuth 2.1 Authorize consent screen
  app.get("/oauth/authorize", async (c) => {
    const clientId = c.req.query("client_id")?.trim();
    const redirectUri = c.req.query("redirect_uri")?.trim();
    const responseType = c.req.query("response_type")?.trim();
    const codeChallenge = c.req.query("code_challenge")?.trim();
    const codeChallengeMethod = c.req.query("code_challenge_method")?.trim();
    const state = c.req.query("state")?.trim();
    const scope = c.req.query("scope")?.trim();
    const resource = c.req.query("resource")?.trim();

    if (!clientId) {
      return c.text("Missing client_id parameter", 400);
    }
    const client = await oauthStore.getClient(clientId);
    if (!client || client.disabled) {
      return c.text("Unknown or disabled client_id", 400);
    }
    const finalRedirectUri =
      redirectUri ||
      (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
    if (!finalRedirectUri || !client.redirectUris.includes(finalRedirectUri)) {
      return c.text("Invalid or unregistered redirect_uri", 400);
    }
    if (responseType !== "code") {
      const u = new URL(finalRedirectUri);
      u.searchParams.set("error", "unsupported_response_type");
      if (state) u.searchParams.set("state", state);
      return c.redirect(u.toString(), 302);
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      const u = new URL(finalRedirectUri);
      u.searchParams.set("error", "invalid_request");
      u.searchParams.set(
        "error_description",
        "PKCE with code_challenge_method=S256 is required",
      );
      if (state) u.searchParams.set("state", state);
      return c.redirect(u.toString(), 302);
    }

    const actor = await resolveActor(c.req.raw.headers);
    if (!actor) {
      return c.html(renderSignInPage(c.req.url), 401);
    }

    const grant: McpGrant = {
      id: `mcpgr_${randomToken(16)}`,
      clientId: client.id,
      redirectUri: finalRedirectUri,
      owner: actor.actorId,
      scope: scope || client.scope || "vflow.all",
      state,
      resource,
      codeChallenge,
      codeChallengeMethod: "S256",
      csrf: randomToken(16),
      approved: false,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now(),
    };
    await oauthStore.createGrant(grant);

    return c.html(
      renderConsentPage({
        grantId: grant.id,
        clientName: client.name,
        scope: grant.scope,
        ownerEmail: actor.actorId,
        csrf: grant.csrf,
      }),
    );
  });

  // User consent decision endpoint
  app.post("/oauth/authorize/decide", async (c) => {
    const body = await c.req.parseBody();
    const grantId = String(body.grant || "").trim();
    const csrf = String(body.csrf || "").trim();
    const decision = String(body.decision || "").trim();

    const grant = await oauthStore.getGrant(grantId);
    if (
      !grant ||
      grant.expiresAt < Date.now() ||
      grant.approved ||
      grant.usedAt
    ) {
      return c.text("Authorization request expired or already processed", 400);
    }
    if (!csrf || csrf !== grant.csrf) {
      return c.text("Invalid CSRF verification token", 403);
    }
    const actor = await resolveActor(c.req.raw.headers);
    if (!actor || actor.actorId !== grant.owner) {
      return c.text(
        "Please sign in as the owner who initiated the authorization",
        403,
      );
    }

    const redirectUrl = new URL(grant.redirectUri);
    if (decision !== "allow") {
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set(
        "error_description",
        "User denied authorization",
      );
      if (grant.state) redirectUrl.searchParams.set("state", grant.state);
      return c.redirect(redirectUrl.toString(), 302);
    }

    const code = randomToken(32);
    grant.codeHash = await hashToken(code);
    grant.approved = true;
    grant.expiresAt = Date.now() + 5 * 60 * 1000;
    await oauthStore.updateGrant(grant);

    redirectUrl.searchParams.set("code", code);
    if (grant.state) redirectUrl.searchParams.set("state", grant.state);
    redirectUrl.searchParams.set("iss", new URL(c.req.url).origin);
    return c.redirect(redirectUrl.toString(), 302);
  });

  // RFC 6749 Token Exchange
  app.post("/oauth/token", async (c) => {
    let body: Record<string, string> = {};
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      body =
        ((await c.req.json().catch(() => ({}))) as Record<string, string>) ||
        {};
    } else {
      const parsed = await c.req.parseBody().catch(() => ({}));
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") body[k] = v;
      }
    }

    const grantType = body.grant_type;
    let clientId = body.client_id;
    let clientSecret = body.client_secret;

    const authHeader = c.req.header("authorization") || "";
    if (authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const credentials = atob(authHeader.substring(6)).split(":");
        clientId = decodeURIComponent(credentials[0] || "");
        clientSecret = decodeURIComponent(credentials[1] || "");
      } catch {
        // ignore malformed basic header
      }
    }

    if (!clientId) {
      return c.json(
        { error: "invalid_client", error_description: "Missing client_id" },
        400,
        corsHeaders,
      );
    }

    const client = await oauthStore.getClient(clientId);
    if (!client || client.disabled) {
      return c.json(
        {
          error: "invalid_client",
          error_description: "Unknown or disabled client",
        },
        401,
        corsHeaders,
      );
    }

    if (client.authMethod !== "none") {
      if (!clientSecret) {
        return c.json(
          {
            error: "invalid_client",
            error_description: "Missing client_secret",
          },
          401,
          corsHeaders,
        );
      }
      const hashedSecret = await hashToken(clientSecret);
      if (hashedSecret !== client.secretHash) {
        return c.json(
          {
            error: "invalid_client",
            error_description: "Invalid client credentials",
          },
          401,
          corsHeaders,
        );
      }
    }

    if (grantType === "authorization_code") {
      const code = body.code?.trim();
      const codeVerifier = body.code_verifier?.trim();
      const redirectUri = body.redirect_uri?.trim();

      if (!code || !codeVerifier) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "Missing code or code_verifier",
          },
          400,
          corsHeaders,
        );
      }

      const codeHash = await hashToken(code);
      const grant = await oauthStore.getGrantByCodeHash(codeHash);
      if (
        !grant ||
        !grant.approved ||
        grant.usedAt ||
        grant.expiresAt < Date.now()
      ) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Authorization code invalid or expired",
          },
          400,
          corsHeaders,
        );
      }

      if (redirectUri && grant.redirectUri !== redirectUri) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "redirect_uri mismatch",
          },
          400,
          corsHeaders,
        );
      }

      const validPkce = await verifyPkce(
        codeVerifier,
        grant.codeChallenge,
        grant.codeChallengeMethod,
      );
      if (!validPkce) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "PKCE verification failed",
          },
          400,
          corsHeaders,
        );
      }

      grant.usedAt = Date.now();
      await oauthStore.updateGrant(grant);

      const rawAccessToken = `vctk_${randomToken(32)}`;
      const rawRefreshToken = `vcrf_${randomToken(32)}`;
      const tokenHash = await hashToken(rawAccessToken);
      const refreshTokenHash = await hashToken(rawRefreshToken);
      const now = Date.now();

      await oauthStore.createToken({
        id: `mcptk_${randomToken(16)}`,
        clientId: grant.clientId,
        kind: "access",
        tokenHash,
        scopes: grant.scope,
        resource: grant.resource || "",
        owner: grant.owner,
        expiresAt: now + 3600 * 1000,
        createdAt: now,
      });

      await oauthStore.createToken({
        id: `mcptk_${randomToken(16)}`,
        clientId: grant.clientId,
        kind: "refresh",
        tokenHash: refreshTokenHash,
        scopes: grant.scope,
        resource: grant.resource || "",
        owner: grant.owner,
        expiresAt: now + 30 * 86400 * 1000,
        createdAt: now,
      });

      return c.json(
        {
          access_token: rawAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: rawRefreshToken,
          scope: grant.scope,
        },
        200,
        corsHeaders,
      );
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token?.trim();
      if (!refreshToken) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "Missing refresh_token",
          },
          400,
          corsHeaders,
        );
      }

      const hashed = await hashToken(refreshToken);
      const oldToken = await oauthStore.getTokenByHash(hashed);
      if (
        !oldToken ||
        oldToken.kind !== "refresh" ||
        oldToken.revokedAt ||
        oldToken.expiresAt < Date.now() ||
        oldToken.clientId !== client.id
      ) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token invalid, revoked, or expired",
          },
          400,
          corsHeaders,
        );
      }

      await oauthStore.revokeToken(hashed);

      const rawAccessToken = `vctk_${randomToken(32)}`;
      const rawRefreshToken = `vcrf_${randomToken(32)}`;
      const tokenHash = await hashToken(rawAccessToken);
      const refreshTokenHash = await hashToken(rawRefreshToken);
      const now = Date.now();

      await oauthStore.createToken({
        id: `mcptk_${randomToken(16)}`,
        clientId: oldToken.clientId,
        kind: "access",
        tokenHash,
        scopes: oldToken.scopes,
        resource: oldToken.resource,
        owner: oldToken.owner,
        expiresAt: now + 3600 * 1000,
        createdAt: now,
      });

      await oauthStore.createToken({
        id: `mcptk_${randomToken(16)}`,
        clientId: oldToken.clientId,
        kind: "refresh",
        tokenHash: refreshTokenHash,
        scopes: oldToken.scopes,
        resource: oldToken.resource,
        owner: oldToken.owner,
        expiresAt: now + 30 * 86400 * 1000,
        createdAt: now,
      });

      return c.json(
        {
          access_token: rawAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: rawRefreshToken,
          scope: oldToken.scopes,
        },
        200,
        corsHeaders,
      );
    }

    return c.json(
      {
        error: "unsupported_grant_type",
        error_description:
          "Only authorization_code and refresh_token are supported",
      },
      400,
      corsHeaders,
    );
  });

  // RFC 7009 Token Revocation
  app.post("/oauth/revoke", async (c) => {
    let body: Record<string, string> = {};
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      body =
        ((await c.req.json().catch(() => ({}))) as Record<string, string>) ||
        {};
    } else {
      const parsed = await c.req.parseBody().catch(() => ({}));
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") body[k] = v;
      }
    }
    const token = body.token?.trim();
    if (token) {
      const hashed = await hashToken(token);
      await oauthStore.revokeToken(hashed);
    }
    return c.json({ revoked: true }, 200, corsHeaders);
  });

  // Remote MCP endpoint over authenticated Streamable HTTP
  app.post("/mcp", async (c) =>
    mcpHttp(
      c.req.raw,
      domain,
      await resolveActor(c.req.raw.headers),
      corsHeaders,
    ),
  );
  app.on(
    ["GET", "DELETE", "PUT", "PATCH"],
    "/mcp",
    () =>
      new Response(null, {
        status: 405,
        headers: {
          ...corsHeaders,
          Allow: "POST, OPTIONS",
          "Cache-Control": "no-store",
        },
      }),
  );

  app.get("/v1/projects/:projectId/authoring/workflow", async (c) =>
    c.json(
      await domain.authoring.workflow(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
        c.req.query("language") === "en" ? "en" : "zh",
      ),
    ),
  );
  app.get("/v1/projects/:projectId/authoring/impact/:id/:revision", async (c) =>
    c.json(
      await domain.authoring.impact(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
        { id: c.req.param("id"), revision: Number(c.req.param("revision")) },
      ),
    ),
  );
  app.get("/v1/projects/:projectId/authoring/documents", async (c) =>
    c.json(
      await domain.authoring.list(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
      ),
    ),
  );
  app.get("/v1/projects/:projectId/authoring/documents/:id", async (c) =>
    c.json(
      await domain.authoring.get(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
        c.req.param("id"),
        c.req.query("revision") === undefined
          ? undefined
          : Number(c.req.query("revision")),
      ),
    ),
  );
  app.post("/v1/projects/:projectId/authoring/documents", async (c) =>
    c.json(
      await domain.authoring.put(await resolveActor(c.req.raw.headers), {
        ...(await c.req.json()),
        projectId: c.req.param("projectId"),
      }),
      201,
    ),
  );
  app.post(
    "/v1/projects/:projectId/authoring/documents/:id/review",
    async (c) =>
      c.json(
        await domain.authoring.review(await resolveActor(c.req.raw.headers), {
          ...(await c.req.json()),
          projectId: c.req.param("projectId"),
          id: c.req.param("id"),
        }),
      ),
  );
  app.post(
    "/v1/projects/:projectId/authoring/documents/:id/approve",
    async (c) =>
      c.json(
        await domain.authoring.approve(await resolveActor(c.req.raw.headers), {
          ...(await c.req.json()),
          projectId: c.req.param("projectId"),
          id: c.req.param("id"),
        }),
      ),
  );
  app.post("/v1/projects/:projectId/authoring/validate", async (c) =>
    c.json(
      await domain.authoring.validate(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
        (await c.req.json()).document,
      ),
    ),
  );
  app.post("/v1/projects/:projectId/authoring/prepare", async (c) => {
    const body = await c.req.json();
    return c.json(
      await domain.authoring.prepare(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
        body.request,
        body.workflowContext,
      ),
    );
  });
  app.get("/v1/projects/:projectId/authoring/evidence", async (c) =>
    c.json(
      await domain.authoring.evidence(
        await resolveActor(c.req.raw.headers),
        c.req.param("projectId"),
      ),
    ),
  );
  app.post("/v1/projects/:projectId/authoring/evidence", async (c) =>
    c.json(
      await domain.authoring.recordEvidence(
        await resolveActor(c.req.raw.headers),
        { ...(await c.req.json()), projectId: c.req.param("projectId") },
      ),
      201,
    ),
  );

  // REST /v1/projects
  app.get("/v1/projects", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const projects = await domain.listProjects(actor);
    return c.json({ projects });
  });

  app.post("/v1/projects", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const project = await domain.createProject(actor, body);
    return c.json({ project }, 201);
  });

  app.get("/v1/projects/:projectId", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const project = await domain.getProject(actor, c.req.param("projectId"));
    return c.json({ project });
  });

  app.get("/v1/projects/:projectId/access", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    return c.json(
      await domain.getProjectAccess(actor, c.req.param("projectId")),
    );
  });

  app.get("/v1/projects/:projectId/overview", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    return c.json(
      await domain.getProjectOverview(actor, c.req.param("projectId")),
    );
  });

  app.put("/v1/projects/:projectId/members/:targetActorId", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const project = await domain.setProjectMemberRole(actor, {
      baseRevision: body.baseRevision,
      operationId: body.operationId,
      projectId: c.req.param("projectId"),
      targetActorId: c.req.param("targetActorId"),
      role: body.role ?? null,
    });
    return c.json({ project });
  });

  // REST /v1/projects/:projectId/assets
  app.get("/v1/projects/:projectId/assets", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
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
      const actor = await resolveActor(c.req.raw.headers);
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
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const session = await domain.prepareAssetUpload(actor, {
      ...body,
      projectId: c.req.param("projectId"),
    });
    return c.json({ session }, 201);
  });

  app.put("/v1/projects/:projectId/assets/upload/:sessionId", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
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
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const asset = await domain.finalizeAssetUpload(actor, {
      projectId: c.req.param("projectId"),
      sessionId: String(body.sessionId ?? ""),
    });
    return c.json({ asset }, 201);
  });

  app.delete("/v1/projects/:projectId/assets/:assetId", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const result = await domain.deleteAsset(
      actor,
      c.req.param("projectId"),
      c.req.param("assetId"),
    );
    return c.json(result);
  });

  // REST /v1/projects/:projectId/subjects
  app.get("/v1/projects/:projectId/subjects", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const kind = c.req.query("kind") as "character" | "prop" | undefined;
    const subjects = await domain.listSubjects(
      actor,
      c.req.param("projectId"),
      kind,
    );
    return c.json({ subjects });
  });

  app.post("/v1/projects/:projectId/subjects", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const subject = await domain.createSubject(actor, {
      ...body,
      projectId: c.req.param("projectId"),
    });
    return c.json({ subject }, 201);
  });

  app.get("/v1/projects/:projectId/subjects/:subjectId", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
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
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const snapshot = await domain.patchSubject(actor, {
      workflowContext: body.workflowContext,
      projectId: c.req.param("projectId"),
      subjectId: c.req.param("subjectId"),
      baseRevision: Number(body.baseRevision),
      operationId: String(body.operationId ?? ""),
      changes: body.changes ?? {},
    });
    return c.json({ snapshot });
  });

  app.post(
    "/v1/projects/:projectId/subjects/:subjectId/references",
    async (c) => {
      const actor = await resolveActor(c.req.raw.headers);
      const body = await c.req.json();
      const snapshot = await domain.attachSubjectReference(actor, {
        workflowContext: body.workflowContext,
        projectId: c.req.param("projectId"),
        subjectId: c.req.param("subjectId"),
        baseRevision: Number(body.baseRevision),
        operationId: String(body.operationId ?? ""),
        variant: String(body.variant ?? ""),
        entry: body.entry,
      });
      return c.json({ snapshot }, 201);
    },
  );

  app.post("/v1/projects/:projectId/subjects/:subjectId/approve", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const snapshot = await domain.approveSubjectRevision(actor, {
      workflowContext: body.workflowContext,
      projectId: c.req.param("projectId"),
      subjectId: c.req.param("subjectId"),
      revision: Number(body.revision),
      operationId: String(body.operationId ?? ""),
    });
    return c.json({ snapshot });
  });

  app.get("/v1/projects/:projectId/subjects/:subjectId/usage", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const usage = await domain.getSubjectUsage(
      actor,
      c.req.param("projectId"),
      c.req.param("subjectId"),
    );
    return c.json({ usage });
  });

  // REST /v1/projects/:projectId/compositions
  app.get("/v1/projects/:projectId/compositions", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const compositions = await domain.listCompositions(
      actor,
      c.req.param("projectId"),
    );
    return c.json({ compositions });
  });

  app.post("/v1/projects/:projectId/compositions", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const revisionRecord = await domain.createComposition(actor, {
      workflowContext: body.workflowContext,
      projectId: c.req.param("projectId"),
      document: body.document,
      operationId: body.operationId,
    });
    return c.json({ revisionRecord }, 201);
  });

  app.post("/v1/projects/:projectId/compositions/import", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const body = await c.req.json();
    const revisionRecord = await domain.importCompositionBundle(actor, {
      baseRevision: body.baseRevision,
      workflowContext: body.workflowContext,
      projectId: c.req.param("projectId"),
      payload: String(body.payload ?? ""),
      format: body.format === "yaml" ? "yaml" : "json",
      targetCompositionId: body.targetCompositionId,
      operationId: body.operationId,
    });
    return c.json({ revisionRecord }, 201);
  });

  app.get("/v1/projects/:projectId/compositions/:compositionId", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const revParam = c.req.query("revision");
    const result = await domain.getComposition(
      actor,
      c.req.param("projectId"),
      c.req.param("compositionId"),
      revParam ? Number(revParam) : undefined,
    );
    return c.json(result);
  });

  app.patch(
    "/v1/projects/:projectId/compositions/:compositionId",
    async (c) => {
      const actor = await resolveActor(c.req.raw.headers);
      const body = await c.req.json();
      const result = await domain.patchComposition(actor, {
        workflowContext: body.workflowContext,
        projectId: c.req.param("projectId"),
        compositionId: c.req.param("compositionId"),
        baseRevision: Number(body.baseRevision),
        operationId: String(body.operationId ?? ""),
        operations: body.operations ?? [],
        message: body.message,
      });
      return c.json(result);
    },
  );

  app.get(
    "/v1/projects/:projectId/compositions/:compositionId/history",
    async (c) => {
      const actor = await resolveActor(c.req.raw.headers);
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
      const actor = await resolveActor(c.req.raw.headers);
      const body = await c.req.json();
      const revisionRecord = await domain.restoreCompositionRevision(actor, {
        workflowContext: body.workflowContext,
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
      const actor = await resolveActor(c.req.raw.headers);
      const format = c.req.query("format") === "yaml" ? "yaml" : "json";
      const revParam = c.req.query("revision");
      const exported = await domain.exportCompositionBundle(actor, {
        projectId: c.req.param("projectId"),
        compositionId: c.req.param("compositionId"),
        revision: revParam ? Number(revParam) : undefined,
        format,
        targetVersion: normalizeProtocolVersion(c.req.query("targetVersion")),
      });
      return c.json(exported);
    },
  );

  // REST /v1/projects/:projectId/proposals
  app.get("/v1/projects/:projectId/proposals", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
    const compositionId = c.req.query("compositionId");
    const proposals = await domain.listProposals(
      actor,
      c.req.param("projectId"),
      compositionId,
    );
    return c.json({ proposals });
  });

  app.post("/v1/projects/:projectId/proposals", async (c) => {
    const actor = await resolveActor(c.req.raw.headers);
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

  app.post(
    "/v1/projects/:projectId/proposals/:proposalId/approve",
    async (c) => {
      const actor = await resolveActor(c.req.raw.headers);
      const body = await c.req.json();
      const result = await domain.approveProposal(actor, {
        workflowContext: body.workflowContext,
        projectId: c.req.param("projectId"),
        proposalId: c.req.param("proposalId"),
        operationId: String(body.operationId ?? ""),
      });
      return c.json(result);
    },
  );

  return { app, domain, oauthStore };
}
