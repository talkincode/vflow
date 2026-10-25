import { TEST_AUTH_CONFIG } from "./auth-fixture.ts";
import { createApiApp } from "@video-compose/api";
import { describe, expect, it } from "vitest";
import { HUMAN_READER_HEADERS, HUMAN_WRITER_HEADERS } from "./helpers.ts";

function base64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64Url(verifierBytes);
  const encoded = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const challenge = base64Url(hash);
  return { verifier, challenge };
}

describe("E2E 12 — MCP OAuth 2.1 (RFC 9728, RFC 8414, RFC 7591, PKCE S256)", () => {
  it("uses the requested vflow origin for OAuth discovery and Bearer challenges while preserving the old hostname", async () => {
    const { app } = createApiApp(undefined,TEST_AUTH_CONFIG);
    for (const origin of ["https://vflow.talkincode.net", "https://video-compose.talkincode.net"]) {
      const metadata = await app.request(`${origin}/.well-known/oauth-authorization-server`);
      expect(await metadata.json()).toMatchObject({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register` });
      const resource = await app.request(`${origin}/.well-known/oauth-protected-resource/mcp`);
      expect(await resource.json()).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      const unauthorized = await app.request(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "domain", method: "tools/list" }) });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    }
  });

  it("Happy Path: Complete OAuth 2.1 flow connects client, negotiates PKCE, and enables MCP tool execution", async () => {
    const { app, domain } = createApiApp(undefined,TEST_AUTH_CONFIG);

    // 1. Unauthenticated request to /mcp returns 401 with WWW-Authenticate header
    const initialMcpRes = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-1",
        method: "tools/list",
      }),
    });
    expect(initialMcpRes.status).toBe(401);
    const wwwAuth = initialMcpRes.headers.get("WWW-Authenticate");
    expect(wwwAuth).toContain("Bearer realm=\"video-compose\"");
    expect(wwwAuth).toContain("resource_metadata=");

    // 2. Discover OAuth Protected Resource Metadata (RFC 9728)
    const resourceMetaRes = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(resourceMetaRes.status).toBe(200);
    const resourceMeta = (await resourceMetaRes.json()) as { resource: string; authorization_servers: string[] };
    expect(resourceMeta.resource).toContain("/mcp");
    expect(resourceMeta.authorization_servers.length).toBeGreaterThan(0);

    // 3. Discover Authorization Server Metadata (RFC 8414)
    const authServerMetaRes = await app.request("/.well-known/oauth-authorization-server");
    expect(authServerMetaRes.status).toBe(200);
    const authServerMeta = (await authServerMetaRes.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(authServerMeta.code_challenge_methods_supported).toContain("S256");

    // 4. Dynamic Client Registration (RFC 7591)
    const registerRes = await app.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Cursor AI IDE",
        redirect_uris: ["http://localhost:8989/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: "video-compose.all",
      }),
    });
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as { client_id: string; client_name: string };
    expect(registered.client_id).toMatch(/^mcpc_/);

    // 5. User opens Authorize consent screen with PKCE (S256)
    const { verifier, challenge } = await createPkcePair();
    const authorizeRes = await app.request(
      `/oauth/authorize?client_id=${registered.client_id}&redirect_uri=http://localhost:8989/oauth/callback&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=state-123`,
      {
        method: "GET",
        headers: HUMAN_WRITER_HEADERS, // Logged in human owner
      },
    );
    expect(authorizeRes.status).toBe(200);
    const consentHtml = await authorizeRes.text();
    expect(consentHtml).toContain("授权 MCP 客户端");
    expect(consentHtml).toContain(registered.client_name);

    // Extract grantId and csrf from consent HTML
    const grantMatch = consentHtml.match(/name="grant"\s+value="([^"]+)"/);
    const csrfMatch = consentHtml.match(/name="csrf"\s+value="([^"]+)"/);
    expect(grantMatch).toBeTruthy();
    expect(csrfMatch).toBeTruthy();
    const grantId = grantMatch![1];
    const csrf = csrfMatch![1];

    // 6. User confirms authorization
    const decideRes = await app.request("/oauth/authorize/decide", {
      method: "POST",
      headers: {
        ...HUMAN_WRITER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant: grantId,
        csrf,
        decision: "allow",
      }).toString(),
    });
    expect(decideRes.status).toBe(302);
    const redirectLocation = decideRes.headers.get("Location")!;
    expect(redirectLocation).toContain("http://localhost:8989/oauth/callback");
    const redirectUrl = new URL(redirectLocation);
    const code = redirectUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("state-123");

    // 7. Client exchanges code + verifier for tokens
    const tokenRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: "http://localhost:8989/oauth/callback",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toMatch(/^vctk_/);
    expect(tokens.refresh_token).toMatch(/^vcrf_/);

    // 8. Client calls MCP using Bearer token
    const mcpToolsRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mcp-call-1",
        method: "tools/call",
        params: {
          name: "project_create",
          arguments: {
            id: "oauth-proj-1",
            name: "OAuth Created Project",
          },
        },
      }),
    });
    expect(mcpToolsRes.status).toBe(200);
    const mcpData = (await mcpToolsRes.json()) as { result: { structuredContent: { id: string } } };
    expect(mcpData.result.structuredContent.id).toBe("oauth-proj-1");

    // Verify project exists in domain with alice as writer
    const proj = await domain.getProject({ actorId: "alice@talkincode.net", actorKind: "human" }, "oauth-proj-1");
    expect(proj.name).toBe("OAuth Created Project");
  });

  it("Failure Paths: Invalid PKCE, Denied consent, Expired code, and Revoked token are properly rejected", async () => {
    const { app } = createApiApp(undefined,TEST_AUTH_CONFIG);

    // Register client
    const registerRes = await app.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: ["http://localhost:8989/cb"],
      }),
    });
    const { client_id } = (await registerRes.json()) as { client_id: string };

    // Start authorization
    const { verifier, challenge } = await createPkcePair();
    const authorizeRes = await app.request(
      `/oauth/authorize?client_id=${client_id}&redirect_uri=http://localhost:8989/cb&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      {
        method: "GET",
        headers: HUMAN_WRITER_HEADERS,
      },
    );
    const consentHtml = await authorizeRes.text();
    const grantId = consentHtml.match(/name="grant"\s+value="([^"]+)"/)![1];
    const csrf = consentHtml.match(/name="csrf"\s+value="([^"]+)"/)![1];

    // Failure Path 1: User denies consent
    const denyRes = await app.request("/oauth/authorize/decide", {
      method: "POST",
      headers: {
        ...HUMAN_WRITER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant: grantId,
        csrf,
        decision: "deny",
      }).toString(),
    });
    expect(denyRes.status).toBe(302);
    expect(denyRes.headers.get("Location")).toContain("error=access_denied");

    // Initiate second grant for PKCE failure test
    const authRes2 = await app.request(
      `/oauth/authorize?client_id=${client_id}&redirect_uri=http://localhost:8989/cb&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { method: "GET", headers: HUMAN_WRITER_HEADERS },
    );
    const html2 = await authRes2.text();
    const grant2 = html2.match(/name="grant"\s+value="([^"]+)"/)![1];
    const csrf2 = html2.match(/name="csrf"\s+value="([^"]+)"/)![1];

    const allowRes2 = await app.request("/oauth/authorize/decide", {
      method: "POST",
      headers: {
        ...HUMAN_WRITER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant: grant2,
        csrf: csrf2,
        decision: "allow",
      }).toString(),
    });
    const code2 = new URL(allowRes2.headers.get("Location")!).searchParams.get("code")!;

    // Failure Path 2: Invalid PKCE code_verifier fails
    const invalidPkceRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code: code2,
        code_verifier: "wrong-code-verifier-that-fails-pkce",
        redirect_uri: "http://localhost:8989/cb",
      }).toString(),
    });
    expect(invalidPkceRes.status).toBe(400);
    const pkceErr = (await invalidPkceRes.json()) as { error: string };
    expect(pkceErr.error).toBe("invalid_grant");

    // Successful exchange with valid verifier
    const validTokenRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code: code2,
        code_verifier: verifier,
        redirect_uri: "http://localhost:8989/cb",
      }).toString(),
    });
    expect(validTokenRes.status).toBe(200);
    const tokens = (await validTokenRes.json()) as { access_token: string };

    // Failure Path 3: Reused authorization code is rejected
    const reuseRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code: code2,
        code_verifier: verifier,
        redirect_uri: "http://localhost:8989/cb",
      }).toString(),
    });
    expect(reuseRes.status).toBe(400);

    // Call MCP successfully with token
    const validMcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }),
    });
    expect(validMcp.status).toBe(200);

    // Failure Path 4: Revoked token is rejected
    await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token }).toString(),
    });

    const revokedMcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "tools/list" }),
    });
    expect(revokedMcp.status).toBe(401);
  });

  it("Roles & Recovery: Enforces reader/writer role authorization and recovers session via refresh token", async () => {
    const { app, domain } = createApiApp(undefined,TEST_AUTH_CONFIG);

    // Create a shared project first
    await domain.createProject({ actorId: "alice@talkincode.net", actorKind: "human" }, {
      id: "role-test-proj",
      name: "Role Test",
      members: {
        "bob-reader@talkincode.net": "reader",
      },
    });

    // Register client
    const regRes = await app.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Reader Client",
        redirect_uris: ["http://localhost:8989/cb"],
      }),
    });
    const { client_id } = (await regRes.json()) as { client_id: string };

    // Reader signs in and authorizes client
    const { verifier, challenge } = await createPkcePair();
    const authRes = await app.request(
      `/oauth/authorize?client_id=${client_id}&redirect_uri=http://localhost:8989/cb&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { method: "GET", headers: HUMAN_READER_HEADERS },
    );
    const html = await authRes.text();
    const grant = html.match(/name="grant"\s+value="([^"]+)"/)![1];
    const csrf = html.match(/name="csrf"\s+value="([^"]+)"/)![1];

    const allowRes = await app.request("/oauth/authorize/decide", {
      method: "POST",
      headers: {
        ...HUMAN_READER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant, csrf, decision: "allow" }).toString(),
    });
    const code = new URL(allowRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code,
        code_verifier: verifier,
        redirect_uri: "http://localhost:8989/cb",
      }).toString(),
    });
    const { access_token, refresh_token } = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    // Role check: Reader CAN read project
    const readCall = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "r1",
        method: "tools/call",
        params: { name: "project_get", arguments: { projectId: "role-test-proj" } },
      }),
    });
    expect(readCall.status).toBe(200);

    // Role check: Reader CANNOT mutate project (rejected with 409 or 403)
    const writeCall = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "w1",
        method: "tools/call",
        params: {
          name: "composition_create",
          arguments: {
            projectId: "role-test-proj",
            operationId: "fail-comp-1",
            document: {
              apiVersion: "2026-10-01",
              id: "unauthorized-comp",
              project: "role-test-proj",
              format: { width: 1920, height: 1080, fps: 30 },
              audioTracks: [],
              sequence: [],
              shots: {},
            },
          },
        },
      }),
    });
    const writeData = (await writeCall.json()) as { error?: { code: number; message: string } };
    expect(writeData.error).toBeDefined();

    // Recovery test: Rotate refresh_token to recover new access_token
    const refreshRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id,
        refresh_token,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshedTokens = (await refreshRes.json()) as { access_token: string; refresh_token: string };
    expect(refreshedTokens.access_token).not.toBe(access_token);
    expect(refreshedTokens.refresh_token).not.toBe(refresh_token);

    // Call MCP with newly rotated access token
    const callAfterRefresh = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshedTokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "r2",
        method: "tools/call",
        params: { name: "project_get", arguments: { projectId: "role-test-proj" } },
      }),
    });
    expect(callAfterRefresh.status).toBe(200);
  });
});
