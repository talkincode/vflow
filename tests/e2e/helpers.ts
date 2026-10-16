import { createApiApp } from "@video-compose/api";
import { VideoComposeClient } from "@video-compose/client";
import type { VideoComposeDomainService } from "@video-compose/domain";

export const HUMAN_WRITER_HEADERS = {
  "cf-access-authenticated-user-email": "alice@talkincode.net",
  "cf-access-jwt-assertion": "verified-jwt-alice",
};

export const HUMAN_READER_HEADERS = {
  "cf-access-authenticated-user-email": "bob-reader@talkincode.net",
  "cf-access-jwt-assertion": "verified-jwt-bob",
};

export const OUTSIDER_HEADERS = {
  "cf-access-authenticated-user-email": "mallory@talkincode.net",
  "cf-access-jwt-assertion": "verified-jwt-mallory",
};

export const AGENT_A_HEADERS = {
  "cf-access-client-id": "svc-token-client-1",
  "cf-access-client-secret": "svc-token-secret-1",
  "x-agent-id": "agent-storyboard",
};

export const AGENT_B_HEADERS = {
  "cf-access-client-id": "svc-token-client-1",
  "cf-access-client-secret": "svc-token-secret-1",
  "x-agent-id": "agent-audio",
};

export const AGENT_READER_HEADERS = {
  "cf-access-client-id": "svc-token-client-1",
  "cf-access-client-secret": "svc-token-secret-1",
  "x-agent-id": "agent-observer",
};

export function createTestHarness(): {
  domain: VideoComposeDomainService;
  writerClient: VideoComposeClient;
  readerClient: VideoComposeClient;
  outsiderClient: VideoComposeClient;
  anonymousClient: VideoComposeClient;
  agentAClient: VideoComposeClient;
  agentBClient: VideoComposeClient;
  agentReaderClient: VideoComposeClient;
} {
  const { app, domain } = createApiApp(undefined, {
    allowedServiceTokens: {
      "svc-token-client-1": {
        secret: "svc-token-secret-1",
        defaultActorId: "agent-default",
      },
    },
  });

  const fetchFn = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(String(input), init);
    return app.fetch(req);
  };

  const baseClient = new VideoComposeClient({
    baseUrl: "https://video-compose.talkincode.net",
    fetchFn,
  });

  return {
    domain,
    writerClient: baseClient.withHeaders(HUMAN_WRITER_HEADERS),
    readerClient: baseClient.withHeaders(HUMAN_READER_HEADERS),
    outsiderClient: baseClient.withHeaders(OUTSIDER_HEADERS),
    anonymousClient: baseClient,
    agentAClient: baseClient.withHeaders(AGENT_A_HEADERS),
    agentBClient: baseClient.withHeaders(AGENT_B_HEADERS),
    agentReaderClient: baseClient.withHeaders(AGENT_READER_HEADERS),
  };
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
