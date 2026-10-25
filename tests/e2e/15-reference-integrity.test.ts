import fs from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_VERSION,
  AUTHORING_POLICY_VERSION,
  REQUIRED_REVIEW_CHECKS,
  type ReferencePack,
  type MaterialRevision,
} from "@video-compose/protocol";
import { createTestHarness } from "./helpers.ts";
import {
  approveMaterial,
  referenceAssets,
  referencePack,
  referenceProject as projectId,
  seedReferences,
} from "./reference-fixture.ts";

// Valid synthetic PNG, never derived from personal production images.
function png(width: number, height: number): Uint8Array {
  const crc = (bytes: Uint8Array) => {
    let n = 0xffffffff;
    for (const b of bytes) {
      n ^= b;
      for (let bit = 0; bit < 8; bit++)
        n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, bytes: Uint8Array) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 96);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

describe("E2E 15 — grids, lineage, rollback and legacy migration", () => {
  it("A05/A09 verifies source bounds/hash, independent prop cells and exact role/count selection without partial approval", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    await h.writerClient.uploadAsset({
      projectId,
      assetId: "lantern-front",
      mimeType: "image/png",
      bytes: png(320, 180),
    });
    const board = await h.writerClient.uploadAsset({
      projectId,
      assetId: "prop-board",
      mimeType: "image/png",
      bytes: png(640, 180),
    });
    await h.writerClient.createSubject({
      projectId,
      id: "lantern",
      name: "灯",
      kind: "prop",
      status: "candidate",
      defaultVariant: "default",
      definition: { description: "船尾灯", invariants: ["铜框"] },
      variants: {
        default: {
          description: "默认",
          referencePack: [{ asset: "lantern-front", status: "candidate" }],
        },
      },
    });
    const lantern = {
      kind: "prop" as const,
      id: "lantern",
      revision: 1,
      variant: "default",
    };
    const catalog: ReferencePack = {
      schemaVersion: AUTHORING_VERSION,
      id: "prop-catalog",
      title: "道具目录",
      kind: "reference_pack",
      category: "prop_catalog",
      board: {
        asset: board.id,
        rows: 1,
        columns: 2,
        readingOrder: "row-major",
      },
      views: [f.boat, lantern].map((owner, i) => ({
        id: `cell-${i}`,
        asset: i ? "lantern-front" : "prop-front",
        owner,
        purpose: "prop",
        view: "front",
        source: {
          asset: board.id,
          sha256: board.sha256,
          regionPx: { x: i * 320, y: 0, width: 320, height: 180 },
        },
      })),
      sources: [],
      conflicts: [],
    };
    const invalid = structuredClone(catalog);
    invalid.views[1].source!.regionPx.x = 100;
    await expect(
      h.writerClient.putAuthoringDocument({
        projectId,
        document: invalid,
        baseRevision: 0,
        operationId: "catalog-put",
      }),
    ).rejects.toMatchObject({ code: "STORYBOARD_LAYOUT_INVALID" });
    await expect(
      h.writerClient.getAuthoringDocument(projectId, catalog.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const invalidHash = structuredClone(catalog);
    invalidHash.views[0].source!.sha256 = "0".repeat(64);
    expect(
      (await h.writerClient.validateAuthoringDocument(projectId, invalidHash))
        .ready,
    ).toBe(false);
    const duplicate = structuredClone(catalog);
    duplicate.views[1].id = duplicate.views[0].id;
    expect(
      (await h.writerClient.validateAuthoringDocument(projectId, duplicate))
        .diagnostics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "STORYBOARD_LAYOUT_INVALID" }),
      ]),
    );
    const missingTile = structuredClone(catalog);
    missingTile.views[1].asset = board.id;
    expect(
      (await h.writerClient.validateAuthoringDocument(projectId, missingTile))
        .diagnostics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GRID_CELL_REQUIRED" }),
      ]),
    );
    const approved = await approveMaterial(h.writerClient, catalog);
    await h.writerClient.approveSubjectRevision({
      projectId,
      subjectId: "lantern",
      revision: 1,
      operationId: "lantern-approve",
    });
    await h.writerClient.patchComposition({
      projectId,
      compositionId: "main",
      baseRevision: 1,
      operationId: "pin-catalog",
      operations: [
        {
          op: "set_authoring",
          authoring: {
            policyVersion: AUTHORING_POLICY_VERSION,
            materials: [
              ...f.document.authoring!.materials,
              { id: catalog.id, revision: approved.revision },
            ],
          },
        },
      ],
    });
    const selected = await h.writerClient.prepareGenerationInputs(projectId, {
      ...f.request,
      compositionRevision: 2,
      inputs: [
        {
          source: { pack: { id: catalog.id, revision: 3 }, viewId: "cell-0" },
          role: "prop",
        },
      ],
    });
    expect(selected.ready).toBe(true);
    expect(selected.packet?.inputs).toHaveLength(1);
    expect(selected.packet?.inputs[0]).toMatchObject({
      asset: "prop-front",
      owner: f.boat,
      sourceBoard: "prop-board",
    });
    const wrongSubject = await h.writerClient.prepareGenerationInputs(
      projectId,
      {
        ...f.request,
        compositionRevision: 2,
        inputs: [
          {
            source: { pack: { id: catalog.id, revision: 3 }, viewId: "cell-1" },
            role: "prop",
          },
        ],
      },
    );
    expect(wrongSubject.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "REFERENCE_SCOPE_MISMATCH" }),
      ]),
    );
    // Client-declared dimensions cannot bypass parsing the uploaded bytes.
    await h.writerClient.uploadAsset({
      projectId,
      assetId: "invalid-image",
      mimeType: "image/png",
      bytes: new TextEncoder().encode("not a PNG"),
      width: 320,
      height: 180,
    });
    const spoof = referencePack("spoof", "character_face", f.suwei, "face");
    spoof.views[0].asset = "invalid-image";
    await expect(
      h.writerClient.putAuthoringDocument({
        projectId,
        document: spoof,
        baseRevision: 0,
        operationId: "spoof",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DIMENSIONS_UNVERIFIED" });
  });

  it("A13/A15 rejects cyclic imports, forged reviews and concurrent changes; failed approve and review writes are recoverable", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    const recovery = referencePack(
      "recovery-face",
      "character_face",
      f.suwei,
      "face",
    );
    let rev = await h.writerClient.putAuthoringDocument({
      projectId,
      document: recovery,
      baseRevision: 0,
      operationId: "recovery-put",
    });
    // CRUD cannot manufacture visual acceptance.
    const forged = structuredClone(recovery);
    forged.views.forEach((v) => {
      v.review = {
        decision: "accepted",
        method: "human",
        reviewer: "forged",
        evidence: "forged",
        checks: Object.fromEntries(
          REQUIRED_REVIEW_CHECKS.character_face.map((c) => [c, "pass"]),
        ),
      };
    });
    rev = await h.writerClient.putAuthoringDocument({
      projectId,
      document: forged,
      baseRevision: rev.revision,
      operationId: "forged-put",
    });
    expect(
      rev.document.kind === "reference_pack" && rev.document.views[0].review,
    ).toBeUndefined();
    const review = {
      projectId,
      id: recovery.id,
      baseRevision: rev.revision,
      operationId: "recover-review",
      targets: ["front", "side"],
      review: {
        decision: "accepted" as const,
        method: "human" as const,
        reviewer: "user",
        evidence: "Inspected both independent face views",
        checks: Object.fromEntries(
          REQUIRED_REVIEW_CHECKS.character_face.map((c) => [
            c,
            "pass" as const,
          ]),
        ),
      },
    };
    h.domain.store.injectFaultOnce("authoringWrite");
    await expect(
      h.writerClient.reviewAuthoringDocument(review),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, recovery.id))
        .revision,
    ).toBe(2);
    rev = await h.writerClient.reviewAuthoringDocument(review);
    const approve = {
      projectId,
      id: recovery.id,
      baseRevision: rev.revision,
      operationId: "recover-approve",
    };
    h.domain.store.injectFaultOnce("authoringWrite");
    await expect(
      h.writerClient.approveAuthoringDocument(approve),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, recovery.id))
        .status,
    ).toBe("candidate");
    rev = await h.writerClient.approveAuthoringDocument(approve);
    expect(rev.status).toBe("approved");
    await expect(
      h.writerClient.reviewAuthoringDocument({
        ...review,
        operationId: "concurrent-stale",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await h.agentAClient.getAuthoringWorkflow(projectId);
    await expect(
      h.agentAClient.reviewAuthoringDocument({
        ...review,
        baseRevision: rev.revision,
        operationId: "agent-human",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const exported = await h.writerClient.exportCompositionBundle({
      projectId,
      compositionId: "main",
      format: "json",
    });
    const records: MaterialRevision[] = ["cycle-a", "cycle-b"].map((id, i) => ({
      ...f.face,
      revision: 1,
      document: {
        ...(structuredClone(f.face.document) as ReferencePack),
        id,
        sources: [
          {
            pack: { id: i ? "cycle-a" : "cycle-b", revision: 1 },
            viewId: "front",
          },
        ],
      },
    }));
    exported.bundle.dependencies.materials!.push(...records);
    exported.bundle.composition.authoring!.materials.push({
      id: "cycle-a",
      revision: 1,
    });
    await h.writerClient.createProject({ id: "cyclic-import", name: "Cycle" });
    await h.writerClient.getAuthoringWorkflow("cyclic-import");
    await referenceAssets(h.writerClient, "cyclic-import");
    await expect(
      h.writerClient.importCompositionBundle({
        projectId: "cyclic-import",
        payload: JSON.stringify(exported.bundle),
        format: "json",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    expect(await h.writerClient.listCompositions("cyclic-import")).toHaveLength(
      0,
    );
    expect(
      (await h.writerClient.listAuthoringDocuments("cyclic-import")).map(
        (r) => r.id,
      ),
    ).toEqual(["workflow-policy"]);
    const impact = await h.writerClient.getAuthoringImpact(
      projectId,
      "suwei-face",
      3,
    );
    expect(impact.compositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "main", revision: 1 }),
      ]),
    );
    await expect(
      h.outsiderClient.getAuthoringImpact(projectId, "suwei-face", 3),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("A16 preserves all 31 main shots / 5316 frames and 32 B-roll / 4800 frames while classifying legacy v1 references", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient, "legacy");
    const video = new Uint8Array(
      await fs.readFile(new URL("../fixtures/preview.mp4", import.meta.url)),
    );
    await h.writerClient.uploadAsset({
      projectId,
      assetId: "selected-video",
      bytes: video,
      mimeType: "video/mp4",
    });
    for (const [id, count, total] of [
      ["mv-main", 31, 5316],
      ["mv-broll", 32, 4800],
    ] as const) {
      const sequence = Array.from({ length: count }, (_, i) => `shot-${i + 1}`);
      const document = {
        ...structuredClone(f.document),
        apiVersion: "video-compose/v1" as const,
        id,
        sequence,
        shots: Object.fromEntries(
          sequence.map((shotId, i) => [
            shotId,
            {
              ...structuredClone(f.document.shots.spell),
              durationFrames:
                i === count - 1
                  ? total - Math.floor(total / count) * (count - 1)
                  : Math.floor(total / count),
              candidates: {
                images: [],
                videos: [{ asset: "selected-video" }],
                audios: [],
              },
              selected: { video: "selected-video", audio: null },
            },
          ]),
        ),
      };
      delete document.authoring;
      await h.writerClient.createComposition({ projectId, document });
      await h.writerClient.patchComposition({
        projectId,
        compositionId: id,
        baseRevision: 1,
        operationId: `classify-${id}`,
        operations: [{ op: "set_authoring", authoring: f.document.authoring! }],
      });
      const after = (await h.writerClient.getComposition(projectId, id))
        .revisionRecord.document;
      expect(after.sequence).toEqual(document.sequence);
      expect(after.shots).toEqual(document.shots);
      expect(
        after.sequence.reduce(
          (sum, id) => sum + after.shots[id].durationFrames!,
          0,
        ),
      ).toBe(total);
      expect(
        (await h.writerClient.getComposition(projectId, id, 1)).revisionRecord
          .document,
      ).toEqual(document);
      const bundle = await h.writerClient.exportCompositionBundle({
        projectId,
        compositionId: id,
        format: "yaml",
      });
      expect(bundle.bundle.dependencies.materials).toHaveLength(5);
      await h.writerClient.createProject({
        id: `copy-${id}`,
        name: "Migration copy",
      });
      await h.writerClient.getAuthoringWorkflow(`copy-${id}`);
      await referenceAssets(h.writerClient, `copy-${id}`);
      await h.writerClient.uploadAsset({
        projectId: `copy-${id}`,
        assetId: "selected-video",
        bytes: video,
        mimeType: "video/mp4",
      });
      const imported = await h.writerClient.importCompositionBundle({
        projectId: `copy-${id}`,
        payload: bundle.serialized,
        format: "yaml",
      });
      expect(imported.document.sequence).toEqual(document.sequence);
      expect(imported.document.shots).toEqual(document.shots);
      await expect(
        h.writerClient.importCompositionBundle({
          projectId,
          targetCompositionId: id,
          payload: JSON.stringify({
            apiVersion: "video-compose/v1",
            composition: document,
            dependencies: {
              subjects: bundle.bundle.dependencies.subjects,
              assets: bundle.bundle.dependencies.assets,
            },
          }),
          format: "json",
        }),
      ).rejects.toMatchObject({ code: "UNREPRESENTABLE_IN_V1" });
      expect(
        (await h.writerClient.getComposition(projectId, id)).headRevision,
      ).toBe(2);
    }
    // Removing a policy simulates an existing D1 project predating this migration.
    await h.domain.store.runInTransaction("legacy-fixture", (draft) => {
      delete draft.materials[`${projectId}::workflow-policy`];
    });
    expect((await h.writerClient.getAuthoringWorkflow(projectId)).mode).toBe(
      "legacy",
    );
  });
});
