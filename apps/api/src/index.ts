import {
  type CloudflareD1DatabaseLike,
  type CloudflareR2BucketLike,
  D1TransactionalStore,
  InMemoryObjectBucket,
  R2ObjectBucketAdapter,
  VideoComposeDomainService,
} from "@video-compose/domain";
import { createApiApp } from "./app.ts";
import type { AccessAuthConfig } from "./auth.ts";
import {
  D1OAuthStore,
  InMemoryOAuthStore,
  type OAuthStore,
} from "./oauth.ts";

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
}

const fallbackMemoryService = new VideoComposeDomainService();

export function createWorkerHandler(
  defaultService: VideoComposeDomainService = fallbackMemoryService,
) {
  return {
    async fetch(request: Request, env?: WorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      const isWorkerRoute =
        url.pathname === "/mcp" ||
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
        domain = new VideoComposeDomainService(store);
        oauthStore = new D1OAuthStore(env.DB);
      }

      let authConfig: AccessAuthConfig | undefined;
      if (env?.ALLOWED_SERVICE_TOKENS_JSON) {
        try {
          authConfig = {
            allowedServiceTokens: JSON.parse(
              env.ALLOWED_SERVICE_TOKENS_JSON,
            ) as AccessAuthConfig["allowedServiceTokens"],
          };
        } catch {
          authConfig = undefined;
        }
      }

      const { app } = createApiApp(domain, authConfig, oauthStore);
      return app.fetch(request);
    },
  };
}

const worker = createWorkerHandler();
export default worker;
