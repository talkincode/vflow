// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCompositionDelivery } from "@vflow/protocol";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import { createTestHarness } from "./helpers.ts";
import { seedWorkbench } from "./workbench-fixture.ts";

afterEach(cleanup);
describe("E2E25 — fixed revision handoff without remote side effects", () => {
  it("writer resolves missing outputs; reader can inspect/export the same fixed revision; outsiders cannot export", async () => {
    const h = createTestHarness();
    await seedWorkbench(h.writerClient, 1);
    render(<Workbench client={h.writerClient} projectId="demo" compositionId="episode-001" />);
    await screen.findByTestId("composition-title");
    fireEvent.click(screen.getByRole("tab", { name: "协议" }));
    expect((screen.getByLabelText("filmkit 拉取命令") as HTMLTextAreaElement).value).toContain("--revision 1 --mode production");
    fireEvent.change(screen.getByLabelText("filmkit 交接方式"), { target: { value: "assemble" } });
    expect(screen.queryByLabelText("filmkit 拉取命令")).toBeNull();
    expect(screen.getByText("请选择可用的最终视频。", { exact: false })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "素材" }));
    const buttons = screen.getAllByText("选用为当前镜头输出");
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(screen.getByTestId("composition-revision").textContent).toBe("修订 #2"));
    fireEvent.click(screen.getByRole("tab", { name: "协议" }));
    expect((screen.getByLabelText("filmkit 拉取命令") as HTMLTextAreaElement).value).toContain("--revision 2 --mode assemble");
    cleanup();
    render(<Workbench client={h.readerClient} projectId="demo" compositionId="episode-001" />);
    await screen.findByTestId("composition-title");
    fireEvent.click(screen.getByRole("tab", { name: "协议" }));
    fireEvent.change(screen.getByLabelText("filmkit 交接方式"), { target: { value: "assemble" } });
    expect(screen.getByLabelText("filmkit 拉取命令")).toBeDefined();
    const exported = await h.readerClient.exportCompositionBundle({ projectId: "demo", compositionId: "episode-001", revision: 2, format: "json" });
    expect(inspectCompositionDelivery(exported.bundle.composition, exported.bundle.dependencies.assets).ready).toBe(true);
    await expect(h.outsiderClient.exportCompositionBundle({ projectId: "demo", compositionId: "episode-001", format: "json" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await h.writerClient.getComposition("demo", "episode-001")).headRevision).toBe(2);
  });

  it("unsaved drafts block handoff, failed save retains draft, retry exposes only the committed revision", async () => {
    const h = createTestHarness();
    await seedWorkbench(h.writerClient, 1);
    render(<Workbench client={h.writerClient} projectId="demo" compositionId="episode-001" />);
    await screen.findByTestId("composition-title");
    fireEvent.change(screen.getByLabelText("画面提示词"), { target: { value: "保持草稿" } });
    fireEvent.click(screen.getByRole("tab", { name: "协议" }));
    expect(screen.queryByLabelText("filmkit 拉取命令")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "分镜" }));
    h.domain.store.injectFaultOnce("patchComposition");
    fireEvent.click(screen.getByTestId("inspector-save-btn"));
    await screen.findByTestId("workbench-error");
    expect((screen.getByLabelText("画面提示词") as HTMLTextAreaElement).value).toBe("保持草稿");
    fireEvent.click(screen.getByTestId("inspector-save-btn"));
    await waitFor(() => expect(screen.getByTestId("composition-revision").textContent).toBe("修订 #2"));
    fireEvent.click(screen.getByRole("tab", { name: "协议" }));
    expect((screen.getByLabelText("filmkit 拉取命令") as HTMLTextAreaElement).value).toContain("--revision 2");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    fireEvent.click(screen.getByText("复制拉取命令"));
    await screen.findByText("无法访问剪贴板，请选择上方命令手动复制。");
    expect(screen.getByLabelText("filmkit 拉取命令")).toBeDefined();
  });

  it("checks selected media, missing durations and track overruns without mutating the exported design", async () => {
    const h = createTestHarness();
    await seedWorkbench(h.writerClient, 1);
    const { bundle } = await h.readerClient.exportCompositionBundle({ projectId: "demo", compositionId: "episode-001", format: "json" });
    const before = JSON.stringify(bundle);
    expect(inspectCompositionDelivery(bundle.composition, bundle.dependencies.assets).issues.some((i) => i.path.endsWith("selected.video"))).toBe(true);
    expect(JSON.stringify(bundle)).toBe(before);
    const changed = structuredClone(bundle.composition);
    delete changed.shots["shot-001"].durationFrames;
    changed.shots["shot-001"].selected.audio = "preview-png";
    changed.audioTracks[0].durationFrames = 10000;
    const issues = inspectCompositionDelivery(changed, bundle.dependencies.assets).issues;
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["shots.shot-001.durationFrames", "shots.shot-001.selected.audio", "audioTracks[0]"]));
  });
});
