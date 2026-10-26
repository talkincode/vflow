import type { ActorIdentity } from "@vflow/protocol";
import type { VFlowDomainService } from "@vflow/domain";
import {
  handleMcpJsonRpc,
  LEGACY_MCP_VERSIONS,
  MODERN_MCP_VERSION,
  type JsonRpcRequest,
} from "./mcp.ts";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const decodeHeader = (value: string | null) => {
  if (!value?.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value.slice(9, -2)), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
};
/** Streamable HTTP framing is shared by OAuth and Access-authenticated callers. */
export async function mcpHttp(
  request: Request,
  domain: VFlowDomainService,
  actor: ActorIdentity | null,
  cors: Record<string, string>,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const headers = {
    ...cors,
    "Cache-Control": "private, no-store",
    Vary: "Authorization, Cookie, Origin",
  };
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  const error = (
    code: number,
    message: string,
    status: number,
    id: unknown = null,
    data?: unknown,
  ) =>
    reply(
      {
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data ? { data } : {}) },
      },
      status,
    );
  if (!actor)
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: "Authentication is required.",
          data: { code: "UNAUTHORIZED" },
        },
      }),
      {
        status: 401,
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer realm="vflow", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      },
    );
  const callerOrigin = request.headers.get("origin");
  if (
    callerOrigin &&
    ![origin, "https://chatgpt.com", "https://chat.openai.com"].includes(
      callerOrigin,
    )
  )
    return error(-32000, "Origin is not allowed.", 403);
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return error(-32700, "Parse error", 400);
  }
  if (
    !object(message) ||
    message.jsonrpc !== "2.0" ||
    ("id" in message &&
      message.id !== null &&
      typeof message.id !== "string" &&
      typeof message.id !== "number") ||
    ("params" in message && !object(message.params))
  )
    return error(-32600, "Invalid Request", 400);
  const id = message.id ?? null;
  const params = message.params as Record<string, unknown> | undefined;
  const meta = params?._meta;
  if (meta !== undefined && !object(meta))
    return error(-32600, "Invalid request metadata", 400, id);
  const bodyVersion = object(meta)
    ? meta["io.modelcontextprotocol/protocolVersion"]
    : undefined;
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  if (
    bodyVersion !== undefined &&
    headerVersion !== null &&
    headerVersion !== bodyVersion
  )
    return error(
      -32020,
      "HeaderMismatch: protocol version must match the body.",
      400,
      id,
    );
  const version = headerVersion ?? bodyVersion;
  const modern = version === MODERN_MCP_VERSION;
  if (
    version !== undefined &&
    version !== null &&
    version !== MODERN_MCP_VERSION &&
    !LEGACY_MCP_VERSIONS.includes(String(version)) &&
    message.method !== "initialize"
  )
    return error(-32022, "Unsupported protocol version", 400, id, {
      supported: [MODERN_MCP_VERSION, ...LEGACY_MCP_VERSIONS],
      requested: version,
    });
  if (typeof message.method !== "string") {
    // Legacy client replies are accepted but this stateless server has no pending server requests.
    if (
      !modern &&
      "id" in message &&
      "result" in message !== "error" in message
    )
      return new Response(null, { status: 202, headers });
    return error(-32600, "Invalid Request", 400, id);
  }
  if (!("id" in message)) {
    if (!message.method.startsWith("notifications/"))
      return error(-32600, "Only notifications may omit an id.", 400);
    return new Response(null, { status: 202, headers });
  }
  if (modern) {
    if (
      headerVersion !== bodyVersion ||
      request.headers.get("Mcp-Method") !== message.method
    )
      return error(
        -32020,
        "HeaderMismatch: protocol version and method must match the body.",
        400,
        id,
      );
    if (
      !object(meta) ||
      !object(meta["io.modelcontextprotocol/clientInfo"]) ||
      !object(meta["io.modelcontextprotocol/clientCapabilities"])
    )
      return error(
        -32602,
        "Modern requests require clientInfo and clientCapabilities metadata.",
        400,
        id,
      );
    if (
      ["tools/call", "resources/read", "prompts/get"].includes(
        message.method,
      ) &&
      decodeHeader(request.headers.get("Mcp-Name")) !==
        (params?.name ?? params?.uri)
    )
      return error(
        -32020,
        "HeaderMismatch: Mcp-Name must match the body.",
        400,
        id,
      );
  }
  const response = await handleMcpJsonRpc(
    domain,
    actor,
    message as unknown as JsonRpcRequest,
  );
  return reply(
    response,
    modern && response.error?.code === -32601
      ? 404
      : response.error?.code === -32022
        ? 400
        : 200,
  );
}
