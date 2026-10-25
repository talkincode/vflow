import type { CloudflareD1DatabaseLike } from "@video-compose/domain";

export interface McpClient {
  id: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
  authMethod: string; // "none" | "client_secret_post" | "client_secret_basic"
  secretHash?: string;
  owner?: string;
  disabled: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

export interface McpGrant {
  id: string;
  clientId: string;
  redirectUri: string;
  owner: string;
  scope: string;
  state?: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: string; // "S256"
  codeHash?: string;
  csrf: string;
  approved: boolean;
  expiresAt: number;
  createdAt: number;
  usedAt?: number;
}

export interface McpToken {
  id: string;
  clientId: string;
  kind: "access" | "refresh";
  tokenHash: string;
  scopes: string;
  resource: string;
  owner: string;
  expiresAt: number;
  revokedAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface OAuthStore {
  getClient(id: string): Promise<McpClient | null>;
  createClient(client: McpClient): Promise<void>;
  updateClient(client: McpClient): Promise<void>;
  createGrant(grant: McpGrant): Promise<void>;
  getGrant(id: string): Promise<McpGrant | null>;
  getGrantByCodeHash(codeHash: string): Promise<McpGrant | null>;
  updateGrant(grant: McpGrant): Promise<void>;
  createToken(token: McpToken): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<McpToken | null>;
  updateToken(token: McpToken): Promise<void>;
  revokeToken(tokenHash: string): Promise<void>;
}

export function base64Url(buffer: ArrayBuffer | Uint8Array): string {
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

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPkce(
  verifier: string,
  challenge: string,
  method = "S256",
): Promise<boolean> {
  if (method !== "S256") {
    return false;
  }
  const encoded = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const calculatedChallenge = base64Url(hash);
  return calculatedChallenge === challenge;
}

export class InMemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, McpClient>();
  private grants = new Map<string, McpGrant>();
  private grantsByCode = new Map<string, McpGrant>();
  private tokens = new Map<string, McpToken>();

  async getClient(id: string): Promise<McpClient | null> {
    return this.clients.get(id) ?? null;
  }

  async createClient(client: McpClient): Promise<void> {
    this.clients.set(client.id, { ...client });
  }

  async updateClient(client: McpClient): Promise<void> {
    this.clients.set(client.id, { ...client });
  }

  async createGrant(grant: McpGrant): Promise<void> {
    this.grants.set(grant.id, { ...grant });
    if (grant.codeHash) {
      this.grantsByCode.set(grant.codeHash, { ...grant });
    }
  }

  async getGrant(id: string): Promise<McpGrant | null> {
    return this.grants.get(id) ?? null;
  }

  async getGrantByCodeHash(codeHash: string): Promise<McpGrant | null> {
    return this.grantsByCode.get(codeHash) ?? null;
  }

  async updateGrant(grant: McpGrant): Promise<void> {
    this.grants.set(grant.id, { ...grant });
    if (grant.codeHash) {
      this.grantsByCode.set(grant.codeHash, { ...grant });
    }
  }

  async createToken(token: McpToken): Promise<void> {
    this.tokens.set(token.tokenHash, { ...token });
  }

  async getTokenByHash(tokenHash: string): Promise<McpToken | null> {
    return this.tokens.get(tokenHash) ?? null;
  }

  async updateToken(token: McpToken): Promise<void> {
    this.tokens.set(token.tokenHash, { ...token });
  }

  async revokeToken(tokenHash: string): Promise<void> {
    const token = this.tokens.get(tokenHash);
    if (token) {
      token.revokedAt = Date.now();
      this.tokens.set(tokenHash, token);
    }
  }
}

export class D1OAuthStore implements OAuthStore {
  private db: CloudflareD1DatabaseLike;

  constructor(db: CloudflareD1DatabaseLike) {
    this.db = db;
  }

