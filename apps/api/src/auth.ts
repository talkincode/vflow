import type { ActorIdentity } from "@video-compose/protocol";

export interface AccessAuthConfig {
  allowedServiceTokens?: Record<string, { secret: string; defaultActorId: string }>;
}

/**
 * Extracts caller identity from Cloudflare Access headers.
 * - Human SSO sessions supply `cf-access-authenticated-user-email` (and `cf-access-jwt-assertion`).
 * - Headless Agent sessions supply `cf-access-client-id` + `cf-access-client-secret` (and optional `x-agent-id` for distinct agent auditing).
 */
export function extractActorFromHeaders(
  headers: Headers,
  config?: AccessAuthConfig,
): ActorIdentity | null {
  const userEmail = headers.get("cf-access-authenticated-user-email")?.trim();
  const cookieHeader = headers.get("cookie") ?? "";
  const cfAuthCookieMatch = cookieHeader.match(
    /(?:^|;\s*)CF_Authorization=([^;]+)/,
  );
  const jwtAssertion =
    headers.get("cf-access-jwt-assertion")?.trim() ||
    cfAuthCookieMatch?.[1]?.trim();
  if (userEmail && jwtAssertion) {
    return {
      actorId: userEmail,
      actorKind: "human",
    };
  }

  const clientId = headers.get("cf-access-client-id")?.trim();
  const clientSecret = headers.get("cf-access-client-secret")?.trim();
  if (clientId && clientSecret) {
    if (config?.allowedServiceTokens) {
      const entry = config.allowedServiceTokens[clientId];
      if (!entry || entry.secret !== clientSecret) {
        return null;
      }
      const explicitAgentId = headers.get("x-agent-id")?.trim();
      return {
        actorId: explicitAgentId || entry.defaultActorId,
        actorKind: "agent",
      };
    }
    const explicitAgentId = headers.get("x-agent-id")?.trim();
    return {
      actorId: explicitAgentId || `agent:${clientId}`,
      actorKind: "agent",
    };
  }

  if (jwtAssertion) {
    const parts = jwtAssertion.split(".");
    if (parts.length === 3 && parts[1]) {
      try {
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64.padEnd(
          base64.length + ((4 - (base64.length % 4)) % 4),
          "=",
        );
        const payload = JSON.parse(atob(padded)) as {
          email?: string;
          common_name?: string;
        };
        if (typeof payload.email === "string" && payload.email.trim()) {
          return {
            actorId: payload.email.trim(),
            actorKind: "human",
          };
        }
        if (
          typeof payload.common_name === "string" &&
          payload.common_name.trim()
        ) {
          const explicitAgentId = headers.get("x-agent-id")?.trim();
          return {
            actorId: explicitAgentId || `agent:${payload.common_name.trim()}`,
            actorKind: "agent",
          };
        }
      } catch {
        // Ignore malformed JWT payload and fall through
      }
    }
  }

  return null;
}
