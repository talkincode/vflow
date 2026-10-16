// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PROTOCOL_VERSION } from "@video-compose/protocol";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import { createTestHarness, utf8Bytes } from "./helpers.ts";

afterEach(() => {
  cleanup();
});

describe("E2E 07 — 轻量工作台 (Lightweight Three-View React Workbench)", () => {
  it("Happy Path: renders Grid, Manifest List (with global BGM), and Dependency Topology consistently, edits shot description, and undoes revision without data loss", async () => {
    const { writerClient } = createTestHarness();

    await writerClient.createProject({
      id: "demo",
      name: "Demo Workbench Project",
      members: {
        "bob-reader@talkincode.net": "reader",
      },
    });

    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "weila-ref-1",
      bytes: utf8Bytes("weila-ref-1"),
      mimeType: "image/png",
    });
    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "bgm-main",
      bytes: utf8Bytes("bgm-main"),
      mimeType: "audio/mpeg",
    });

    await writerClient.createSubject({
      projectId: "demo",
      id: "char-weila",
      kind: "character",
      name: "微辣",
      defaultVariant: "studio",
      status: "approved",
      definition: { description: "主播", invariants: ["自然比例"] },
      variants: {
        studio: {
          description: "演播室造型",
          referencePack: [{ asset: "weila-ref-1", status: "approved" }],
        },
      },
    });

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-001",
        project: "demo",
        title: "第一集工作台",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [
          {
            id: "track-bgm-main",
            role: "bgm",
            asset: "bgm-main",
            startFrame: 0,
            durationFrames: 300,
          },
        ],
        sequence: ["shot-001", "shot-002"],
        shots: {
          "shot-001": {
            description: "演播室全景开场",
            durationFrames: 150,
            dependsOn: [],
            subjects: [{ subjectId: "char-weila", subjectRevision: 1 }],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
          "shot-002": {
            description: "桌面特写推进",
            durationFrames: 150,
            dependsOn: [{ shotId: "shot-001", kind: "continuity" }],
            subjects: [{ subjectId: "char-weila", subjectRevision: 1 }],
            references: { images: [], videos: [] },
            prompts: {},
            candidates: { images: [], videos: [], audios: [] },
            selected: { video: null, audio: null },
          },
        },
      },
    });

    render(
      <Workbench
        client={writerClient}
        projectId="demo"
        compositionId="episode-001"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("composition-title").textContent).toBe(
        "第一集工作台",
      );
    });

    // 1. Grid View shows both shots
    expect(screen.getByTestId("shot-desc-shot-001").textContent).toBe(
      "演播室全景开场",
    );
    expect(screen.getByTestId("shot-desc-shot-002").textContent).toBe(
      "桌面特写推进",
    );

    // 2. Switch to Manifest List View -> verifies same shots + global BGM track
    fireEvent.click(screen.getByTestId("tab-list"));
    expect(screen.getByTestId("view-list")).toBeDefined();
    expect(screen.getByTestId("audio-track-track-bgm-main").textContent).toContain(
      "bgm-main",
    );
    expect(screen.getByTestId("shot-desc-shot-001").textContent).toBe(
      "演播室全景开场",
    );

    // 3. Switch to Dependency Topology View -> verifies DAG edge shot-001 -> shot-002
    fireEvent.click(screen.getByTestId("tab-topology"));
    expect(screen.getByTestId("view-topology")).toBeDefined();
    expect(screen.getByTestId("edge-shot-001-shot-002").textContent).toContain(
      "continuity",
    );

    // 4. Edit shot-001 description via Inspector and save -> Revision #2
    const input = screen.getByTestId("inspector-desc-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "演播室全景开场（已修改）" } });
    fireEvent.click(screen.getByTestId("inspector-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("composition-revision").textContent).toBe(
        "修订 #2",
      );
    });
    expect(screen.getByTestId("shot-desc-shot-001").textContent).toBe(
      "演播室全景开场（已修改）",
    );

    // 5. Undo Revision -> restores Revision #1 content as Revision #3
    fireEvent.click(screen.getByTestId("btn-undo"));
    await waitFor(() => {
      expect(screen.getByTestId("composition-revision").textContent).toBe(
        "修订 #3",
      );
    });
    expect(screen.getByTestId("shot-desc-shot-001").textContent).toBe(
      "演播室全景开场",
    );
  });

  it("Failure Path and Role Verification: read-only inspector disables edits and a direct API bypass leaves the authoritative state unchanged", async () => {
    const { writerClient, readerClient } = createTestHarness();

    await writerClient.createProject({
      id: "demo",
      name: "Demo",
      members: { "bob-reader@talkincode.net": "reader" },
    });

    await writerClient.createComposition({
      projectId: "demo",
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: "episode-001",
        project: "demo",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: {
          "shot-001": {
            description: "Authoritative description",
            durationFrames: 100,
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

    render(
      <Workbench
        client={readerClient}
        projectId="demo"
        compositionId="episode-001"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("shot-desc-shot-001").textContent).toBe(
        "Authoritative description",
      );
    });

    // Reader attempts to save a mutation via UI inspector
    const input = screen.getByTestId("inspector-desc-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Unauthorized UI mutation" } });
    fireEvent.click(screen.getByTestId("inspector-save-btn"));

    expect((screen.getByTestId("inspector-save-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("save-status").textContent).toBe("只读访问");
    await expect(readerClient.patchComposition({
      projectId: "demo", compositionId: "episode-001", baseRevision: 1,
      operationId: "reader-direct-bypass", operations: [{ op: "update_shot_fields", shotId: "shot-001", description: "Unauthorized direct mutation" }],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Authoritative state and revision remain untouched
    expect(screen.getByTestId("composition-revision").textContent).toBe(
      "修订 #1",
    );
    expect(screen.getByTestId("shot-desc-shot-001").textContent).toBe(
      "Authoritative description",
    );
  });
});