  async getClient(id: string): Promise<McpClient | null> {
    const res = await this.db
      .prepare(
        "SELECT id, name, redirect_uris_json, grant_types_json, response_types_json, scope, auth_method, secret_hash, owner, disabled, created_at, last_used_at FROM mcp_clients WHERE id = ?",
      )
      .bind(id)
      .all<{
        id: string;
        name: string;
        redirect_uris_json: string;
        grant_types_json: string;
        response_types_json: string;
        scope: string;
        auth_method: string;
        secret_hash: string | null;
        owner: string | null;
        disabled: number;
        created_at: number;
        last_used_at: number | null;
      }>();

    const row = res.results?.[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      redirectUris: JSON.parse(row.redirect_uris_json),
      grantTypes: JSON.parse(row.grant_types_json),
      responseTypes: JSON.parse(row.response_types_json),
      scope: row.scope,
      authMethod: row.auth_method,
      secretHash: row.secret_hash ?? undefined,
      owner: row.owner ?? undefined,
      disabled: row.disabled === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  async createClient(client: McpClient): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO mcp_clients (id, name, redirect_uris_json, grant_types_json, response_types_json, scope, auth_method, secret_hash, owner, disabled, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        client.id,
        client.name,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        JSON.stringify(client.responseTypes),
        client.scope,
        client.authMethod,
        client.secretHash ?? null,
        client.owner ?? null,
        client.disabled ? 1 : 0,
        client.createdAt,
        client.lastUsedAt ?? null,
      )
      .run();
  }

  async updateClient(client: McpClient): Promise<void> {
    await this.db
      .prepare(
        "UPDATE mcp_clients SET name = ?, redirect_uris_json = ?, grant_types_json = ?, response_types_json = ?, scope = ?, auth_method = ?, secret_hash = ?, owner = ?, disabled = ?, last_used_at = ? WHERE id = ?",
      )
      .bind(
        client.name,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        JSON.stringify(client.responseTypes),
        client.scope,
        client.authMethod,
        client.secretHash ?? null,
        client.owner ?? null,
        client.disabled ? 1 : 0,
        client.lastUsedAt ?? null,
        client.id,
      )
      .run();
  }

  async createGrant(grant: McpGrant): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO mcp_grants (id, client_id, redirect_uri, owner, scope, state, resource, code_challenge, code_challenge_method, code_hash, csrf, approved, expires_at, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        grant.id,
        grant.clientId,
        grant.redirectUri,
        grant.owner,
        grant.scope,
        grant.state ?? null,
        grant.resource ?? null,
        grant.codeChallenge,
        grant.codeChallengeMethod,
        grant.codeHash ?? null,
        grant.csrf,
        grant.approved ? 1 : 0,
        grant.expiresAt,
        grant.createdAt,
        grant.usedAt ?? null,
      )
      .run();
  }

  async getGrant(id: string): Promise<McpGrant | null> {
    const res = await this.db
      .prepare(
        "SELECT id, client_id, redirect_uri, owner, scope, state, resource, code_challenge, code_challenge_method, code_hash, csrf, approved, expires_at, created_at, used_at FROM mcp_grants WHERE id = ?",
      )
      .bind(id)
      .all<{
        id: string;
        client_id: string;
        redirect_uri: string;
        owner: string;
        scope: string;
        state: string | null;
        resource: string | null;
        code_challenge: string;
        code_challenge_method: string;
        code_hash: string | null;
        csrf: string;
        approved: number;
        expires_at: number;
        created_at: number;
        used_at: number | null;
      }>();

    const row = res.results?.[0];
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      owner: row.owner,
      scope: row.scope,
      state: row.state ?? undefined,
      resource: row.resource ?? undefined,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      codeHash: row.code_hash ?? undefined,
      csrf: row.csrf,
      approved: row.approved === 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      usedAt: row.used_at ?? undefined,
    };
  }

  async getGrantByCodeHash(codeHash: string): Promise<McpGrant | null> {
    const res = await this.db
      .prepare(
        "SELECT id, client_id, redirect_uri, owner, scope, state, resource, code_challenge, code_challenge_method, code_hash, csrf, approved, expires_at, created_at, used_at FROM mcp_grants WHERE code_hash = ?",
      )
      .bind(codeHash)
      .all<{
        id: string;
        client_id: string;
        redirect_uri: string;
        owner: string;
        scope: string;
        state: string | null;
        resource: string | null;
        code_challenge: string;
        code_challenge_method: string;
        code_hash: string | null;
        csrf: string;
        approved: number;
        expires_at: number;
        created_at: number;
        used_at: number | null;
      }>();

    const row = res.results?.[0];
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      owner: row.owner,
      scope: row.scope,
      state: row.state ?? undefined,
      resource: row.resource ?? undefined,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      codeHash: row.code_hash ?? undefined,
      csrf: row.csrf,
      approved: row.approved === 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      usedAt: row.used_at ?? undefined,
    };
  }

  async updateGrant(grant: McpGrant): Promise<void> {
    await this.db
      .prepare(
        "UPDATE mcp_grants SET code_hash = ?, approved = ?, expires_at = ?, used_at = ? WHERE id = ?",
      )
      .bind(
        grant.codeHash ?? null,
        grant.approved ? 1 : 0,
        grant.expiresAt,
        grant.usedAt ?? null,
        grant.id,
      )
      .run();
  }

