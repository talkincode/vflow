import { PROTOCOL_VERSION } from "@video-compose/protocol";
import { describe, expect, it } from "vitest";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

describe("E2E 05 — 多 Agent 修订与审阅 (Multi-Agent Revisions & Review Proposals)", () => {
  it("Happy Path: merges disjoint concurrent Agent patches from stale baseRevision, processes review proposals, and restores historical revisions", async () => {
    const { writerClient, agentAClient, agentBClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "demo",
      name: "Demo",
      members: {
        "agent-storyboard": "writer",
        "agent-audio": "writer",
      },
    });

    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "vid-cand-1",
      bytes: utf8Bytes("video-candidate-1"),
      mimeType: "video/mp4",
    });
    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "bgm-global-1",
      bytes: utf8Bytes("bgm-global-1"),
      mimeType: "audio/mpeg",
    });

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-001",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001", "shot-002"],
        shots: {
          "shot-001": {
            description: "Shot 1 initial",
            durationFrames: 120,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: { video: "Initial prompt" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
          "shot-002": {
            description: "Shot 2 initial",
            durationFrames: 120,
            dependsOn: [{ shotId: "shot-001", kind: "continuity" }],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: { video: "Shot 2 prompt" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Agent A patches shot-001 (baseRevision = 1 -> resultRevision = 2)
    const patchA = await agentAClient.patchComposition({
      projectId: "demo",
      compositionId: "episode-001",
      baseRevision: 1,
      operationId: "op-agentA-1",
      operations: [
        {
          op: "attach_shot_candidate",
          shotId: "shot-001",
          mediaKind: "videos",
          candidate: { asset: "vid-cand-1", actor: "agent-storyboard" },
        },
        {
          op: "select_shot_output",
          shotId: "shot-001",
          mediaKind: "video",
          assetId: "vid-cand-1",
        },
      ],
    });
    expect(patchA.revisionRecord.revision).toBe(2);
    expect(patchA.changeRecord.autoMergedFromStaleBase).toBe(false);

    // Agent B concurrently submits a patch against STALE baseRevision = 1 on disjoint paths (global BGM + shot-002 description)
    const patchB = await agentBClient.patchComposition({
      projectId: "demo",
      compositionId: "episode-001",
      baseRevision: 1,
      operationId: "op-agentB-1",
      operations: [
        {
          op: "upsert_audio_track",
          track: {
            id: "track-bgm",
            role: "bgm",
            asset: "bgm-global-1",
            startFrame: 0,
            durationFrames: 240,
          },
        },
        {
          op: "update_shot_fields",
          shotId: "shot-002",
          description: "Shot 2 refined by Agent B",
        },
      ],
    });
    expect(patchB.revisionRecord.revision).toBe(3);
    expect(patchB.changeRecord.autoMergedFromStaleBase).toBe(true);

    // Both Agent A and Agent B changes are preserved in revision 3
    const mergedDoc = patchB.revisionRecord.document;
    expect(mergedDoc.shots["shot-001"].selected.video).toBe("vid-cand-1");
    expect(mergedDoc.shots["shot-002"].description).toBe(
      "Shot 2 refined by Agent B",
    );
    expect(mergedDoc.audioTracks).toHaveLength(1);
    expect(mergedDoc.audioTracks[0].asset).toBe("bgm-global-1");

    // Submit and approve a review Proposal
    const proposal = await agentAClient.submitProposal({
      projectId: "demo",
      compositionId: "episode-001",
      baseRevision: 3,
      operationId: "prop-op-1",
      description: "Extend shot-001 duration to 150 frames",
      operations: [
        {
          op: "update_shot_fields",
          shotId: "shot-001",
          durationFrames: 150,
        },
      ],
    });
    expect(proposal.status).toBe("open");

    const approved = await writerClient.approveProposal({
      projectId: "demo",
      proposalId: proposal.id,
      operationId: "approve-prop-1",
    });
    expect(approved.proposal.status).toBe("approved");
    expect(approved.revisionRecord.revision).toBe(4);
    expect(
      approved.revisionRecord.document.shots["shot-001"].durationFrames,
    ).toBe(150);

    // Restore historical revision 1
    const restored = await writerClient.restoreCompositionRevision({
      projectId: "demo",
      compositionId: "episode-001",
      targetRevision: 1,
      operationId: "restore-to-r1",
    });
    expect(restored.revision).toBe(5);
    expect(restored.document.audioTracks).toHaveLength(0);
    expect(restored.document.shots["shot-001"].selected.video).toBeNull();
  });

  it("Failure Path, Role Verification & Rollback: returns structured conflict on overlapping edits, blocks reader mutations, and preserves head revision", async () => {
    const { writerClient, agentAClient, agentBClient, agentReaderClient } =
      createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "demo",
      name: "Demo",
      members: {
        "agent-storyboard": "writer",
        "agent-audio": "writer",
        "agent-observer": "reader",
      },
    });

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-conflict",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Original description",
            durationFrames: 90,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: { video: "Original prompt" },
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Reader Agent cannot submit patch or proposal
    await expect(
      agentReaderClient.patchComposition({
        projectId: "demo",
        compositionId: "episode-conflict",
        baseRevision: 1,
        operationId: "illegal-reader-patch",
        operations: [
          {
            op: "update_shot_fields",
            shotId: "shot-001",
            description: "Tampered",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Agent A updates shot-001 video prompt (baseRevision=1 -> rev 2)
    await agentAClient.patchComposition({
      projectId: "demo",
      compositionId: "episode-conflict",
      baseRevision: 1,
      operationId: "agentA-prompt",
      operations: [
        {
          op: "update_shot_fields",
          shotId: "shot-001",
          prompts: { video: "Camera dolly in" },
        },
      ],
    });

    // Agent B concurrently edits the SAME field (shot-001 video prompt) from stale baseRevision=1 -> REVISION_CONFLICT
    await expect(
      agentBClient.patchComposition({
        projectId: "demo",
        compositionId: "episode-conflict",
        baseRevision: 1,
        operationId: "agentB-conflicting-prompt",
        operations: [
          {
            op: "update_shot_fields",
            shotId: "shot-001",
            prompts: { video: "Camera zoom out" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        baseRevision: 1,
        headRevision: 2,
      },
    });

    // Verify headRevision is still 2 with Agent A's value preserved
    const current = await agentReaderClient.getComposition(
      "demo",
      "episode-conflict",
    );
    expect(current.headRevision).toBe(2);
    expect(current.revisionRecord.document.shots["shot-001"].prompts.video).toBe(
      "Camera dolly in",
    );
  });
});
