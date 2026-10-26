import {
  type CloudflareD1DatabaseLike,
  type CloudflareR2BucketLike,
  D1TransactionalStore,
  InMemoryObjectBucket,
  R2ObjectBucketAdapter,
  VFlowDomainService,
} from "@vflow/domain";
import { createApiApp } from "./app.ts";
import type { AccessAuthConfig } from "./auth.ts";
import { D1OAuthStore, InMemoryOAuthStore, type OAuthStore } from "./oauth.ts";

export * from "./auth.ts";
export * from "./mcp.ts";
export * from "./app.ts";
export * from "./oauth.ts";

export interface WorkerEnv {
  DB?: CloudflareD1DatabaseLike;
  MEDIA_BUCKET?: CloudflareR2BucketLike;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  ALLOWED_SERVICE_TOKENS_JSON?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS_JSON?: string;
}

const fallbackMemoryService = new VFlowDomainService();

export function createWorkerHandler(
  defaultService: VFlowDomainService = fallbackMemoryService,
) {
  return {
    async fetch(request: Request, env?: WorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      const isWorkerRoute =
        url.pathname === "/mcp" ||
        url.pathname === "/logout" ||
        url.pathname === "/v1" ||
        url.pathname.startsWith("/v1/") ||
        url.pathname === "/oauth" ||
        url.pathname.startsWith("/oauth/") ||
        url.pathname.startsWith("/.well-known/");

      if (!isWorkerRoute && env?.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      let domain = defaultService;
      let oauthStore: OAuthStore = new InMemoryOAuthStore();
      if (env?.DB) {
        const bucket = env.MEDIA_BUCKET
          ? new R2ObjectBucketAdapter(env.MEDIA_BUCKET)
          : new InMemoryObjectBucket();
        const store = new D1TransactionalStore(env.DB, bucket);
        domain = new VFlowDomainService(store);
        oauthStore = new D1OAuthStore(env.DB);
      }

      let authConfig: AccessAuthConfig = {};
      if (env?.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD)
        authConfig.access = {
          issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
          audience: env.ACCESS_AUD,
          ...(env.ACCESS_JWKS_JSON
            ? { jwks: JSON.parse(env.ACCESS_JWKS_JSON) }
            : {}),
        };
      if (env?.ALLOWED_SERVICE_TOKENS_JSON) {
        try {
          authConfig = {
            ...authConfig,
            allowedServiceTokens: JSON.parse(
              env.ALLOWED_SERVICE_TOKENS_JSON,
            ) as AccessAuthConfig["allowedServiceTokens"],
          };
        } catch {
          authConfig.allowedServiceTokens = {};
        }
      }

      const { app } = createApiApp(domain, authConfig, oauthStore);
      return app.fetch(request);
    },
  };
}

const worker = createWorkerHandler();
export default worker;