  async createToken(token: McpToken): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO mcp_tokens (id, client_id, kind, token_hash, scopes, resource, owner, expires_at, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        token.id,
        token.clientId,
        token.kind,
        token.tokenHash,
        token.scopes,
        token.resource,
        token.owner,
        token.expiresAt,
        token.revokedAt ?? null,
        token.createdAt,
        token.lastUsedAt ?? null,
      )
      .run();
  }

  async getTokenByHash(tokenHash: string): Promise<McpToken | null> {
    const res = await this.db
      .prepare(
        "SELECT id, client_id, kind, token_hash, scopes, resource, owner, expires_at, revoked_at, created_at, last_used_at FROM mcp_tokens WHERE token_hash = ?",
      )
      .bind(tokenHash)
      .all<{
        id: string;
        client_id: string;
        kind: "access" | "refresh";
        token_hash: string;
        scopes: string;
        resource: string;
        owner: string;
        expires_at: number;
        revoked_at: number | null;
        created_at: number;
        last_used_at: number | null;
      }>();

    const row = res.results?.[0];
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.client_id,
      kind: row.kind,
      tokenHash: row.token_hash,
      scopes: row.scopes,
      resource: row.resource,
      owner: row.owner,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  async updateToken(token: McpToken): Promise<void> {
    await this.db
      .prepare(
        "UPDATE mcp_tokens SET expires_at = ?, revoked_at = ?, last_used_at = ? WHERE token_hash = ?",
      )
      .bind(
        token.expiresAt,
        token.revokedAt ?? null,
        token.lastUsedAt ?? null,
        token.tokenHash,
      )
      .run();
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE mcp_tokens SET revoked_at = ? WHERE token_hash = ?",
      )
      .bind(Date.now(), tokenHash)
      .run();
  }
}

export function renderConsentPage(params: {
  grantId: string;
  clientName: string;
  scope: string;
  ownerEmail: string;
  csrf: string;
}): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>授权 MCP 客户端 - Video Compose</title>
  <style>
    :root {
      --bg: #0f1117;
      --card-bg: #1a1d26;
      --border: #2e3446;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --danger: #ef4444;
      --danger-hover: #dc2626;
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.25rem;
      max-width: 440px;
      width: 90%;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
    }
    .eyebrow {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    h1 {
      font-size: 1.35rem;
      margin: 0 0 1rem 0;
      font-weight: 600;
    }
    p {
      color: var(--text-muted);
      font-size: 0.92rem;
      line-height: 1.5;
      margin: 0 0 1.25rem 0;
    }
    .details {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.88rem;
    }
    .details-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }
    .details-row:last-child {
      margin-bottom: 0;
    }
    .details-label {
      color: var(--text-muted);
    }
    .details-value {
      font-weight: 500;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
    }
    button, a.btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.92rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      border: none;
      transition: background 0.15s ease;
    }
    .btn-allow {
      background: var(--accent);
      color: #fff;
    }
    .btn-allow:hover {
      background: var(--accent-hover);
    }
    .btn-deny {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
    }
    .btn-deny:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">Video Compose · MCP 授权</div>
    <h1>连接外部 Agent 客户端</h1>
    <p>客户端 <strong>${escapeHtml(params.clientName)}</strong> 正在请求通过 Model Context Protocol 访问您的项目与编排工作区。</p>

    <div class="details">
      <div class="details-row">
        <span class="details-label">登录身份</span>
        <span class="details-value">${escapeHtml(params.ownerEmail)}</span>
      </div>
      <div class="details-row">
        <span class="details-label">授权范围</span>
        <span class="details-value">${escapeHtml(params.scope || "video-compose.all")}</span>
      </div>
      <div class="details-row">
        <span class="details-label">协议版本</span>
        <span class="details-value">OAuth 2.1 (PKCE S256)</span>
      </div>
    </div>

    <form method="POST" action="/oauth/authorize/decide">
      <input type="hidden" name="grant" value="${escapeHtml(params.grantId)}" />
      <input type="hidden" name="csrf" value="${escapeHtml(params.csrf)}" />
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="btn-deny">拒绝</button>
        <button type="submit" name="decision" value="allow" class="btn-allow">允许连接</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

export function renderSignInPage(loginUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>需要登录 - Video Compose</title>
  <style>
    body { background: #0f1117; color: #e6edf3; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1d26; border: 1px solid #2e3446; border-radius: 12px; padding: 2rem; max-width: 400px; text-align: center; }
    a.btn { display: inline-block; background: #6366f1; color: #fff; padding: 0.75rem 1.5rem; border-radius: 6px; text-decoration: none; margin-top: 1rem; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <h2>请先登录</h2>
    <p>需要先验证您的身份才能授权 MCP 客户端接入。</p>
    <a href="${escapeHtml(loginUrl)}" class="btn">前往 SSO 登录</a>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
