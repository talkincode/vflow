import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
  expect((await request.post("/__test/motion-fixture")).ok()).toBe(true);
});

const openMotion = async (page: import("@playwright/test").Page) => {
  await page.goto("/projects/reference-test/compositions/main");
  await page.getByRole("tab", { name: "参考制作", exact: true }).click();
  await page
    .getByRole("button", {
      name: "施法镜头白模 motion_reference · r3 · approved",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("motion-reference")).toBeVisible();
};

test("M-UI: the white-model video decodes, plays and seeks; keyframes and overview decode; read-only roles cannot write", async ({
  page,
}) => {
  await openMotion(page);
  const video = page.getByTestId("motion-video").locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(
    await video.evaluate((v: HTMLVideoElement) => v.videoWidth),
  ).toBeGreaterThan(0);
  // Real playback and seeking over the authorized byte-range route.
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    await v.play();
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0);
  await video.evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 0.1;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0);
  for (const scope of ["motion-overview", "motion-keyframes"]) {
    const images = page.getByTestId(scope).locator("img");
    await expect(images.first()).toBeVisible();
    await expect
      .poll(() =>
        images
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(320);
  }
  await expect(page.getByTestId("motion-keyframes").getByRole("listitem")).toHaveCount(3);
  await expect(page.getByTestId("motion-reference")).toContainText(
    "永不作为生成输入",
  );
  await page.setExtraHTTPHeaders({ "x-test-role": "reader" });
  await page.reload();
  await openMotion(page);
  await expect(
    page.getByRole("button", { name: "批准为参考", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存候选修订", exact: true }),
  ).toBeDisabled();
  // Non-members see nothing of the project, including the motion media route.
  await page.setExtraHTTPHeaders({ "x-test-role": "outsider" });
  const response = await page.request.get(
    "/v1/projects/reference-test/assets/mo-video/content",
    { headers: { "x-test-role": "outsider" } },
  );
  expect(response.status()).toBe(403);
});

test("M-UI: explicit keyframe degrade is previewed exactly and a failed evidence write keeps the report draft", async ({
  page,
  request,
}) => {
  await openMotion(page);
  await page.getByRole("button", { name: "新建输入计划", exact: true }).click();
  const plan = page.getByLabel("生成输入计划", { exact: true });
  const value = JSON.parse(await plan.inputValue());
  value.inputs = [value.inputs[0]];
  value.capabilities = {
    verifiedAt: new Date().toISOString(),
    evidence: "Verified target accepts image references",
    maxImages: 4,
    roles: [value.inputs[0].role],
    supportsGridSequence: false,
    motion: { keyframes: { usages: ["camera_motion", "blocking", "action_timing"] } },
  };
  value.prompt = "石栏施法";
  await plan.fill(JSON.stringify(value));
  await page.getByLabel("白模动态参考", { exact: true }).selectOption("spell-motion@3");
  await page.getByLabel("白模交付方式").selectOption("keyframes");
  for (const id of ["kf-start", "kf-mid", "kf-end"])
    await page.getByLabel(`选择关键帧 ${id}`).check();
  await page.getByRole("button", { name: "写入输入计划", exact: true }).click();
  await page.getByRole("button", { name: "准备并检查输入包", exact: true }).click();
  const motion = page.getByTestId("generation-motion");
  await expect(motion).toContainText("整段视频不会发送");
  await expect(motion.locator("video")).toHaveCount(0);
  await expect
    .poll(() =>
      motion
        .locator("img")
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(320);
  await page.getByLabel("证据等级").selectOption("agent_reported");
  await page.getByLabel("实际执行证据").fill("外部运行记录：关键帧与身份图。");
  await page.getByLabel("输出素材 ID（逗号分隔）").fill("panel-one");
  await request.post("/__test/fail-next?stage=authoringEvidence");
  await page.getByRole("button", { name: "保存执行证据", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已保留");
  await expect(page.getByLabel("实际执行证据")).toHaveValue("外部运行记录：关键帧与身份图。");
  await page.getByRole("button", { name: "保存执行证据", exact: true }).click();
  await expect(page.getByTestId("evidence-motion")).toContainText(
    "计划 3 个关键帧 · 回报 3 个关键帧",
  );
});

for (const width of [360, 850, 1440]) {
  test(`M-UI layout at ${width}px: the motion viewer fits without page overflow and keeps the video reachable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openMotion(page);
    await expect(page.getByTestId("motion-video").locator("video")).toBeVisible();
    await page.getByTestId("motion-reference").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const box = (await page.getByTestId("motion-video").boundingBox())!;
    expect(box.width).toBeGreaterThan(Math.min(width, 800) * 0.35);
    await page.screenshot({ path: `test-results/motion-reference-${width}.png` });
  });
}
