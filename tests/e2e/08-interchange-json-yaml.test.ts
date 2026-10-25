import { canonicalizeJson, PROTOCOL_VERSION } from "@video-compose/protocol";
import { describe, expect, it } from "vitest";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

describe("E2E 08 — JSON/YAML 交换 (JSON/YAML Portable Interchange)", () => {
  it("Happy Path: round-trips composition bundle (with subjects, assets, audioTracks, dependsOn, candidates) across YAML and JSON without altering semantics", async () => {
    const { writerClient, readerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "source-proj",
      name: "Source Project",
      members: { "bob-reader@talkincode.net": "reader" },
    });

    const assetWeila = await writerClient.uploadAsset({
      projectId: "source-proj",
      assetId: "weila-front",
      bytes: utf8Bytes("weila-front-bytes"),
      mimeType: "image/png",
    });
    const assetBgm = await writerClient.uploadAsset({
      projectId: "source-proj",
      assetId: "bgm-01",
      bytes: utf8Bytes("bgm-01-bytes"),
      mimeType: "audio/mpeg",
    });

    await writerClient.createSubject({
      projectId: "source-proj",
      id: "char-weila",
      kind: "character",
      name: "微辣",
      defaultVariant: "studio",
      status: "approved",
      definition: { description: "主播", invariants: ["面部一致"] },
      variants: {
        studio: {
          description: "演播室",
          referencePack: [{ asset: assetWeila.id, status: "approved" }],
        },
      },
    });

    const created = await writerClient.createComposition({
      projectId: "source-proj",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-001",
        project: "source-proj",
        title: "Roundtrip Episode",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [
          {
            id: "bgm-track",
            role: "bgm",
            asset: assetBgm.id,
            startFrame: 0,
            durationFrames: 200,
          },
        ],
        sequence: ["shot-001", "shot-002"],
        shots: {
          "shot-001": {
            description: "Shot 1",
            durationFrames: 100,
            dependsOn: [],
            subjects: [{ subjectId: "char-weila", subjectRevision: 1 }],
            references: { images: [], videos: [] },
            prompts: { image: "Prompt 1" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
          "shot-002": {
            description: "Shot 2",
            durationFrames: 100,
            dependsOn: [{ shotId: "shot-001", kind: "continuity" }],
            subjects: [
              {
                subjectId: "char-weila",
                subjectRevision: 1,
                variant: "studio",
              },
            ],
            references: { images: [], videos: [] },
            prompts: { video: "Prompt 2" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Reader can export in both YAML and JSON
    const exportedYaml = await readerClient.exportCompositionBundle({
      projectId: "source-proj",
      compositionId: "episode-001",
      format: "yaml",
    });
    const exportedJson = await readerClient.exportCompositionBundle({
      projectId: "source-proj",
      compositionId: "episode-001",
      format: "json",
    });

    expect(canonicalizeJson(exportedYaml.bundle)).toBe(
      canonicalizeJson(exportedJson.bundle),
    );

    // Import YAML bundle into a second project that has the required immutable assets registered
    await writerClient.createProject({ authoringMode: "legacy",
      id: "target-proj",
      name: "Target Project",
    });
    await writerClient.uploadAsset({
      projectId: "target-proj",
      assetId: "weila-front",
      bytes: utf8Bytes("weila-front-bytes"),
      mimeType: "image/png",
    });
    await writerClient.uploadAsset({
      projectId: "target-proj",
      assetId: "bgm-01",
      bytes: utf8Bytes("bgm-01-bytes"),
      mimeType: "audio/mpeg",
    });

    const importedRev = await writerClient.importCompositionBundle({
      projectId: "target-proj",
      payload: exportedYaml.serialized,
      format: "yaml",
    });

    // Normalize project ID field for semantic comparison
    const normalizedOriginal = {
      ...created.document,
      project: "target-proj",
    };
    expect(canonicalizeJson(importedRev.document)).toBe(
      canonicalizeJson(normalizedOriginal),
    );

    // Subject dependency was also imported and resolves identically
    const fetchedTarget = await writerClient.getComposition(
      "target-proj",
      "episode-001",
    );
    expect(
      fetchedTarget.resolvedSubjects["char-weila@1#studio"].referencePack[0]
        .asset,
    ).toBe("weila-front");
  });

  it("Failure Path, Role Verification & Rollback: rejects corrupted YAML/JSON, blocks reader import, rejects missing asset dependencies, and preserves existing data", async () => {
    const { writerClient, readerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "demo",
      name: "Demo",
      members: { "bob-reader@talkincode.net": "reader" },
    });

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "existing-comp",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-1"],
        shots: {
          "shot-1": {
            description: "Untouched existing shot",
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

    const exported = await readerClient.exportCompositionBundle({
      projectId: "demo",
      compositionId: "existing-comp",
      format: "yaml",
    });

    // 1. Reader is forbidden from importing
    await expect(
      readerClient.importCompositionBundle({
        projectId: "demo",
        payload: exported.serialized,
        format: "yaml",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 2. Corrupted YAML syntax is rejected and existing-comp remains at revision 1
    await expect(
      writerClient.importCompositionBundle({
        projectId: "demo",
        payload: "apiVersion: [corrupted: yaml: :::",
        format: "yaml",
        targetCompositionId: "existing-comp",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // 3. Bundle referencing missing binary asset in project is atomically rejected
    const bundleWithMissingAsset = structuredClone(exported.bundle);
    bundleWithMissingAsset.dependencies.assets.push({
      id: "missing-binary-asset",
      sha256: "a".repeat(64),
      mimeType: "video/mp4",
      sizeBytes: 1024,
    });

    await expect(
      writerClient.importCompositionBundle({
        projectId: "demo",
        payload: JSON.stringify(bundleWithMissingAsset),
        format: "json",
        targetCompositionId: "existing-comp",
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });

    // Verify existing-comp was not modified by any failed import
    const checkComp = await readerClient.getComposition("demo", "existing-comp");
    expect(checkComp.headRevision).toBe(1);
    expect(
      checkComp.revisionRecord.document.shots["shot-1"].description,
    ).toBe("Untouched existing shot");
  });
});
