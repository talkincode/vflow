import { createApiApp } from "@vflow/api";
import { VFlowClient } from "@vflow/client";
import type { VFlowDomainService } from "@vflow/domain";

import { WRITER_AUTH, READER_AUTH, OUTSIDER_AUTH, TEST_AUTH_CONFIG } from "./auth-fixture.ts";
export const HUMAN_WRITER_HEADERS=WRITER_AUTH;
export const HUMAN_READER_HEADERS=READER_AUTH;
export const OUTSIDER_HEADERS=OUTSIDER_AUTH;

export const AGENT_A_HEADERS = {
  "cf-access-client-id": "svc-token-client-1",
  "cf-access-client-secret": "svc-token-secret-1",
  "x-agent-id": "agent-storyboard",
};

export const AGENT_B_HEADERS = {
  "cf-access-client-id": "svc-token-audio",
  "cf-access-client-secret": "svc-token-secret-1",
  "x-agent-id": "agent-audio",
};

export const AGENT_READER_HEADERS = {
  "cf-access-client-id": "svc-token-observer",
  "cf-access-client-secret": "svc-token-secret-1",
  "x-agent-id": "agent-observer",
};

export function createTestHarness(): {
  domain: VFlowDomainService;
  writerClient: VFlowClient;
  readerClient: VFlowClient;
  outsiderClient: VFlowClient;
  anonymousClient: VFlowClient;
  agentAClient: VFlowClient;
  agentBClient: VFlowClient;
  agentReaderClient: VFlowClient;
} {
  const { app, domain } = createApiApp(undefined, TEST_AUTH_CONFIG);

  const fetchFn = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(String(input), init);
    return app.fetch(req);
  };

  const baseClient = new VFlowClient({
    baseUrl: "https://vflow.talkincode.net",
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
