import { test, expect } from "@playwright/test";

const demoUrl = "/projects/demo/compositions/episode-001";

test("subject reference thumbnails open a readable full-size original", async ({ page }) => {
  await page.goto(demoUrl);
  await page.getByRole("tab", { name: "角色与道具", exact: true }).click();
  const card = page.getByTestId("library-subject-character-main");
  const thumbnail = card.locator("img");
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);
  const popupPromise = page.waitForEvent("popup");
  await card.getByRole("link", { name: "查看原图 preview-png", exact: true }).click();
  const original = await popupPromise;
  await expect(original).toHaveURL(/\/assets\/preview-png\/content$/);
  await expect.poll(() => original.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);
  await original.close();
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #1");
});

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("100-shot workspace: genuine previews, roomy prompts, draft retention, atomic failure/retry, explicit selection, and batch operations", async ({
  page,
  request,
}) => {
  await page.goto(demoUrl);
  await expect(page.getByTestId("composition-title")).toHaveText(
    "雨巷 · 第一集",
  );
  const hero = page.locator(".hero-preview img");
  await expect(hero).toBeVisible();
  await expect
    .poll(() => hero.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(320);
  await expect(page.locator(".brand img")).toBeVisible();
  const prompt = page.getByLabel("画面提示词", { exact: true });
  await expect(prompt).toBeVisible();
  const box = await prompt.boundingBox();
  expect(box!.width).toBeGreaterThan(400);
  expect(box!.height).toBeGreaterThan(180);
  await prompt.fill("保留草稿\n多行编辑\n保持人物版本");
  await page.getByRole("tab", { name: "素材", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(3);
  const video = page.locator(".asset-card video");
  const audio = page.locator(".asset-card audio");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
    element.currentTime = 1;
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThanOrEqual(1);
  await audio.evaluate(async (element: HTMLAudioElement) => {
    await element.play();
  });
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await page.getByRole("tab", { name: "分镜", exact: true }).click();
  await expect(
    page.locator(".asset-card video, .asset-card audio"),
  ).toHaveCount(0);
  await expect(prompt).toHaveValue(/保留草稿/);
  await page.getByLabel("搜索镜头", { exact: true }).fill("shot-100");
  await page.getByTestId("navigate-shot-100").click();
  await expect(prompt).toHaveValue("画面提示词 100");
  await expect(
    page.getByTestId("inspector-resolved-subjects"),
  ).not.toContainText("信使");
  await page.getByLabel("搜索镜头", { exact: true }).fill("");
  await page.getByTestId("navigate-shot-001").click();
  await expect(prompt).toHaveValue(/保留草稿/);
  await request.post("/__test/fail-next");
  await page.getByTestId("inspector-save-btn").click();
  await expect(page.getByRole("alert")).toContainText("Simulated");
  await expect(prompt).toHaveValue(/保留草稿/);
  await page.getByTestId("inspector-save-btn").click();
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #2");
  await prompt.fill("");
  await page.getByTestId("inspector-save-btn").click();
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #3");
  const saved = await request.get("/v1/projects/demo/compositions/episode-001");
  expect(
    (await saved.json()).revisionRecord.document.shots["shot-001"].prompts
      .image,
  ).toBe("");
  await page.getByLabel("批量选择 shot-001", { exact: true }).check();
  await page.getByLabel("批量选择 shot-002", { exact: true }).check();
  await page.getByLabel("批量时长秒数").fill("4");
  await page.getByRole("button", { name: "应用时长" }).click();
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #4");
  const updated = await request.get(
    "/v1/projects/demo/compositions/episode-001",
  );
  const document = (await updated.json()).revisionRecord.document;
  expect(document.shots["shot-001"].durationFrames).toBe(120);
  expect(document.shots["shot-002"].durationFrames).toBe(120);
});

test("preview failure offers retry and keyboard tabs preserve the current draft", async ({
  page,
}) => {
  let unavailable = true;
  await page.route("**/assets/preview-png/content*", (route) =>
    unavailable ? route.abort() : route.continue(),
  );
  await page.goto(demoUrl);
  await expect(page.locator(".hero-preview")).toContainText("素材加载失败");
  unavailable = false;
  await page
    .locator(".hero-preview")
    .getByRole("button", { name: "重试预览" })
    .click();
  await expect
    .poll(() =>
      page
        .locator(".hero-preview img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(320);
  await page
    .getByLabel("画面提示词", { exact: true })
    .fill("键盘切页保留的草稿");
  await page.getByRole("tab", { name: "分镜", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "素材", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#workspace-panel-assets")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "分镜", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("画面提示词", { exact: true })).toHaveValue(
    "键盘切页保留的草稿",
  );
});

test("reader can preview and navigate, cannot save, upload or bypass project authorization", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-test-role": "reader" },
  });
  const page = await context.newPage();
  await page.goto(demoUrl);
  await expect(page.getByTestId("save-status")).toHaveText("只读访问");
  await expect(page.getByTestId("inspector-save-btn")).toBeDisabled();
  await expect(page.getByLabel("画面提示词", { exact: true })).toBeDisabled();
  await expect
    .poll(() =>
      page
        .locator(".hero-preview img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(320);
  await page.getByRole("tab", { name: "素材", exact: true }).click();
  await expect(page.getByLabel("上传素材", { exact: true })).toBeDisabled();
  const denied = await request.patch(
    "/v1/projects/demo/compositions/episode-001",
    {
      headers: { "x-test-role": "reader" },
      data: {
        baseRevision: 1,
        operationId: "bypass",
        operations: [
          {
            op: "update_shot_fields",
            shotId: "shot-001",
            description: "unauthorized",
          },
        ],
      },
    },
  );
  expect(denied.status()).toBe(403);
  const forbidden = await request.get(
    "/v1/projects/demo/assets/preview-png/content",
    { headers: { "x-test-role": "outsider" } },
  );
  expect(forbidden.status()).toBe(403);
  await context.close();
});

for (const width of [360, 850, 1280, 1440, 1920]) {
  test(`layout at ${width}px: no page overflow, selection stays editable, tabs and collapse preserve context`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
    await page.goto(demoUrl);
    await expect(page.getByTestId("shot-inspector")).toBeVisible();
    if (width >= 1280)
      await expect(page.getByTestId("inspector-save-btn")).toBeInViewport();
    if (width === 1440)
      await page.screenshot({ path: "test-results/workspace-default.png" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const before = (await page.locator(".main-workspace").boundingBox())!.width;
    await page.getByRole("button", { name: "收起导航", exact: true }).click();
    const after = (await page.locator(".main-workspace").boundingBox())!.width;
    if (width > 620) expect(after).toBeGreaterThan(before + 100);
    await page.getByRole("button", { name: "专注编辑", exact: true }).click();
    await expect(page.locator(".preview-column")).toBeHidden();
    await expect(page.getByLabel("画面提示词", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "协议", exact: true }).click();
    await page.getByLabel("协议格式").selectOption("json");
    await expect(page.locator(".source-code")).toContainText('"apiVersion"');
    await page.getByRole("tab", { name: "分镜", exact: true }).click();
    await expect(page.getByTestId("inspector-desc-input")).toHaveValue(
      "镜头 1 雨巷",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/workspace-${width}.png` });
  });
}
