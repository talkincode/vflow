import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import type { ActorIdentity } from "@video-compose/protocol";

export interface AccessAuthConfig {
  access?: { issuer: string; audience: string; jwks?: JSONWebKeySet };
  allowedServiceTokens?: Record<
    string,
    { secret: string; defaultActorId: string; ownerUserId: string }
  >;
}
const remoteKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const localKeys = new WeakMap<
  JSONWebKeySet,
  ReturnType<typeof createLocalJWKSet>
>();
const normalize = (s: string) => s.trim().toLowerCase();
/** Only cryptographically verified Access claims or explicitly configured machine credentials create identities. */
export async function extractActorFromHeaders(
  headers: Headers,
  config?: AccessAuthConfig,
): Promise<ActorIdentity | null> {
  const clientId = headers.get("cf-access-client-id")?.trim();
  const clientSecret = headers.get("cf-access-client-secret")?.trim();
  if (clientId && clientSecret) {
    const entry = config?.allowedServiceTokens?.[clientId];
    if (
      !entry ||
      !entry.ownerUserId?.trim() ||
      !entry.defaultActorId?.trim() ||
      entry.secret !== clientSecret
    )
      return null;
    return {
      actorId: entry.defaultActorId,
      actorKind: "agent",
      userId: normalize(entry.ownerUserId),
    };
  }
  const cookie = headers
    .get("cookie")
    ?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  const token = headers.get("cf-access-jwt-assertion")?.trim() || cookie;
  const access = config?.access;
  if (!token || !access?.issuer || !access.audience) return null;
  try {
    let keys;
    if (access.jwks) {
      keys = localKeys.get(access.jwks);
      if (!keys) {
        keys = createLocalJWKSet(access.jwks);
        localKeys.set(access.jwks, keys);
      }
    } else {
      keys = remoteKeys.get(access.issuer);
      if (!keys) {
        keys = createRemoteJWKSet(
          new URL("/cdn-cgi/access/certs", access.issuer),
        );
        remoteKeys.set(access.issuer, keys);
      }
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: access.issuer,
      audience: access.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iss", "aud"],
    });
    if (typeof payload.email === "string" && payload.email.trim()) {
      const id = normalize(payload.email);
      return { actorId: id, actorKind: "human", userId: id };
    }
    if (typeof payload.common_name === "string") {
      const entry = config?.allowedServiceTokens?.[payload.common_name];
      if (entry?.ownerUserId?.trim() && entry.defaultActorId?.trim())
        return {
          actorId: entry.defaultActorId,
          actorKind: "agent",
          userId: normalize(entry.ownerUserId),
        };
    }
  } catch {
    /* fail closed: never fall back to an unverified email or decoded JWT */
  }
  return null;
}
