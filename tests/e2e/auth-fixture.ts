import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { AccessAuthConfig, WorkerEnv } from "@vflow/api";
const pair = await generateKeyPair("RS256");
export const TEST_JWKS = {
  keys: [
    {
      ...(await exportJWK(pair.publicKey)),
      kid: "synthetic-access-key",
      alg: "RS256",
      use: "sig",
    },
  ],
};
export const TEST_ACCESS = {
  issuer: "https://test.cloudflareaccess.com",
  audience: "test-vflow-audience",
  jwks: TEST_JWKS,
};
export const TEST_WORKER_AUTH: Partial<WorkerEnv> = {
  ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  ACCESS_AUD: TEST_ACCESS.audience,
  ACCESS_JWKS_JSON: JSON.stringify(TEST_JWKS),
};
export const TEST_AUTH_CONFIG: AccessAuthConfig = {
  access: TEST_ACCESS,
  allowedServiceTokens: {
    "svc-token-client-1": {
      secret: "svc-token-secret-1",
      defaultActorId: "agent-storyboard",
      ownerUserId: "alice@talkincode.net",
    },
    "svc-token-audio": {
      secret: "svc-token-secret-1",
      defaultActorId: "agent-audio",
      ownerUserId: "alice@talkincode.net",
    },
    "svc-token-observer": {
      secret: "svc-token-secret-1",
      defaultActorId: "agent-observer",
      ownerUserId: "alice@talkincode.net",
    },
  },
};
export async function signedUserHeaders(email: string) {
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-access-key" })
    .setIssuer(TEST_ACCESS.issuer)
    .setAudience(TEST_ACCESS.audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(pair.privateKey);
  return {
    "cf-access-authenticated-user-email": email,
    "cf-access-jwt-assertion": token,
  };
}
export const WRITER_AUTH = await signedUserHeaders("alice@talkincode.net");
export const READER_AUTH = await signedUserHeaders("bob-reader@talkincode.net");
export const OUTSIDER_AUTH = await signedUserHeaders("mallory@talkincode.net");
