import { describe, expect, it } from "vitest";
import {
  AUTHORING_POLICY_VERSION,
  REQUIRED_REVIEW_CHECKS,
  type MotionReference,
} from "@vflow/protocol";
import { createTestHarness } from "./helpers.ts";
import {
  approveMotion,
  motionAssets,
  motionDocument,
  motionProject as projectId,
  seedMotion,
} from "./motion-fixture.ts";
import { seedReferences } from "./reference-fixture.ts";

const codes = (value: { diagnostics: Array<{ code: string }> }) =>
  value.diagnostics.map((d) => d.code);
const passAll = Object.fromEntries(
  REQUIRED_REVIEW_CHECKS.motion_reference.map((c) => [c, "pass" as const]),
);
const accepted = (checks: Record<string, "pass" | "fail" | "unknown"> = passAll) => ({
  method: "human" as const,
  reviewer: "x",
  decision: "accepted" as const,
  evidence: "Full playback and every keyframe inspected for this test.",
  checks,
});

describe("E2E 18 — motion_reference lifecycle (L0 external white-model)", () => {
  it("M01 submit → review → approve freezes an immutable revision; every content edit needs a new review", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    await motionAssets(h.writerClient);
    const doc = motionDocument(f);

    // A review smuggled through CRUD is discarded: submission never carries approval.
    const smuggled = structuredClone(doc);
    smuggled.review = accepted();
    const put = await h.writerClient.putAuthoringDocument({
      projectId,
      document: smuggled,
      baseRevision: 0,
      operationId: "m-put",
    });
    expect(put).toMatchObject({ revision: 1, status: "candidate" });
    expect((put.document as MotionReference).review).toBeUndefined();
    // Approval of an unreviewed document is refused with a machine-readable reason.
    await expect(
      h.writerClient.approveAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: 1,
        operationId: "m-approve-early",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    // An accepted review must pass every required check explicitly.
    for (const missing of REQUIRED_REVIEW_CHECKS.motion_reference)
      await expect(
        h.writerClient.reviewAuthoringDocument({
          projectId,
          id: doc.id,
          baseRevision: 1,
          operationId: `m-review-${missing}`,
          targets: ["$document"],
          review: accepted({ ...passAll, [missing]: "unknown" }),
        }),
      ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    // Only the whole document can be reviewed.
    await expect(
      h.writerClient.reviewAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: 1,
        operationId: "m-review-target",
        targets: ["kf-start"],
        review: accepted(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Agents cannot claim a human review.
    await h.agentAClient.getAuthoringWorkflow(projectId);
    await expect(
      h.agentAClient.reviewAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: 1,
        operationId: "m-review-agent",
        targets: ["$document"],
        review: accepted(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const reviewed = await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: doc.id,
      baseRevision: 1,
      operationId: "m-review",
      targets: ["$document"],
      review: accepted(),
    });
    expect(reviewed).toMatchObject({ revision: 2, status: "candidate" });
    const approved = await h.writerClient.approveAuthoringDocument({
      projectId,
      id: doc.id,
      baseRevision: 2,
      operationId: "m-approve",
    });
    expect(approved).toMatchObject({ revision: 3, status: "approved" });
    expect(approved.document).toEqual(reviewed.document);

    // Any content change appends a candidate revision without a review; the approved
    // revision stays readable and byte-identical (it is what a composition pins).
    const edited = structuredClone(doc);
    edited.keyframes[0].note = "改写说明";
    const next = await h.writerClient.putAuthoringDocument({
      projectId,
      document: edited,
      baseRevision: 3,
      operationId: "m-edit",
    });
    expect(next).toMatchObject({ revision: 4, status: "candidate" });
    expect((next.document as MotionReference).review).toBeUndefined();
    await expect(
      h.writerClient.approveAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: 4,
        operationId: "m-approve-edit",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    expect(
      await h.writerClient.getAuthoringDocument(projectId, doc.id, 3),
    ).toEqual(approved);
    // Stale base revisions are conflicts, never last-write-wins.
    await expect(
      h.writerClient.putAuthoringDocument({
        projectId,
        document: edited,
        baseRevision: 3,
        operationId: "m-stale",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("M02 reader/non-member/agent roles: only writers mutate, readers and members read, outsiders see nothing", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    await motionAssets(h.writerClient);
    const doc = motionDocument(f);
    await h.readerClient.getAuthoringWorkflow(projectId);
    await expect(
      h.readerClient.putAuthoringDocument({
        projectId,
        document: doc,
        baseRevision: 0,
        operationId: "r-put",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.outsiderClient.getAuthoringWorkflow(projectId).catch(() => {});
    await expect(
      h.outsiderClient.putAuthoringDocument({
        projectId,
        document: doc,
        baseRevision: 0,
        operationId: "o-put",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A writer agent may submit candidates (review/approve still need explicit evidence).
    await h.agentAClient.getAuthoringWorkflow(projectId);
    expect(
      await h.agentAClient.putAuthoringDocument({
        projectId,
        document: doc,
        baseRevision: 0,
        operationId: "a-put",
      }),
    ).toMatchObject({ status: "candidate" });
    const approved = await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: doc.id,
      baseRevision: 1,
      operationId: "w-review",
      targets: ["$document"],
      review: accepted(),
    });
    await expect(
      h.readerClient.approveAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: approved.revision,
        operationId: "r-approve",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.readerClient.reviewAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: approved.revision,
        operationId: "r-review",
        targets: ["$document"],
        review: accepted(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Readers can read and validate; outsiders cannot even read.
    expect(
      (await h.readerClient.getAuthoringDocument(projectId, doc.id)).document
        .kind,
    ).toBe("motion_reference");
    expect(
      (await h.readerClient.listAuthoringDocuments(projectId)).some(
        (r) => r.id === doc.id,
      ),
    ).toBe(true);
    expect(
      (await h.readerClient.validateAuthoringDocument(projectId, doc))
        .diagnostics,
    ).toBeDefined();
    await expect(
      h.outsiderClient.getAuthoringDocument(projectId, doc.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.outsiderClient.listAuthoringDocuments(projectId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.anonymousClient.getAuthoringDocument(projectId, doc.id),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("M03 write failures leave no half revision and retries are idempotent", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    await motionAssets(h.writerClient);
    const doc = motionDocument(f);
    const put = {
      projectId,
      document: doc,
      baseRevision: 0,
      operationId: "m-put",
    };
    h.domain.store.injectFaultOnce("authoringWrite");
    await expect(h.writerClient.putAuthoringDocument(put)).rejects.toMatchObject(
      { code: "INTERNAL_ERROR" },
    );
    await expect(
      h.writerClient.getAuthoringDocument(projectId, doc.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rev1 = await h.writerClient.putAuthoringDocument(put);
    expect(await h.writerClient.putAuthoringDocument(put)).toEqual(rev1);
    await expect(
      h.writerClient.putAuthoringDocument({ ...put, document: { ...doc, title: "changed" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const review = {
      projectId,
      id: doc.id,
      baseRevision: 1,
      operationId: "m-review",
      targets: ["$document"],
      review: accepted(),
    };
    h.domain.store.injectFaultOnce("authoringWrite");
    await expect(
      h.writerClient.reviewAuthoringDocument(review),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, doc.id)).revision,
    ).toBe(1);
    const rev2 = await h.writerClient.reviewAuthoringDocument(review);
    expect(await h.writerClient.reviewAuthoringDocument(review)).toEqual(rev2);

    const approve = {
      projectId,
      id: doc.id,
      baseRevision: 2,
      operationId: "m-approve",
    };
    h.domain.store.injectFaultOnce("authoringWrite");
    await expect(
      h.writerClient.approveAuthoringDocument(approve),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, doc.id)).status,
    ).toBe("candidate");
    expect(
      (await h.writerClient.approveAuthoringDocument(approve)).status,
    ).toBe("approved");
  });

  it("M04 a rejected review blocks approval; later pending edits cannot restore production eligibility", async () => {
    const h = createTestHarness(),
      f = await seedReferences(h.writerClient);
    await motionAssets(h.writerClient);
    const doc = motionDocument(f);
    const approved = await approveMotion(h.writerClient, doc);
    expect(approved.status).toBe("approved");
    const rejected = await h.writerClient.reviewAuthoringDocument({
      projectId,
      id: doc.id,
      baseRevision: approved.revision,
      operationId: "m-reject",
      targets: ["$document"],
      review: {
        method: "human",
        reviewer: "x",
        decision: "rejected",
        evidence: "Second look: the camera path does not match the shot.",
        checks: { timing_verified: "fail" },
      },
    });
    expect(rejected.status).toBe("candidate");
    await expect(
      h.writerClient.approveAuthoringDocument({
        projectId,
        id: doc.id,
        baseRevision: rejected.revision,
        operationId: "m-approve-rejected",
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REVIEW_REQUIRED" });
    // The previously approved revision is still readable for historical pins.
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, doc.id, approved.revision)).status,
    ).toBe("approved");
  });

  it("M05 the revision and its reviewers/actors stay auditable; lifecycle docs list via REST and MCP alike", async () => {
    const h = createTestHarness(),
      f = await seedMotion(h.writerClient);
    const viaRest = await h.writerClient.listAuthoringDocuments(projectId);
    const viaMcp = await h.writerClient.callMcpTool<unknown[]>(
      "authoring_document_list",
      { projectId },
    );
    expect(viaMcp).toEqual(viaRest);
    const record = viaRest.find((r) => r.id === f.motion.document.id)!;
    expect(Object.values(record.revisions).map((r) => r.status)).toEqual([
      "candidate",
      "candidate",
      "approved",
    ]);
    expect(record.revisions[3].actorId).toBe("alice@talkincode.net");
    expect(
      (record.revisions[3].document as MotionReference).review?.reviewer,
    ).toBe("alice@talkincode.net");
    expect(AUTHORING_POLICY_VERSION).toBe("reference-authoring/1");
    expect(codes({ diagnostics: [] })).toEqual([]);
  });
});
