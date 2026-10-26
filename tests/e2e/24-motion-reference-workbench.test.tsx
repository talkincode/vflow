// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORING_POLICY_VERSION,
  REQUIRED_REVIEW_CHECKS,
  type MotionReference,
} from "@vflow/protocol";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import { createTestHarness } from "./helpers.ts";
import {
  motionAssets,
  motionDocument,
  motionProject as projectId,
  seedMotion,
} from "./motion-fixture.ts";
import { seedReferences } from "./reference-fixture.ts";

afterEach(() => cleanup());

const openAuthoring = async () => {
  await waitFor(() => screen.getByTestId("composition-title"));
  fireEvent.click(screen.getByRole("tab", { name: "参考制作" }));
  await screen.findByText("先把参考说清楚，再进入镜头");
};
const editor = () =>
  screen.getByLabelText("参考结构 JSON") as HTMLTextAreaElement;
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const editJson = (mutate: (doc: Record<string, unknown>) => void) => {
  const doc = JSON.parse(editor().value);
  mutate(doc);
  fireEvent.change(editor(), { target: { value: JSON.stringify(doc) } });
};

describe("E2E 24 — workbench shows the white-model video and drives review, pin, plan and evidence", () => {
  it("W01 viewer plays the video, lists keyframes by moment, labels archive/usage, and read-only roles cannot write", async () => {
    const h = createTestHarness();
    const f = await seedMotion(h.writerClient);
    render(
      <Workbench
        client={h.readerClient}
        projectId={projectId}
        compositionId="main"
      />,
    );
    await openAuthoring();
    fireEvent.click(
      await screen.findByRole("button", {
        name: `${f.motion.document.title} motion_reference · r3 · approved`,
      }),
    );
    const view = await screen.findByTestId("motion-reference");
    expect(view.textContent).toContain("镜头 spell");
    expect(view.textContent).toContain("场景 bridge@3/night");
    expect(view.textContent).toContain("24 fps · 96 帧（4.00 秒");
    expect(view.textContent).toContain("机位运动、走位、动作时序");
    expect(view.textContent).toContain("不是身份、服装或环境参考图");
    expect(view.textContent).toContain("accepted");
    expect(view.textContent).toContain("suwei@1/default、boat@1/default");
    const video = within(screen.getByTestId("motion-video")).getByLabelText(
      "播放 mo-video",
    ) as HTMLVideoElement;
    expect(video.getAttribute("src")).toContain(
      `/v1/projects/${projectId}/assets/mo-video/content`,
    );
    expect(video.hasAttribute("controls")).toBe(true);
    expect(
      within(screen.getByTestId("motion-overview")).getByAltText("mo-overview"),
    ).toBeDefined();
    const keyframes = within(screen.getByTestId("motion-keyframes"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(keyframes).toHaveLength(3);
    expect(keyframes[0]).toContain("kf-start");
    expect(keyframes[0]).toContain("第 0 帧");
    expect(keyframes[0]).toContain("走位");
    expect(keyframes[1]).toContain("第 48 帧（2.00 秒）");
    expect(keyframes[2]).toContain("动作时序");
    const source = within(view).getByRole("link", { name: "下载 mo-source" });
    expect(source.getAttribute("href")).toContain("/assets/mo-source/content");
    expect(view.textContent).toContain("永不作为生成输入");
    // Reader: inspect-only.
    expect(
      (screen.getByRole("button", { name: "保存候选修订" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "批准为参考" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("group", {
          name: /白模动态参考（整体审阅，须完整播放）/,
        }) as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
  });

  it("W02 writer authors through the wizard, reviews the whole document, approves, pins, plans an explicit keyframe degrade and records actual motion", async () => {
    const h = createTestHarness();
    const f = await seedReferences(h.writerClient);
    await motionAssets(h.writerClient);
    render(
      <Workbench
        client={h.writerClient}
        projectId={projectId}
        compositionId="main"
      />,
    );
    await openAuthoring();

    // Wizard: type + scene owner prefill composition, shot, scene, subjects and the whole-shot duration.
    fireEvent.change(screen.getByLabelText("新建参考类型"), {
      target: { value: "motion_reference" },
    });
    // Owners load with the material catalog; wait for the scene option like a user would.
    await screen.findByRole("option", { name: "scene:bridge@3/night" });
    fireEvent.change(screen.getByLabelText("参考归属"), {
      target: { value: "scene:bridge@3/night" },
    });
    click("创建候选草稿");
    const draft = JSON.parse(editor().value) as MotionReference;
    expect(draft).toMatchObject({
      kind: "motion_reference",
      compositionId: "main",
      compositionRevision: 1,
      shotId: "spell",
      scene: { id: "bridge", revision: 3 },
      environmentVariant: "night",
      fps: 30,
      durationFrames: 120,
    });
    expect(draft.subjects.map((s) => `${s.id}@${s.revision}/${s.variant}`)).toEqual([
      "suwei@1/default",
      "boat@1/default",
    ]);
    // Authoring the document body stays in the sidecar editor (this is not a 3D editor).
    const complete = motionDocument(f, "ui-motion");
    editJson((d) => Object.assign(d, complete));
    click("保存候选修订");
    await screen.findByText("候选修订已保存，尚未批准。");
    // The saved candidate is shown with its media as soon as it exists.
    expect(await screen.findByTestId("motion-reference")).toBeDefined();
    // Approval is refused before any review (no hidden approval path).
    click("批准为参考");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("not ready"),
    );
    // Whole-document review: no per-panel selection is required.
    const fieldset = screen.getByRole("group", {
      name: /白模动态参考（整体审阅，须完整播放）/,
    });
    for (const check of REQUIRED_REVIEW_CHECKS.motion_reference)
      fireEvent.change(within(fieldset).getByLabelText(`检查 ${check}`), {
        target: { value: "pass" },
      });
    fireEvent.change(screen.getByLabelText("视觉审阅结论"), {
      target: { value: "accepted" },
    });
    fireEvent.change(screen.getByLabelText("审阅证据"), {
      target: { value: "完整播放白模视频，逐个关键帧核对帧位置。" },
    });
    click("记录当前项审阅");
    await screen.findByText("审阅已形成新修订；仍须明确批准。");
    click("批准为参考");
    await screen.findByText("参考已批准；旧修订与镜头绑定保持原样。");
    click("固定到此编排");
    await waitFor(() =>
      expect(screen.getByTestId("composition-revision").textContent).toBe(
        "修订 #2",
      ),
    );
    expect(
      (await h.writerClient.getComposition(projectId, "main")).revisionRecord
        .document.authoring!.materials,
    ).toContainEqual({ id: "ui-motion", revision: 3 });

    // Plan: an unverified capability is reported, the keyframe degrade must be chosen on purpose.
    click("新建输入计划");
    const plan = () =>
      screen.getByLabelText("生成输入计划") as HTMLTextAreaElement;
    type Plan = {
      inputs: Array<{ role: string }>;
      capabilities: Record<string, unknown>;
      prompt: string;
    };
    const edit = (mutate: (p: Plan) => void) => {
      const value = JSON.parse(plan().value);
      mutate(value);
      fireEvent.change(plan(), { target: { value: JSON.stringify(value) } });
    };
    edit((p) => {
      p.inputs = [p.inputs[0]];
      p.capabilities = {
        verifiedAt: new Date().toISOString(),
        evidence: "Verified target accepts three image references.",
        maxImages: 4,
        roles: [p.inputs[0].role],
        supportsGridSequence: false,
      };
      p.prompt = "施法镜头";
    });
    fireEvent.change(screen.getByLabelText("白模动态参考"), {
      target: { value: "ui-motion@3" },
    });
    fireEvent.change(screen.getByLabelText("白模交付方式"), {
      target: { value: "video" },
    });
    click("写入输入计划");
    expect(JSON.parse(plan().value).motion).toEqual({
      reference: { id: "ui-motion", revision: 3 },
      usage: ["camera_motion", "blocking", "action_timing"],
      delivery: "video",
    });
    click("准备并检查输入包");
    await screen.findByText(/MOTION_VIDEO_CAPABILITY_REQUIRED/);
    expect(screen.queryByTestId("generation-packet")).toBeNull();
    // Explicit degrade without naming keyframes is refused rather than defaulted.
    fireEvent.change(screen.getByLabelText("白模交付方式"), {
      target: { value: "keyframes" },
    });
    expect(JSON.parse(plan().value).motion.delivery).toBe("video");
    click("写入输入计划");
    edit((p) => {
      p.capabilities.motion = {
        keyframes: { usages: ["camera_motion", "blocking", "action_timing"] },
      };
    });
    click("准备并检查输入包");
    await screen.findByText(/MOTION_KEYFRAMES_REQUIRED/);
    for (const id of ["kf-start", "kf-mid", "kf-end"])
      fireEvent.click(screen.getByLabelText(`选择关键帧 ${id}`));
    click("写入输入计划");
    expect(JSON.parse(plan().value).motion.keyframeIds).toEqual([
      "kf-start",
      "kf-mid",
      "kf-end",
    ]);
    click("准备并检查输入包");
    const packet = await screen.findByTestId("generation-packet");
    const motion = within(packet).getByTestId("generation-motion");
    expect(motion.textContent).toContain("显式降级：仅发送所选关键帧（整段视频不会发送）");
    expect(motion.textContent).toContain("kf-mid · 第 48 帧");
    expect(within(motion).queryByLabelText("播放 mo-video")).toBeNull();
    // Actual motion report defaults to the plan and is stored with the evidence.
    const actualMotion = screen.getByLabelText(
      "实际白模输入记录",
    ) as HTMLTextAreaElement;
    expect(JSON.parse(actualMotion.value)).toMatchObject({
      delivery: "keyframes",
      keyframes: [{ asset: "mo-kf-start" }, { asset: "mo-kf-mid" }, { asset: "mo-kf-end" }],
    });
    fireEvent.change(screen.getByLabelText("证据等级"), {
      target: { value: "agent_reported" },
    });
    fireEvent.change(screen.getByLabelText("实际执行证据"), {
      target: { value: "外部运行记录：三个关键帧 + 身份图。" },
    });
    fireEvent.change(screen.getByLabelText("输出素材 ID（逗号分隔）"), {
      target: { value: "panel-one" },
    });
    click("保存执行证据");
    await screen.findByText("实际输入证据已保存；请根据差异决定是否采用输出。");
    const reports = await h.writerClient.listGenerationEvidence(projectId);
    expect(reports).toHaveLength(1);
    expect(reports[0].actualMotion?.delivery).toBe("keyframes");
    expect(reports[0].matchesPlan).toBe(true);
    expect((await screen.findByTestId("evidence-motion")).textContent).toContain(
      "计划 3 个关键帧 · 回报 3 个关键帧",
    );
    expect(AUTHORING_POLICY_VERSION).toBe("reference-authoring/1");
  });

  it("W03 failed review/save keeps the draft and the reviewer's checks; invalid plan JSON never loses the plan", async () => {
    const h = createTestHarness();
    const f = await seedMotion(h.writerClient);
    render(
      <Workbench
        client={h.writerClient}
        projectId={projectId}
        compositionId="main"
      />,
    );
    await openAuthoring();
    fireEvent.click(
      await screen.findByRole("button", {
        name: `${f.motion.document.title} motion_reference · r3 · approved`,
      }),
    );
    await screen.findByTestId("motion-reference");
    editJson((d) => {
      d.title = "修改后的标题";
    });
    h.domain.store.injectFaultOnce("authoringWrite");
    click("保存候选修订");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("草稿已保留"),
    );
    expect(JSON.parse(editor().value).title).toBe("修改后的标题");
    click("保存候选修订");
    await screen.findByText("候选修订已保存，尚未批准。");
    // The edit produced an unreviewed candidate: approval is blocked and the approved revision is untouched.
    click("批准为参考");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("not ready"),
    );
    expect(
      (await h.writerClient.getAuthoringDocument(projectId, "spell-motion", 3))
        .status,
    ).toBe("approved");
    click("新建输入计划");
    fireEvent.change(screen.getByLabelText("生成输入计划"), {
      target: { value: "{broken" },
    });
    click("写入输入计划");
    expect(screen.getByRole("alert").textContent).toContain("草稿已保留");
    expect((screen.getByLabelText("生成输入计划") as HTMLTextAreaElement).value).toBe(
      "{broken",
    );
  });
});
