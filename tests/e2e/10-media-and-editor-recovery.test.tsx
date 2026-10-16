// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import {
  createTestHarness,
  HUMAN_READER_HEADERS,
  HUMAN_WRITER_HEADERS,
  OUTSIDER_HEADERS,
} from "./helpers.ts";
import { seedWorkbench } from "./workbench-fixture.ts";
import { createApiApp } from "../../apps/api/src/app.ts";

afterEach(cleanup);
async function setup() {
  const harness = createTestHarness();
  await seedWorkbench(harness.writerClient);
  render(
    <Workbench
      client={harness.writerClient}
      projectId="demo"
      compositionId="episode-001"
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("composition-title").textContent).toBe(
      "雨巷 · 第一集",
    ),
  );
  return {
    ...harness,
    current: () => harness.writerClient.getComposition("demo", "episode-001"),
    input: () => screen.getByLabelText("画面提示词") as HTMLTextAreaElement,
    save: () => fireEvent.click(screen.getByTestId("inspector-save-btn")),
    revision: (n: number) =>
      waitFor(() =>
        expect(screen.getByTestId("composition-revision").textContent).toBe(
          `修订 #${n}`,
        ),
      ),
  };
}
describe("E2E 10 — 真实媒体读取与草稿恢复", () => {
  it("serves authorized full/partial media, rejects outsiders and invalid ranges, and recovers after a missing object", async () => {
    const { app, domain } = createApiApp();
    const { VideoComposeClient } = await import("@video-compose/client");
    const client = new VideoComposeClient({
      baseUrl: "https://video-compose.talkincode.net",
      fetchFn: async (input, init) =>
        app.fetch(new Request(String(input), init)),
      headers: HUMAN_WRITER_HEADERS,
    });
    await seedWorkbench(client);
    const url = client.assetContentUrl("demo", "preview-mp4");
    for (const headers of [HUMAN_WRITER_HEADERS, HUMAN_READER_HEADERS]) {
      const full = await app.fetch(new Request(url, { headers }));
      expect(full.status).toBe(200);
      expect(full.headers.get("cache-control")).toContain("private");
      const length = (await full.arrayBuffer()).byteLength;
      const part = await app.fetch(
        new Request(url, { headers: { ...headers, range: "bytes=10-19" } }),
      );
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes 10-19/${length}`);
      expect((await part.arrayBuffer()).byteLength).toBe(10);
      const suffix = await app.fetch(
        new Request(url, { headers: { ...headers, range: "bytes=-10" } }),
      );
      expect(suffix.status).toBe(206);
      expect((await suffix.arrayBuffer()).byteLength).toBe(10);
      const head = await app.fetch(
        new Request(url, { method: "HEAD", headers }),
      );
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      for (const range of [
        "bytes=999999999-",
        "bytes=-0",
        "bytes=3-1",
        "bytes=0-1,4-5",
        "invalid",
      ])
        expect(
          (
            await app.fetch(
              new Request(url, { headers: { ...headers, range } }),
            )
          ).status,
        ).toBe(416);
    }
    expect(
      (await app.fetch(new Request(url, { headers: OUTSIDER_HEADERS }))).status,
    ).toBe(403);
    expect((await app.fetch(new Request(url))).status).toBe(401);
    const asset = await domain.getAsset(
      { actorId: "alice@talkincode.net", actorKind: "human" },
      "demo",
      "preview-png",
    );
    const original = await domain.store.bucket.get(asset.storageKey);
    await domain.store.bucket.delete(asset.storageKey);
    expect(
      (
        await app.fetch(
          new Request(client.assetContentUrl("demo", asset.id), {
            headers: HUMAN_READER_HEADERS,
          }),
        )
      ).status,
    ).toBe(404);
    await domain.store.bucket.put(
      asset.storageKey,
      original!.data,
      original!.mimeType,
    );
    expect(
      (
        await app.fetch(
          new Request(client.assetContentUrl("demo", asset.id), {
            headers: HUMAN_READER_HEADERS,
          }),
        )
      ).status,
    ).toBe(200);
  });
  it("preserves per-shot drafts across tabs, same-shot selection and refresh; saves empty prompts and all edited fields together", async () => {
    const h = await setup();
    fireEvent.change(h.input(), { target: { value: "多段草稿\n第二行" } });
    fireEvent.change(screen.getByTestId("inspector-desc-input"), {
      target: { value: "新描述" },
    });
    fireEvent.click(screen.getByTestId("navigate-shot-001"));
    expect(h.input().value).toContain("多段草稿");
    fireEvent.click(screen.getByTestId("navigate-shot-002"));
    expect(h.input().value).toBe("画面提示词 2");
    fireEvent.click(screen.getByRole("tab", { name: "素材" }));
    fireEvent.click(screen.getByRole("tab", { name: "分镜" }));
    fireEvent.click(screen.getByTestId("navigate-shot-001"));
    expect(h.input().value).toContain("多段草稿");
    fireEvent.change(h.input(), { target: { value: "" } });
    h.save();
    await h.revision(2);
    const shot = (await h.current()).revisionRecord.document.shots["shot-001"];
    expect(shot.prompts.image).toBe("");
    expect(shot.description).toBe("新描述");
    fireEvent.click(screen.getByTestId("navigate-shot-002"));
    expect(
      screen.getByTestId("inspector-resolved-subjects").textContent,
    ).not.toContain("信使");
  });
  it("keeps the exact payload and idempotency key through a failed transaction and safe retry", async () => {
    const h = await setup();
    const spy = vi.spyOn(h.writerClient, "patchComposition");
    h.domain.store.injectFaultOnce("patchComposition");
    fireEvent.change(h.input(), { target: { value: "不能丢失的草稿" } });
    h.save();
    await waitFor(() =>
      expect(screen.getByTestId("workbench-error")).toBeDefined(),
    );
    expect(h.input().value).toBe("不能丢失的草稿");
    expect((await h.current()).headRevision).toBe(1);
    h.save();
    await h.revision(2);
    expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]);
    expect(
      (await h.current()).revisionRecord.document.shots["shot-001"].prompts
        .image,
    ).toBe("不能丢失的草稿");
  });
  it("does not rebase conflicting drafts silently or overwrite an Agent edit", async () => {
    const h = await setup();
    fireEvent.change(h.input(), { target: { value: "我的草稿" } });
    await h.writerClient.patchComposition({
      projectId: "demo",
      compositionId: "episode-001",
      baseRevision: 1,
      operationId: "other-edit",
      operations: [
        {
          op: "update_shot_fields",
          shotId: "shot-001",
          prompts: { image: "其他人的修改" },
        },
      ],
    });
    h.save();
    await waitFor(() =>
      expect(screen.getByTestId("workbench-error").textContent).toContain(
        "冲突",
      ),
    );
    expect(h.input().value).toBe("我的草稿");
    expect(
      (await h.current()).revisionRecord.document.shots["shot-001"].prompts
        .image,
    ).toBe("其他人的修改");
    // Only this explicit reconciliation creates a new base; a second save is deliberate.
    fireEvent.click(screen.getByTestId("rebase-draft"));
    h.save();
    await h.revision(3);
    expect(
      (await h.current()).revisionRecord.document.shots["shot-001"].prompts
        .image,
    ).toBe("我的草稿");
  });
  it("atomically retries a failed batch duration change and reorders stable IDs without changing shot bindings", async () => {
    const h = await setup();
    fireEvent.click(screen.getByLabelText("批量选择 shot-001"));
    fireEvent.click(screen.getByLabelText("批量选择 shot-002"));
    fireEvent.change(screen.getByLabelText("批量时长秒数"), {
      target: { value: "4" },
    });
    const spy = vi.spyOn(h.writerClient, "patchComposition");
    h.domain.store.injectFaultOnce("patchComposition");
    fireEvent.click(screen.getByRole("button", { name: "应用时长" }));
    await waitFor(() =>
      expect(screen.getByTestId("workbench-error")).toBeDefined(),
    );
    const failed = await h.current();
    expect(failed.headRevision).toBe(1);
    expect(
      failed.revisionRecord.document.shots["shot-001"].durationFrames,
    ).toBe(90);
    expect(
      failed.revisionRecord.document.shots["shot-002"].durationFrames,
    ).toBe(90);
    fireEvent.click(screen.getByRole("button", { name: "应用时长" }));
    await h.revision(2);
    expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]);
    const batched = (await h.current()).revisionRecord.document;
    expect(batched.shots["shot-001"].durationFrames).toBe(120);
    expect(batched.shots["shot-002"].durationFrames).toBe(120);
    h.domain.store.injectFaultOnce("patchComposition");
    fireEvent.click(screen.getByRole("button", { name: "后移" }));
    await waitFor(() =>
      expect(screen.getByTestId("workbench-error")).toBeDefined(),
    );
    expect((await h.current()).revisionRecord.document.sequence).toEqual(
      batched.sequence,
    );
    fireEvent.click(screen.getByRole("button", { name: "后移" }));
    await h.revision(3);
    const reordered = (await h.current()).revisionRecord.document;
    expect(reordered.sequence).toEqual(["shot-002", "shot-001", "shot-003"]);
    expect(reordered.shots).toEqual(batched.shots);
  });
  it("undoes local edits in sequence without toggling snapshots or undoing concurrent unrelated fields", async () => {
    const h = await setup();
    fireEvent.change(screen.getByTestId("inspector-desc-input"), {
      target: { value: "B" },
    });
    h.save();
    await h.revision(2);
    fireEvent.change(screen.getByTestId("inspector-desc-input"), {
      target: { value: "C" },
    });
    h.save();
    await h.revision(3);
    await h.writerClient.patchComposition({
      projectId: "demo",
      compositionId: "episode-001",
      baseRevision: 3,
      operationId: "audio-disjoint",
      operations: [
        {
          op: "update_shot_fields",
          shotId: "shot-001",
          prompts: { audio: "Agent旁白" },
        },
      ],
    });
    fireEvent.click(screen.getByTestId("btn-undo"));
    await h.revision(5);
    expect(
      (await h.current()).revisionRecord.document.shots["shot-001"].description,
    ).toBe("B");
    fireEvent.click(screen.getByTestId("btn-undo"));
    await h.revision(6);
    const shot = (await h.current()).revisionRecord.document.shots["shot-001"];
    expect(shot.description).toBe("镜头 1 雨巷");
    expect(shot.prompts.audio).toBe("Agent旁白");
    expect((screen.getByTestId("btn-undo") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("creates a candidate with real references, approves explicitly and binds the pinned variant", async () => {
    const h = await setup();
    fireEvent.click(screen.getByRole("tab", { name: "角色与道具" }));
    fireEvent.click(screen.getByText("+ 新建设定"));
    fireEvent.change(screen.getByLabelText("设定名称"), {
      target: { value: "侦察无人机" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "创建候选设定",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText("preview-png"));
    fireEvent.click(screen.getByRole("button", { name: "创建候选设定" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "侦察无人机" })).toBeDefined(),
    );
    fireEvent.click(screen.getByText("批准此版本与参考图"));
    await waitFor(() =>
      expect(screen.queryByText("批准此版本与参考图")).toBeNull(),
    );
    const subject = (await h.writerClient.listSubjects("demo")).find(
      (s) => s.name === "侦察无人机",
    )!;
    const card = screen.getByTestId(`library-subject-${subject.id}`);
    fireEvent.click(card.querySelector("button")!);
    await h.revision(2);
    expect(
      (await h.current()).revisionRecord.document.shots["shot-001"].subjects,
    ).toContainEqual({
      subjectId: subject.id,
      subjectRevision: 1,
      variant: "default",
    });
  });
});
