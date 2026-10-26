import { canonicalizeJson, PROTOCOL_VERSION } from "@vflow/protocol";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "./helpers.ts";
import { handleMcpJsonRpc } from "@vflow/api";

describe("E2E 06 — HTTP/MCP 接入 (HTTP REST & Remote MCP Parity)", () => {
  it("Happy Path: REST and MCP tools produce identical canonical results and support idempotent retries", async () => {
    const { domain, writerClient, agentAClient } = createTestHarness();

    // Create project via MCP
    await writerClient.callMcpTool("project_create", { authoringMode: "legacy",
      id: "mcp-proj",
      name: "MCP Parity Project",
      members: {
        "agent-storyboard": "writer",
      },
    });

    // Upload asset via MCP (base64)
    await agentAClient.callMcpTool("asset_upload", {
      projectId: "mcp-proj",
      assetId: "asset-char-front",
      contentBase64: btoa("char-front-binary"),
      mimeType: "image/png",
      width: 512,
      height: 512,
    });

    // Create and approve subject via MCP
    await agentAClient.callMcpTool("subject_create", {
      projectId: "mcp-proj",
      id: "char-mcp",
      kind: "character",
      name: "MCP 角色",
      defaultVariant: "default",
      status: "candidate",
      definition: { description: "Created via MCP", invariants: ["Stable"] },
      variants: {
        default: {
          description: "Default look",
          referencePack: [
            {
              asset: "asset-char-front",
              view: "front",
              status: "candidate",
            },
          ],
        },
      },
    });

    await writerClient.callMcpTool("subject_approve_revision", {
      projectId: "mcp-proj",
      subjectId: "char-mcp",
      revision: 1,
      operationId: "mcp-approve-1",
    });

    // Create composition via MCP
    await agentAClient.callMcpTool("composition_create", {
      projectId: "mcp-proj",
      operationId: "mcp-create-comp-1",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-parity",
        project: "mcp-proj",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-1"],
        shots: {
          "shot-1": {
            description: "Initial via MCP",
            durationFrames: 60,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Bind subject via MCP tool `shot_subject_bind`
    await agentAClient.callMcpTool("shot_subject_bind", {
      projectId: "mcp-proj",
      compositionId: "comp-parity",
      baseRevision: 1,
      operationId: "mcp-bind-op-1",
      shotId: "shot-1",
      binding: {
        subjectId: "char-mcp",
        subjectRevision: 1,
      },
    });

    // Idempotent retry with identical operationId returns revision 2 without creating revision 3
    const retryResult = await agentAClient.callMcpTool<{
      revisionRecord: { revision: number };
    }>("shot_subject_bind", {
      projectId: "mcp-proj",
      compositionId: "comp-parity",
      baseRevision: 1,
      operationId: "mcp-bind-op-1",
      shotId: "shot-1",
      binding: {
        subjectId: "char-mcp",
        subjectRevision: 1,
      },
    });
    expect(retryResult.revisionRecord.revision).toBe(2);

    // Compare state fetched via REST vs MCP
    const viaRest = await writerClient.getComposition("mcp-proj", "comp-parity");
    const viaMcp = await agentAClient.callMcpTool<typeof viaRest>(
      "composition_get",
      {
        projectId: "mcp-proj",
        compositionId: "comp-parity",
      },
    );
    expect(canonicalizeJson(viaRest)).toBe(canonicalizeJson(viaMcp));

    // Check subject_usage via MCP
    const usage = await agentAClient.callMcpTool<Array<{ shotId: string }>>(
      "subject_usage",
      {
        projectId: "mcp-proj",
        subjectId: "char-mcp",
      },
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].shotId).toBe("shot-1");

    // Strict MCP clients reject array-valued structuredContent even when text is valid.
    for (const name of ["project_list", "composition_list", "asset_search", "subject_list", "subject_usage", "composition_history"]) {
      const response = await handleMcpJsonRpc(domain, { actorId: "agent-storyboard", actorKind: "agent", userId:"alice@talkincode.net" }, {
        jsonrpc: "2.0", id: name, method: "tools/call",
        params: { name, arguments: { projectId: "mcp-proj", compositionId: "comp-parity", subjectId: "char-mcp" } },
      });
      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError: boolean };
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.content[0].text);
      if (Array.isArray(payload)) {
        expect(result.structuredContent).toBeUndefined();
      } else {
        expect(result.structuredContent).toEqual(payload);
      }
    }
  });

  it("Failure Path, Role Verification & Recovery: blocks anonymous/reader MCP mutations and recovers cleanly on retry after fault", async () => {
    const { domain, writerClient, anonymousClient, agentReaderClient } =
      createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "mcp-proj",
      name: "MCP Project",
      members: {
        "agent-observer": "reader",
      },
    });

    await writerClient.createComposition({
      projectId: "mcp-proj",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-1",
        project: "mcp-proj",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-1"],
        shots: {
          "shot-1": {
            description: "Original",
            durationFrames: 60,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Anonymous MCP call is rejected with UNAUTHORIZED
    await expect(
      anonymousClient.callMcpTool("project_list", {}),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Reader Agent can call read tool `composition_get`
    const readRes = await agentReaderClient.callMcpTool<{ headRevision: number }>(
      "composition_get",
      {
        projectId: "mcp-proj",
        compositionId: "comp-1",
      },
    );
    expect(readRes.headRevision).toBe(1);

    // Reader Agent is blocked on write tool `composition_patch`
    await expect(
      agentReaderClient.callMcpTool("composition_patch", {
        projectId: "mcp-proj",
        compositionId: "comp-1",
        baseRevision: 1,
        operationId: "reader-illegal-mcp",
        operations: [
          {
            op: "update_shot_fields",
            shotId: "shot-1",
            description: "Illegal",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Fault injection during MCP patch rolls back so retry succeeds cleanly
    domain.store.injectFaultOnce("patchComposition");
    await expect(
      writerClient.callMcpTool("composition_patch", {
        projectId: "mcp-proj",
        compositionId: "comp-1",
        baseRevision: 1,
        operationId: "retryable-mcp-op",
        operations: [
          {
            op: "update_shot_fields",
            shotId: "shot-1",
            description: "Updated after retry",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const recovered = await writerClient.callMcpTool<{
      revisionRecord: { revision: number };
    }>("composition_patch", {
      projectId: "mcp-proj",
      compositionId: "comp-1",
      baseRevision: 1,
      operationId: "retryable-mcp-op",
      operations: [
        {
          op: "update_shot_fields",
          shotId: "shot-1",
          description: "Updated after retry",
        },
      ],
    });
    expect(recovered.revisionRecord.revision).toBe(2);
  });
});
