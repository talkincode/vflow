import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiApp, MCP_TOOLS_MANIFEST } from "@video-compose/api";
import Ajv from "ajv";
import { MATERIAL_DOCUMENT_JSON_SCHEMA } from "@video-compose/protocol";
import { TEST_AUTH_CONFIG, WRITER_AUTH } from "./auth-fixture.ts";

function fixture() {
  const { app } = createApiApp(undefined, TEST_AUTH_CONFIG);
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    for (const [key, value] of Object.entries(WRITER_AUTH))
      headers.set(key, value);
    return app.fetch(new Request(request, { headers }));
  };
  return { app, fetchFn };
}
describe("E2E 17 — strict MCP action discovery and Streamable HTTP transport", () => {
  it("completes initialization, notifications, tool/prompt/resource discovery with the official MCP client", async () => {
    const { fetchFn } = fixture();
    const errors: Error[] = [];
    const client = new Client({
      name: "discovery-acceptance",
      version: "1.0.0",
    });
    client.onerror = (error) => errors.push(error);
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("https://vflow.test/mcp"), {
          fetch: fetchFn,
        }),
      );
      const [tools, prompts, resources, templates] = await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
        client.listResourceTemplates(),
      ]);
      expect(tools.tools.some((t) => t.name === "project_list")).toBe(true);
      expect(tools.tools.some((t) => t.name === "authoring_document_put")).toBe(
        true,
      );
      expect(prompts.prompts.length).toBeGreaterThan(0);
      expect(resources.resources.length).toBeGreaterThan(0);
      expect(templates.resourceTemplates).toBeDefined();
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  });
  it("discovers modern capabilities and tools with the v2 official client, without a legacy handshake", async () => {
    const { fetchFn } = fixture();
    const methods: string[] = [];
    const client = new ModernClient(
      { name: "modern-discovery", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new ModernTransport(new URL("https://vflow.test/mcp"), {
      fetch: async (input, init) => {
        const r = new Request(input, init);
        if (r.method === "POST") {
          const b = (await r.clone().json()) as { method: string };
          methods.push(b.method);
        }
        return fetchFn(r);
      },
    });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(result.tools.some((t) => t.name === "project_list")).toBe(true);
      expect(
        (await client.callTool({ name: "project_list", arguments: {} }))
          .isError,
      ).not.toBe(true);
      const resources = await client.listResources();
      expect(
        (await client.readResource({ uri: resources.resources[0].uri }))
          .contents.length,
      ).toBeGreaterThan(0);
      expect(methods).toContain("server/discover");
      expect(methods).not.toContain("initialize");
      expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
      expect((await client.listResources()).resources.length).toBeGreaterThan(
        0,
      );
    } finally {
      await client.close();
    }
  });
  it("rejects modern version/routing mismatches and disallowed origins before tool dispatch", async () => {
    const { app } = fixture();
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "strict", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const base = {
      ...WRITER_AUTH,
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    };
    const rpc = {
      jsonrpc: "2.0",
      id: "strict",
      method: "tools/list",
      params: { _meta: meta },
    };
    for (const headers of [
      { ...base, "Mcp-Method": "tools/call" },
      { ...base, "MCP-Protocol-Version": "2025-11-25" },
    ]) {
      const response = await app.request("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(rpc),
      });
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: number } }).error.code,
      ).toBe(-32020);
    }
    const future = await app.request("/mcp", {
      method: "POST",
      headers: { ...base, "MCP-Protocol-Version": "2099-01-01" },
      body: JSON.stringify({
        ...rpc,
        params: {
          _meta: {
            ...meta,
            "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          },
        },
      }),
    });
    expect(future.status).toBe(400);
    expect(
      ((await future.json()) as { error: { code: number } }).error.code,
    ).toBe(-32022);
    const name = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...base,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "project_create",
      },
      body: JSON.stringify({
        ...rpc,
        method: "tools/call",
        params: { _meta: meta, name: "project_list", arguments: {} },
      }),
    });
    expect(name.status).toBe(400);
    expect(
      ((await name.json()) as { error: { code: number } }).error.code,
    ).toBe(-32020);
    const origin = await app.request("/mcp", {
      method: "POST",
      headers: { ...base, Origin: "https://untrusted.invalid" },
      body: JSON.stringify(rpc),
    });
    expect(origin.status).toBe(403);
  });
  it("exports importer-compatible array items and preserves exact storyboard bounds validation", async () => {
    const { app } = fixture();
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { ...WRITER_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "schema-regression",
        method: "tools/list",
      }),
    });
    const { result } = (await response.json()) as {
      result: { tools: typeof MCP_TOOLS_MANIFEST };
    };
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.type === "array") expect(node.items).toBeDefined();
      expect(Array.isArray(node.items)).toBe(false);
      for (const child of Object.values(node))
        if (typeof child === "object") visit(child);
    };
    for (const tool of result.tools) visit(tool.inputSchema);
    type MaterialSchema = {
      anyOf: Array<{
        properties: {
          panels?: {
            items: {
              properties: {
                entities: { items: { properties: { bounds: object } } };
              };
            };
          };
        };
      }>;
    };
    const original = (
      MATERIAL_DOCUMENT_JSON_SCHEMA as unknown as MaterialSchema
    ).anyOf[3].properties.panels!.items.properties.entities.items.properties
      .bounds;
    const ajv = new Ajv({ allErrors: true });
    const originalValidate = ajv.compile(original);
    for (const name of ["authoring_document_put", "reference_plan_validate"]) {
      const schema = result.tools.find((t) => t.name === name)!.inputSchema
        .properties.document as MaterialSchema;
      const bounds =
        schema.anyOf[3].properties.panels!.items.properties.entities.items
          .properties.bounds;
      expect(bounds).toMatchObject({
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: { type: "number", minimum: 0, maximum: 1 },
      });
      const validate = ajv.compile(bounds);
      for (const value of [
        [0, 0, 0.5, 1],
        [0, 0, 1],
        [0, 0, 1, 1, 1],
        [-1, 0, 1, 1],
        [0, 0, 2, 1],
        [0, 0, "1", 1],
      ])
        expect(validate(value)).toBe(originalValidate(value));
    }
  });
  it("acknowledges notifications and client responses with empty 202, never malformed JSON-RPC", async () => {
    const { app } = fixture();
    for (const message of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1, reason: "cancelled" },
      },
      { jsonrpc: "2.0", id: "server-request", result: {} },
    ]) {
      const response = await app.request("/mcp", {
        method: "POST",
        headers: { ...WRITER_AUTH, "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
    }
  });
  it("distinguishes unsupported SSE and unsupported HTTP methods from a missing MCP endpoint", async () => {
    const { app } = fixture();
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request("/mcp", {
        method,
        headers: { ...WRITER_AUTH, accept: "text/event-stream" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toContain("POST");
    }
  });
  it("rejects malformed envelopes and JSON without internal errors, and keeps discovery authenticated", async () => {
    const { app } = fixture();
    for (const body of [
      "{",
      JSON.stringify([]),
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    ]) {
      const response = await app.request("/mcp", {
        method: "POST",
        headers: { ...WRITER_AUTH, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: number } }).error.code,
      ).toBeLessThanOrEqual(-32600);
    }
    const anonymous = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );
  });
});
