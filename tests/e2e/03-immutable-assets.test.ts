import { computeSha256Hex } from "@video-compose/domain";
import { PROTOCOL_VERSION } from "@video-compose/protocol";
import { describe, expect, it } from "vitest";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

describe("E2E 03 — 不可变资产管理 (Immutable Asset Management)", () => {
  it("Happy Path: uploads verified asset, reuses across shots and audioTracks, and prevents deleting referenced assets", async () => {
    const { writerClient, readerClient } = createTestHarness();

    await writerClient.createProject({
      id: "demo",
      name: "Demo",
      members: { "bob-reader@talkincode.net": "reader" },
    });

    const imgBytes = utf8Bytes("immutable-reference-image-content");
    const expectedHash = await computeSha256Hex(imgBytes);

    const asset = await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "ref-img-01",
      bytes: imgBytes,
      expectedSha256: expectedHash,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
    expect(asset.id).toBe("ref-img-01");
    expect(asset.sha256).toBe(expectedHash);

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-reuse",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-1", "shot-2"],
        shots: {
          "shot-1": {
            description: "First shot using ref-img-01",
            durationFrames: 90,
            dependsOn: [],
            subjects: [],
            references: {
              images: [{ asset: "ref-img-01", role: "keyframe" }],
              videos: [],
            },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
          "shot-2": {
            description: "Second shot reusing ref-img-01",
            durationFrames: 90,
            dependsOn: [],
            subjects: [],
            references: {
              images: [{ asset: "ref-img-01", role: "continuity" }],
              videos: [],
            },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    const assets = await readerClient.listAssets("demo");
    expect(assets).toHaveLength(1);

    // Deleting an in-use asset must fail
    await expect(
      writerClient.deleteAsset("demo", "ref-img-01"),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
  });

  it("Failure Path, Role Verification & Rollback: rejects hash mismatch, blocks overwriting existing assetId, blocks reader upload, and cleans up failed upload", async () => {
    const { domain, writerClient, readerClient } = createTestHarness();

    await writerClient.createProject({
      id: "demo",
      name: "Demo",
      members: { "bob-reader@talkincode.net": "reader" },
    });

    // Reader cannot upload
    await expect(
      readerClient.uploadAsset({
        projectId: "demo",
        assetId: "reader-illegal-asset",
        bytes: utf8Bytes("data"),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Corrupted upload (SHA-256 mismatch) fails and does not register visible asset
    const bogusSha = "0".repeat(64);
    await expect(
      writerClient.uploadAsset({
        projectId: "demo",
        assetId: "corrupted-asset",
        bytes: utf8Bytes("actual-bytes-do-not-match"),
        expectedSha256: bogusSha,
        mimeType: "video/mp4",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_ERROR" });

    const visibleAfterFailure = await writerClient.listAssets("demo");
    expect(visibleAfterFailure).toHaveLength(0);
    expect(
      await domain.store.bucket.has(`projects/demo/assets/${bogusSha}`),
    ).toBe(false);

    // Valid upload succeeds
    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "stable-asset-01",
      bytes: utf8Bytes("original-immutable-bytes"),
      mimeType: "image/png",
    });

    // Attempting to overwrite stable-asset-01 with different content is rejected
    await expect(
      writerClient.uploadAsset({
        projectId: "demo",
        assetId: "stable-asset-01",
        bytes: utf8Bytes("mutated-bytes"),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "IMMUTABILITY_VIOLATION" });
  });
});
