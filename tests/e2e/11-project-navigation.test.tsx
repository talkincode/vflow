// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProjectOverview } from "@video-compose/domain";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../apps/web/src/App.tsx";
import { ProjectsPage, ProjectPage } from "../../apps/web/src/Projects.tsx";
import { compositionUrl, projectUrl } from "../../apps/web/src/routes.ts";
import { createTestHarness } from "./helpers.ts";
import { seedWorkbench } from "./workbench-fixture.ts";
import { seedProjectLibrary, projectComposition } from "./project-fixture.ts";

afterEach(cleanup);
async function seeded() {
  const harness = createTestHarness();
  await seedWorkbench(harness.writerClient);
  await seedProjectLibrary(harness.writerClient);
  return harness;
}
describe("E2E 11 — 项目入口、编排导航与创建恢复", () => {
  it("lists only authorized projects and shares overview/composition-list semantics across REST and MCP", async () => {
    const h = await seeded();
    expect(
      (await h.readerClient.listProjects()).map((p) => p.id).sort(),
    ).toEqual(["city", "demo"]);
    const overview = await h.readerClient.getProjectOverview("demo");
    expect(overview.role).toBe("reader");
    expect(overview.assetCount).toBe(3);
    expect(overview.subjectCount).toBe(1);
    expect(overview.compositions.map((c) => c.id)).toEqual([
      "episode-001",
      "episode-002",
    ]);
    expect(
      await h.readerClient.callMcpTool<ProjectOverview>("project_overview", {
        projectId: "demo",
      }),
    ).toEqual(overview);
    expect(
      await h.readerClient.callMcpTool("composition_list", {
        projectId: "demo",
      }),
    ).toEqual(await h.readerClient.listCompositions("demo"));
    await expect(
      h.readerClient.getProjectOverview("private"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.outsiderClient.getProjectOverview("demo"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.anonymousClient.getProjectOverview("demo"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    render(<ProjectPage client={h.readerClient} projectId="demo" />);
    await waitFor(() =>
      expect(screen.getByTestId("project-role").textContent).toBe("只读项目"),
    );
    expect(
      (screen.getByRole("button", { name: "＋ 新建编排" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await expect(
      h.readerClient.createComposition({
        projectId: "demo",
        document: projectComposition("demo", "bypass", "bypass", "bypass"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await h.writerClient.listCompositions("demo")).toHaveLength(2);
  });

  it("creates a project from an empty library, keeps the form on transaction failure and retries the identical request", async () => {
    const h = createTestHarness();
    const navigate = vi.fn();
    render(<ProjectsPage client={h.writerClient} navigate={navigate} />);
    await screen.findByText("这里还没有项目");
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "山间来信" },
    });
    fireEvent.change(screen.getByLabelText("项目简介"), {
      target: { value: "山村纪录影像" },
    });
    const spy = vi.spyOn(h.writerClient, "createProject");
    h.domain.store.injectFaultOnce("createProject");
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("项目名称") as HTMLInputElement).value).toBe(
      "山间来信",
    );
    expect(await h.writerClient.listProjects()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]);
    const [project] = await h.writerClient.listProjects();
    expect(project.name).toBe("山间来信");
    expect(project.description).toBe("山村纪录影像");
    expect(navigate).toHaveBeenCalledWith(projectUrl(project.id));
  });

  it("creates a composition with selected format after an atomic failure and keeps existing compositions untouched", async () => {
    const h = await seeded();
    const navigate = vi.fn();
    const before = await h.writerClient.getComposition("demo", "episode-001");
    render(
      <ProjectPage
        client={h.writerClient}
        projectId="demo"
        navigate={navigate}
      />,
    );
    await screen.findByTestId("project-title");
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建编排" }));
    fireEvent.change(screen.getByLabelText("编排名称"), {
      target: { value: "竖屏预告" },
    });
    fireEvent.change(screen.getByLabelText("画面规格"), {
      target: { value: "portrait" },
    });
    fireEvent.change(screen.getByLabelText("编排帧率"), {
      target: { value: "24" },
    });
    h.domain.store.injectFaultOnce("createComposition");
    const spy = vi.spyOn(h.writerClient, "createComposition");
    fireEvent.click(screen.getByRole("button", { name: "创建编排" }));
    await screen.findByRole("alert");
    expect(await h.writerClient.listCompositions("demo")).toHaveLength(2);
    expect((screen.getByLabelText("编排名称") as HTMLInputElement).value).toBe(
      "竖屏预告",
    );
    fireEvent.click(screen.getByRole("button", { name: "创建编排" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]);
    const request = spy.mock.calls[0][0];
    const created = (
      await h.writerClient.getComposition("demo", request.document.id)
    ).revisionRecord.document;
    expect(created.format).toEqual({ width: 1080, height: 1920, fps: 24 });
    expect(created.shots["shot-001"].durationFrames).toBe(72);
    expect(navigate).toHaveBeenCalledWith(
      compositionUrl("demo", request.document.id),
    );
    expect(await h.writerClient.getComposition("demo", "episode-001")).toEqual(
      before,
    );
  });

  it("replays successful creation after a lost response, rejects altered payloads and rechecks current permissions", async () => {
    const h = createTestHarness();
    const request = {
      id: "receipt-project",
      name: "Receipt",
      description: "",
      members: { "bob-reader@talkincode.net": "writer" as const },
      operationId: "project-once",
    };
    const project = await h.writerClient.createProject(request);
    expect(await h.writerClient.callMcpTool("project_create", request)).toEqual(
      project,
    );
    await expect(
      h.writerClient.createProject({ ...request, name: "Overwrite" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h.outsiderClient.createProject(request)).rejects.toMatchObject(
      { code: "ALREADY_EXISTS" },
    );
    const composition = {
      projectId: project.id,
      document: projectComposition(project.id, "one", "第一条", "开场"),
      operationId: "composition-once",
    };
    const revision = await h.writerClient.createComposition(composition);
    expect(
      await h.writerClient.callMcpTool("composition_create", composition),
    ).toEqual(revision);
    await expect(
      h.writerClient.createComposition({
        ...composition,
        document: { ...composition.document, title: "Overwrite" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await h.writerClient.listProjects()).toHaveLength(1);
    expect(await h.writerClient.listCompositions(project.id)).toHaveLength(1);
    await h.domain.setProjectMemberRole(
      { actorId: "bob-reader@talkincode.net", actorKind: "human" },
      {
        projectId: project.id,
        targetActorId: "alice@talkincode.net",
        role: "reader",
      },
    );
    await expect(h.writerClient.createProject(request)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      h.writerClient.createComposition(composition),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Being a reader in another project does not prevent creating one's own project.
    const own = await h.writerClient.createProject({ id: "own", name: "Own" });
    expect((await h.writerClient.getProjectOverview(own.id)).role).toBe(
      "writer",
    );
  });

  it("scopes workbenches by project and composition even when shots share IDs", async () => {
    const h = await seeded();
    const view = render(
      <App
        client={h.writerClient}
        pathname={compositionUrl("demo", "episode-001")}
      />,
    );
    await screen.findByTestId("composition-title");
    fireEvent.change(screen.getByLabelText("画面提示词"), {
      target: { value: "仅属于雨巷的草稿" },
    });
    view.rerender(
      <App
        client={h.writerClient}
        pathname={compositionUrl("city", "episode-001")}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("composition-title").textContent).toBe(
        "城市 · 第一集",
      ),
    );
    expect(
      (screen.getByLabelText("画面提示词") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(
      screen.getByTestId("inspector-resolved-subjects").textContent,
    ).not.toContain("信使");
    fireEvent.click(screen.getByRole("tab", { name: "素材" }));
    expect(screen.queryByText("preview-png")).toBeNull();
    view.rerender(
      <App
        client={h.writerClient}
        pathname={compositionUrl("demo", "episode-001")}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("composition-title").textContent).toBe(
        "雨巷 · 第一集",
      ),
    );
    expect(
      (screen.getByLabelText("画面提示词") as HTMLTextAreaElement).value,
    ).toBe("画面提示词 1");
  });

  it("opens encoded identifiers, returns from forbidden/missing links and never bootstraps a guessed target", async () => {
    const h = await seeded();
    const unicodeId = "城市 空间";
    await h.writerClient.createProject({ id: unicodeId, name: "编码项目" });
    await h.writerClient.createComposition({
      projectId: unicodeId,
      document: projectComposition(unicodeId, "第一集", "编码编排", "开场"),
    });
    const view = render(
      <App
        client={h.writerClient}
        pathname={compositionUrl(unicodeId, "第一集")}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("composition-title").textContent).toBe(
        "编码编排",
      ),
    );
    view.rerender(
      <App client={h.readerClient} pathname={projectUrl("private")} />,
    );
    await screen.findByRole("alert");
    expect(screen.queryByTestId("project-title")).toBeNull();
    expect(
      screen.getByRole("link", { name: "返回项目列表" }).getAttribute("href"),
    ).toBe("/");
    view.rerender(
      <App
        client={h.writerClient}
        pathname={compositionUrl("demo", "not-created")}
      />,
    );
    await screen.findByRole("alert");
    expect(screen.queryByTestId("btn-bootstrap-project")).toBeNull();
    expect(await h.writerClient.listCompositions("demo")).toHaveLength(2);
    view.rerender(<App client={h.writerClient} pathname="/projects/%broken" />);
    await screen.findByText("没有找到这个页面，请检查地址或返回项目列表。");
  });
});
