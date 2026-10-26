import { PROTOCOL_VERSION } from "@vflow/protocol";
import { describe, expect, it } from "vitest";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

describe("E2E 04 — 角色/道具设定与参考图管理 (Subject & Reference Pack Management)", () => {
  it("Happy Path: creates character & prop with candidate status, approves revisions, binds across compositions, and preserves old bindings when new subject revision is created", async () => {
    const { writerClient, agentAClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "demo",
      name: "Demo",
      members: {
        "agent-storyboard": "writer",
      },
    });

    // Upload reference images
    for (const assetId of [
      "weila-front-v1",
      "weila-side-v1",
      "weila-front-v2",
      "cup-intact-v1",
      "cup-damaged-v2",
    ]) {
      await writerClient.uploadAsset({
        projectId: "demo",
        assetId,
        bytes: utf8Bytes(`image-bytes-${assetId}`),
        mimeType: "image/png",
      });
    }

    // Create character in candidate status, attach second reference image, then approve
    const charCreated = await writerClient.createSubject({
      projectId: "demo",
      id: "char-weila",
      kind: "character",
      name: "微辣",
      defaultVariant: "studio",
      status: "candidate",
      definition: {
        description: "主播，写实面部特征",
        invariants: ["面部特征一致"],
      },
      variants: {
        studio: {
          description: "演播室日常造型",
          referencePack: [
            {
              asset: "weila-front-v1",
              view: "front",
              purpose: "identity",
              status: "candidate",
            },
          ],
        },
      },
    });
    expect(charCreated.revisions[1].status).toBe("candidate");

    // Agent attaches side view reference -> produces revision 2 (status: candidate)
    const charRev2Candidate = await agentAClient.attachSubjectReference({
      projectId: "demo",
      subjectId: "char-weila",
      baseRevision: 1,
      operationId: "attach-side-v1",
      variant: "studio",
      entry: {
        asset: "weila-side-v1",
        view: "side",
        purpose: "identity",
      },
    });
    expect(charRev2Candidate.revision).toBe(2);
    expect(charRev2Candidate.status).toBe("candidate");

    // Writer approves revision 2
    const charRev2Approved = await writerClient.approveSubjectRevision({
      projectId: "demo",
      subjectId: "char-weila",
      revision: 2,
      operationId: "approve-weila-r2",
    });
    expect(charRev2Approved.status).toBe("approved");
    expect(charRev2Approved.variants.studio.referencePack).toHaveLength(2);
    expect(
      charRev2Approved.variants.studio.referencePack.every(
        (r) => r.status === "approved",
      ),
    ).toBe(true);

    // Create and approve prop subject
    await writerClient.createSubject({
      projectId: "demo",
      id: "prop-cup",
      kind: "prop",
      name: "陶瓷杯",
      defaultVariant: "intact",
      status: "approved",
      definition: {
        description: "深灰陶瓷杯",
        invariants: ["哑光釉面"],
      },
      variants: {
        intact: {
          description: "完好状态",
          referencePack: [
            {
              asset: "cup-intact-v1",
              view: "front",
              status: "approved",
            },
          ],
        },
      },
    });

    // Bind in two separate compositions (including omitting variant to test defaultVariant)
    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-1",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-1"],
        shots: {
          "shot-1": {
            description: "Comp 1 shot",
            durationFrames: 100,
            dependsOn: [],
            subjects: [
              { subjectId: "char-weila", subjectRevision: 2 },
              { subjectId: "prop-cup", subjectRevision: 1, variant: "intact" },
            ],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-2",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-a"],
        shots: {
          "shot-a": {
            description: "Comp 2 shot",
            durationFrames: 100,
            dependsOn: [],
            subjects: [{ subjectId: "char-weila", subjectRevision: 2 }],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Evolve char-weila to revision 3 (new look) and approve
    await writerClient.patchSubject({
      projectId: "demo",
      subjectId: "char-weila",
      baseRevision: 2,
      operationId: "weila-new-look-r3",
      changes: {
        variants: {
          studio: {
            description: "新季度演播室造型",
            referencePack: [
              {
                asset: "weila-front-v2",
                view: "front",
                status: "candidate",
              },
            ],
          },
        },
      },
    });
    await writerClient.approveSubjectRevision({
      projectId: "demo",
      subjectId: "char-weila",
      revision: 3,
      operationId: "approve-weila-r3",
    });

    // Historical comp-1 still resolves revision 2's reference pack!
    const comp1Fetched = await writerClient.getComposition("demo", "comp-1");
    expect(
      comp1Fetched.resolvedSubjects["char-weila@2#studio"].referencePack.map(
        (r) => r.asset,
      ),
    ).toEqual(["weila-front-v1", "weila-side-v1"]);

    // Explicitly rebind comp-2 to revision 3
    await writerClient.patchComposition({
      projectId: "demo",
      compositionId: "comp-2",
      baseRevision: 1,
      operationId: "rebind-comp2-weila-r3",
      operations: [
        {
          op: "bind_shot_subject",
          shotId: "shot-a",
          binding: {
            subjectId: "char-weila",
            subjectRevision: 3,
            variant: "studio",
          },
        },
      ],
    });

    const comp2Fetched = await writerClient.getComposition("demo", "comp-2");
    expect(
      comp2Fetched.resolvedSubjects["char-weila@3#studio"].referencePack.map(
        (r) => r.asset,
      ),
    ).toEqual(["weila-front-v2"]);
  });

  it("Failure Path, Role Verification & Rollback: detects concurrent subject edit conflicts, blocks reader approval, and rejects binding unapproved candidate revisions", async () => {
    const { writerClient, readerClient, agentAClient, agentBClient } =
      createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "demo",
      name: "Demo",
      members: {
        "bob-reader@talkincode.net": "reader",
        "agent-storyboard": "writer",
        "agent-audio": "writer",
      },
    });

    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "ref-1",
      bytes: utf8Bytes("ref-1"),
      mimeType: "image/png",
    });

    await writerClient.createSubject({
      projectId: "demo",
      id: "char-hero",
      kind: "character",
      name: "Hero",
      defaultVariant: "base",
      status: "candidate",
      definition: { description: "Initial", invariants: ["Tall"] },
      variants: {
        base: {
          description: "Base look",
          referencePack: [{ asset: "ref-1", status: "candidate" }],
        },
      },
    });

    // Reader cannot approve revision
    await expect(
      readerClient.approveSubjectRevision({
        projectId: "demo",
        subjectId: "char-hero",
        revision: 1,
        operationId: "illegal-reader-approve",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Cannot bind unapproved candidate revision 1 to a composition shot
    await expect(
      writerClient.createComposition({
        projectId: "demo",
        document: {
          apiVersion: PROTOCOL_VERSION,
          id: "comp-unapproved-bind",
          project: "demo",
          format: { width: 1920, height: 1080, fps: 30 },
          audioTracks: [],
          sequence: ["shot-1"],
          shots: {
            "shot-1": {
              description: "Binds unapproved subject",
              durationFrames: 60,
              dependsOn: [],
              subjects: [{ subjectId: "char-hero", subjectRevision: 1 }],
              references: { images: [], videos: [] },
              prompts: {},
              candidates: { images: [], videos: [], audios: [] },
              selected: { video: null, audio: null },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });

    // Concurrent conflicting edits to the same subject semantic field from baseRevision=1
    await agentAClient.patchSubject({
      projectId: "demo",
      subjectId: "char-hero",
      baseRevision: 1,
      operationId: "agentA-desc",
      changes: { description: "Agent A updated description" },
    });

    await expect(
      agentBClient.patchSubject({
        projectId: "demo",
        subjectId: "char-hero",
        baseRevision: 1,
        operationId: "agentB-desc-conflict",
        changes: { description: "Agent B conflicting description" },
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    // Verify Agent A's revision 2 is intact and not overwritten
    const afterConflict = await readerClient.getSubject("demo", "char-hero", 2);
    expect(afterConflict.snapshot.definition.description).toBe(
      "Agent A updated description",
    );
  });
});
