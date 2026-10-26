// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PROTOCOL_VERSION,
  validateCompositionDocument,
} from "@vflow/protocol";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

beforeEach(() => {
  window.confirm = () => true;
});

afterEach(() => {
  cleanup();
});

describe("E2E 13 — 分镜素材图上限与管理 (Shot Material Candidates Max 5, Edit & Delete)", () => {
  it("Happy Path: allows up to 5 material images per shot, updates candidate metadata, and detaches candidate", async () => {
    const { writerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "proj-materials",
      name: "Material Test Project",
    });

    // Upload 5 test image assets
    for (let i = 1; i <= 5; i++) {
      await writerClient.uploadAsset({
        projectId: "proj-materials",
        assetId: `mat-img-00${i}`,
        bytes: utf8Bytes(`content-img-${i}`),
        mimeType: "image/jpeg",
        width: 1280,
        height: 720,
      });
    }

    await writerClient.createComposition({
      projectId: "proj-materials",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-materials",
        project: "proj-materials",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Opening shot with materials",
            durationFrames: 90,
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

    // 1. Attach 5 material images sequentially
    for (let i = 1; i <= 5; i++) {
      const comp = await writerClient.getComposition("proj-materials", "comp-materials");
      await writerClient.patchComposition({
        projectId: "proj-materials",
        compositionId: "comp-materials",
        baseRevision: comp.headRevision,
        operationId: `attach-op-${i}`,
        operations: [
          {
            op: "attach_shot_candidate",
            shotId: "shot-001",
            mediaKind: "images",
            candidate: {
              asset: `mat-img-00${i}`,
              role: `angle-${i}`,
              notes: `Candidate material ${i}`,
            },
          },
        ],
      });
    }

    // Verify shot has exactly 5 candidate images
    let comp = await writerClient.getComposition("proj-materials", "comp-materials");
    let shot = comp.revisionRecord.document.shots["shot-001"];
    expect(shot.candidates.images).toHaveLength(5);
    expect(shot.candidates.images.map((c) => c.asset)).toEqual([
      "mat-img-001",
      "mat-img-002",
      "mat-img-003",
      "mat-img-004",
      "mat-img-005",
    ]);

    // 2. Update candidate metadata (role, notes)
    await writerClient.patchComposition({
      projectId: "proj-materials",
      compositionId: "comp-materials",
      baseRevision: comp.headRevision,
      operationId: "update-cand-2",
      operations: [
        {
          op: "update_shot_candidate",
          shotId: "shot-001",
          mediaKind: "images",
          assetId: "mat-img-002",
          candidate: {
            role: "hero-angle-revised",
            notes: "Updated prompt notes for candidate 2",
          },
        },
      ],
    });

    comp = await writerClient.getComposition("proj-materials", "comp-materials");
    shot = comp.revisionRecord.document.shots["shot-001"];
    const cand2 = shot.candidates.images.find((c) => c.asset === "mat-img-002");
    expect(cand2?.role).toBe("hero-angle-revised");
    expect(cand2?.notes).toBe("Updated prompt notes for candidate 2");

    // 3. Detach candidate 3
    await writerClient.patchComposition({
      projectId: "proj-materials",
      compositionId: "comp-materials",
      baseRevision: comp.headRevision,
      operationId: "detach-cand-3",
      operations: [
        {
          op: "detach_shot_candidate",
          shotId: "shot-001",
          mediaKind: "images",
          assetId: "mat-img-003",
        },
      ],
    });

    comp = await writerClient.getComposition("proj-materials", "comp-materials");
    shot = comp.revisionRecord.document.shots["shot-001"];
    expect(shot.candidates.images).toHaveLength(4);
    expect(shot.candidates.images.some((c) => c.asset === "mat-img-003")).toBe(false);
  });

  it("Failure Path & Limit Enforcement: rejects attaching > 5 material images per shot and preserves state without corruption", async () => {
    const { writerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "proj-limit",
      name: "Limit Test Project",
    });

    for (let i = 1; i <= 6; i++) {
      await writerClient.uploadAsset({
        projectId: "proj-limit",
        assetId: `lim-img-${i}`,
        bytes: utf8Bytes(`lim-content-${i}`),
        mimeType: "image/png",
      });
    }

    await writerClient.createComposition({
      projectId: "proj-limit",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-limit",
        project: "proj-limit",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Shot testing candidate limits",
            durationFrames: 60,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: {
              images: [
                { asset: "lim-img-1" },
                { asset: "lim-img-2" },
                { asset: "lim-img-3" },
                { asset: "lim-img-4" },
                { asset: "lim-img-5" },
              ],
              videos: [],
              audios: [],
            },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // Attempting to attach a 6th candidate image must fail with VALIDATION_FAILED
    const compBefore = await writerClient.getComposition("proj-limit", "comp-limit");
    await expect(
      writerClient.patchComposition({
        projectId: "proj-limit",
        compositionId: "comp-limit",
        baseRevision: compBefore.headRevision,
        operationId: "overflow-attach-op",
        operations: [
          {
            op: "attach_shot_candidate",
            shotId: "shot-001",
            mediaKind: "images",
            candidate: { asset: "lim-img-6" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    // State is preserved, still at original revision and 5 candidates
    const compAfter = await writerClient.getComposition("proj-limit", "comp-limit");
    expect(compAfter.headRevision).toBe(compBefore.headRevision);
    expect(compAfter.revisionRecord.document.shots["shot-001"].candidates.images).toHaveLength(5);

    // Protocol schema validator also rejects > 5 candidate images
    const invalidDoc = structuredClone(compAfter.revisionRecord.document);
    invalidDoc.shots["shot-001"].candidates.images.push({ asset: "lim-img-6" });
    const validationResult = validateCompositionDocument(invalidDoc);
    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(
        validationResult.errors.some(
          (e) =>
            e.code === "INVALID_CANDIDATE_LIST" &&
            e.path.includes("candidates.images"),
        ),
      ).toBe(true);
    }
  });

  it("Asset Deletion: prevents deleting in-use candidate assets, and allows deleting unreferenced assets", async () => {
    const { writerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "proj-del",
      name: "Asset Deletion Project",
    });

    await writerClient.uploadAsset({
      projectId: "proj-del",
      assetId: "del-img-used",
      bytes: utf8Bytes("del-used"),
      mimeType: "image/jpeg",
    });
    await writerClient.uploadAsset({
      projectId: "proj-del",
      assetId: "del-img-free",
      bytes: utf8Bytes("del-free"),
      mimeType: "image/jpeg",
    });

    await writerClient.createComposition({
      projectId: "proj-del",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-del",
        project: "proj-del",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Shot with attached candidate",
            durationFrames: 60,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: {
              images: [{ asset: "del-img-used" }],
              videos: [],
              audios: [],
            },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    // 1. In-use candidate asset deletion must fail with DEPENDENCY_ERROR
    await expect(
      writerClient.deleteAsset("proj-del", "del-img-used"),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });

    // 2. Unreferenced asset deletion succeeds
    const delResult = await writerClient.deleteAsset("proj-del", "del-img-free");
    expect(delResult.deletedAssetId).toBe("del-img-free");
    const assets = await writerClient.listAssets("proj-del");
    expect(assets.some((a) => a.id === "del-img-free")).toBe(false);
  });

  it("MCP Parity: supports asset_link, asset_update_candidate, and asset_unlink via remote MCP tools", async () => {
    const { writerClient, agentAClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "proj-mcp-mat",
      name: "MCP Materials Project",
      members: {
        "agent-storyboard": "writer",
      },
    });

    await agentAClient.callMcpTool("asset_upload", {
      projectId: "proj-mcp-mat",
      assetId: "mcp-mat-01",
      contentBase64: btoa("mcp-mat-01-content"),
      mimeType: "image/png",
    });

    await agentAClient.callMcpTool("composition_create", {
      projectId: "proj-mcp-mat",
      operationId: "comp-mcp-op",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-mcp-mat",
        project: "proj-mcp-mat",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "MCP Shot",
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

    // 1. Link asset via MCP tool asset_link
    await agentAClient.callMcpTool("asset_link", {
      projectId: "proj-mcp-mat",
      compositionId: "comp-mcp-mat",
      baseRevision: 1,
      operationId: "mcp-link-op-1",
      shotId: "shot-001",
      assetId: "mcp-mat-01",
      mediaKind: "images",
      role: "mcp-initial-role",
    });

    let comp = await writerClient.getComposition("proj-mcp-mat", "comp-mcp-mat");
    expect(comp.revisionRecord.document.shots["shot-001"].candidates.images).toHaveLength(1);
    expect(comp.revisionRecord.document.shots["shot-001"].candidates.images[0].role).toBe("mcp-initial-role");

    // 2. Update candidate metadata via MCP tool asset_update_candidate
    await agentAClient.callMcpTool("asset_update_candidate", {
      projectId: "proj-mcp-mat",
      compositionId: "comp-mcp-mat",
      baseRevision: 2,
      operationId: "mcp-update-op-1",
      shotId: "shot-001",
      assetId: "mcp-mat-01",
      mediaKind: "images",
      role: "mcp-updated-role",
      notes: "updated via MCP tool",
    });

    comp = await writerClient.getComposition("proj-mcp-mat", "comp-mcp-mat");
    expect(comp.revisionRecord.document.shots["shot-001"].candidates.images[0].role).toBe("mcp-updated-role");
    expect(comp.revisionRecord.document.shots["shot-001"].candidates.images[0].notes).toBe("updated via MCP tool");

    // 3. Unlink asset via MCP tool asset_unlink
    await agentAClient.callMcpTool("asset_unlink", {
      projectId: "proj-mcp-mat",
      compositionId: "comp-mcp-mat",
      baseRevision: 3,
      operationId: "mcp-unlink-op-1",
      shotId: "shot-001",
      assetId: "mcp-mat-01",
      mediaKind: "images",
    });

    comp = await writerClient.getComposition("proj-mcp-mat", "comp-mcp-mat");
    expect(comp.revisionRecord.document.shots["shot-001"].candidates.images).toHaveLength(0);
  });

  it("Role Verification: reader cannot attach, detach or delete assets", async () => {
    const { writerClient, readerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "proj-role",
      name: "Role Project",
      members: {
        "bob-reader@talkincode.net": "reader",
      },
    });

    await writerClient.uploadAsset({
      projectId: "proj-role",
      assetId: "role-img-1",
      bytes: utf8Bytes("role-img"),
      mimeType: "image/png",
    });

    await writerClient.createComposition({
      projectId: "proj-role",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-role",
        project: "proj-role",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Role check shot",
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

    // Reader write operations fail with FORBIDDEN
    await expect(
      readerClient.patchComposition({
        projectId: "proj-role",
        compositionId: "comp-role",
        baseRevision: 1,
        operationId: "reader-attach-fail",
        operations: [
          {
            op: "attach_shot_candidate",
            shotId: "shot-001",
            mediaKind: "images",
            candidate: { asset: "role-img-1" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      readerClient.deleteAsset("proj-role", "role-img-1"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Workbench UI: displays material image count (X/5), allows editing candidate role/notes, detaching candidate, and deleting asset from library", async () => {
    const { writerClient } = createTestHarness();

    await writerClient.createProject({ authoringMode: "legacy",
      id: "proj-ui-mat",
      name: "UI Material Project",
    });

    await writerClient.uploadAsset({
      projectId: "proj-ui-mat",
      assetId: "ui-mat-001",
      bytes: utf8Bytes("ui-mat-001"),
      mimeType: "image/png",
    });
    await writerClient.uploadAsset({
      projectId: "proj-ui-mat",
      assetId: "ui-mat-002",
      bytes: utf8Bytes("ui-mat-002"),
      mimeType: "image/png",
    });
    await writerClient.uploadAsset({
      projectId: "proj-ui-mat",
      assetId: "ui-mat-003",
      bytes: utf8Bytes("ui-mat-003"),
      mimeType: "image/png",
    });

    await writerClient.createComposition({
      projectId: "proj-ui-mat",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "comp-ui-mat",
        project: "proj-ui-mat",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "UI test shot with material images",
            durationFrames: 60,
            dependsOn: [],
            subjects: [],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: {
              images: [{ asset: "ui-mat-001", role: "angle-1", notes: "Initial note" }],
              videos: [],
              audios: [],
            },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    render(
      <Workbench
        client={writerClient}
        projectId="proj-ui-mat"
        compositionId="comp-ui-mat"
      />,
    );

    // 1. Check Inspector displays candidate count 1/5
    await waitFor(() => {
      expect(screen.getByTestId("candidate-images-count").textContent).toContain("1/5");
    });
    expect(screen.getByTestId("candidate-card-ui-mat-001")).toBeDefined();

    // 2. Click "修改" on candidate card -> edit form appears
    fireEvent.click(screen.getByTestId("edit-candidate-ui-mat-001"));
    await waitFor(() => {
      expect(screen.getByTestId("edit-candidate-role-input")).toBeDefined();
    });
    const roleInput = screen.getByTestId("edit-candidate-role-input") as HTMLInputElement;
    const notesInput = screen.getByTestId("edit-candidate-notes-input") as HTMLInputElement;
    expect(roleInput.value).toBe("angle-1");
    expect(notesInput.value).toBe("Initial note");

    fireEvent.change(notesInput, { target: { value: "Updated via UI Inspector" } });
    fireEvent.click(screen.getByTestId("save-candidate-edit-btn"));

    await waitFor(() => {
      expect(screen.getByText("Updated via UI Inspector")).toBeDefined();
    });

    // 3. Switch to 素材 tab
    fireEvent.click(screen.getByRole("tab", { name: "素材" }));
    await waitFor(() => {
      expect(screen.getByTestId("asset-card-ui-mat-001")).toBeDefined();
    });

    // ui-mat-001 is attached -> has "从当前镜头移除" button
    expect(screen.getByTestId("detach-candidate-ui-mat-001").textContent).toContain("从当前镜头移除");

    // ui-mat-002 is not attached -> has "关联至当前镜头 (1/5)" button
    expect(screen.getByTestId("attach-candidate-ui-mat-002").textContent).toContain("关联至当前镜头 (1/5)");

    // Attach ui-mat-002 from library
    fireEvent.click(screen.getByTestId("attach-candidate-ui-mat-002"));
    await waitFor(() => {
      expect(screen.getByTestId("detach-candidate-ui-mat-002")).toBeDefined();
    });

    // Now detach ui-mat-001 from library
    fireEvent.click(screen.getByTestId("detach-candidate-ui-mat-001"));
    await waitFor(() => {
      expect(screen.getByTestId("attach-candidate-ui-mat-001")).toBeDefined();
    });

    // Now delete unreferenced ui-mat-003 from library
    fireEvent.click(screen.getByTestId("delete-asset-ui-mat-003"));
    await waitFor(() => {
      expect(screen.queryByTestId("asset-card-ui-mat-003")).toBeNull();
    });

    // Switch back to 分镜 tab
    fireEvent.click(screen.getByRole("tab", { name: "分镜" }));
    await waitFor(() => {
      expect(screen.getByTestId("candidate-images-count").textContent).toContain("1/5");
    });
    expect(screen.getByTestId("candidate-card-ui-mat-002")).toBeDefined();

    // Detach from inspector
    fireEvent.click(screen.getByTestId("detach-candidate-btn-ui-mat-002"));
    await waitFor(() => {
      expect(screen.getByTestId("candidate-images-count").textContent).toContain("0/5");
    });
  });
});
