import { PROTOCOL_VERSION } from "@video-compose/protocol";
import { describe, expect, it } from "vitest";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

describe("E2E 01 — 项目与编排管理 (Project & Composition Management)", () => {
  it("Happy Path: writer creates project, registers shared asset, and creates multiple compositions", async () => {
    const { writerClient, readerClient } = createTestHarness();

    const project = await writerClient.createProject({
      id: "demo",
      name: "Demo Video Project",
      members: {
        "bob-reader@talkincode.net": "reader",
      },
    });
    expect(project.id).toBe("demo");
    expect(project.members["alice@talkincode.net"]).toBe("writer");
    expect(project.members["bob-reader@talkincode.net"]).toBe("reader");

    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "asset-shared-bgm",
      bytes: utf8Bytes("bgm-audio-bytes-v1"),
      mimeType: "audio/mpeg",
      durationFrames: 300,
    });

    const rev1 = await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-001",
        project: "demo",
        title: "Episode 1",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [
          {
            id: "bgm-track",
            role: "bgm",
            asset: "asset-shared-bgm",
            startFrame: 0,
            durationFrames: 300,
          },
        ],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Opening scene",
            durationFrames: 150,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: { image: "Studio wide shot" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });
    expect(rev1.revision).toBe(1);

    const rev2 = await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-002",
        project: "demo",
        title: "Episode 2",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [
          {
            id: "bgm-track",
            role: "bgm",
            asset: "asset-shared-bgm",
            startFrame: 0,
            durationFrames: 300,
          },
        ],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Episode 2 opening",
            durationFrames: 120,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: { video: "Slow pan" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });
    expect(rev2.revision).toBe(1);

    const fetched = await readerClient.getComposition("demo", "episode-001");
    expect(fetched.headRevision).toBe(1);
    expect(fetched.revisionRecord.document.audioTracks[0].asset).toBe(
      "asset-shared-bgm",
    );
  });

  it("Role Verification: reader can read but cannot write; outsider and anonymous are rejected", async () => {
    const { writerClient, readerClient, outsiderClient, anonymousClient } =
      createTestHarness();

    await writerClient.createProject({
      id: "demo",
      name: "Demo",
      members: { "bob-reader@talkincode.net": "reader" },
    });

    const readable = await readerClient.getProject("demo");
    expect(readable.id).toBe("demo");

    await expect(
      readerClient.createComposition({
        projectId: "demo",
        document: {
          apiVersion: PROTOCOL_VERSION,
          id: "unauthorized-comp",
          project: "demo",
          format: { width: 1920, height: 1080, fps: 30 },
          audioTracks: [],
          sequence: [],
          shots: {},
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(outsiderClient.getProject("demo")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await expect(anonymousClient.listProjects()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("Failure Path & Rollback: failed composition creation or commit fault leaves no partial state", async () => {
    const { domain, writerClient } = createTestHarness();

    await writerClient.createProject({ id: "demo", name: "Demo" });

    // 1. Validation failure (referencing non-existent sequence shot)
    await expect(
      writerClient.createComposition({
        projectId: "demo",
        document: {
          apiVersion: PROTOCOL_VERSION,
          id: "broken-comp",
          project: "demo",
          format: { width: 1920, height: 1080, fps: 30 },
          audioTracks: [],
          sequence: ["missing-shot"],
          shots: {},
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // 2. Simulated transactional commit failure
    domain.store.injectFaultOnce("createComposition");
    await expect(
      writerClient.createComposition({
        projectId: "demo",
        document: {
          apiVersion: PROTOCOL_VERSION,
          id: "atomic-comp",
          project: "demo",
          format: { width: 1920, height: 1080, fps: 30 },
          audioTracks: [],
          sequence: [],
          shots: {},
        },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await expect(
      writerClient.getComposition("demo", "atomic-comp"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Recovery: retry succeeds cleanly
    const recovered = await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "atomic-comp",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: [],
        shots: {},
      },
    });
    expect(recovered.revision).toBe(1);
  });
});
