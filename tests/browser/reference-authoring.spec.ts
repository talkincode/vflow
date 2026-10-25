import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
  expect((await request.post("/__test/reference-fixture")).ok()).toBe(true);
});

test("A17: independent references decode, review failures retain draft, pinned inputs preview exactly and readers cannot approve", async ({
  page,
  request,
}) => {
  await page.goto("/projects/reference-test/compositions/main");
  await page.getByRole("tab", { name: "参考制作", exact: true }).click();
  await expect(page.getByText("先把参考说清楚，再进入镜头")).toBeVisible();
  await page
    .getByRole("button", {
      name: "suwei-face reference_pack · r3 · approved",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "front face-front · accepted", exact: true })
    .click();
  const image = page.locator(".reference-inspector img").first();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(320);
  await expect(page.getByLabel("当前参考图片")).toHaveValue("face-front");
  const popup = page.waitForEvent("popup");
  await page
    .getByRole("link", { name: "查看原图 face-front", exact: true })
    .click();
  const original = await popup;
  await expect
    .poll(() =>
      original
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(320);
  await original.close();
  for (const check of [
    "single_identity",
    "face_visible",
    "neutral_lighting",
    "identity_consistent",
  ])
    await page
      .getByLabel(`检查 ${check}`, { exact: true })
      .selectOption("pass");
  await page.getByLabel("视觉审阅结论").selectOption("accepted");
  await page
    .getByLabel("审阅证据", { exact: true })
    .fill("逐张看过原图：同一角色、面部清晰，背景与服装均无混入。");
  await request.post("/__test/fail-next?stage=authoringWrite");
  await page
    .getByRole("button", { name: "记录当前项审阅", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("草稿已保留");
  await expect(page.getByLabel("审阅证据", { exact: true })).toHaveValue(
    "逐张看过原图：同一角色、面部清晰，背景与服装均无混入。",
  );
  await page
    .getByRole("button", { name: "记录当前项审阅", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "suwei-face reference_pack · r4 · candidate",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "批准为参考", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "suwei-face reference_pack · r5 · approved",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "固定到此编排", exact: true }).click();
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #2");
  const input = {
    compositionId: "main",
    compositionRevision: 2,
    shotId: "spell",
    inputs: [
      {
        source: { pack: { id: "suwei-face", revision: 5 }, viewId: "front" },
        role: "face_identity",
        wholeBoard: false,
      },
    ],
    capabilities: {
      verifiedAt: new Date().toISOString(),
      evidence: "Verified current target supports identity inputs",
      maxImages: 1,
      roles: ["face_identity"],
      supportsGridSequence: false,
    },
    prompt: "石栏上施法特写",
    templateVersion: "reference-authoring/1",
  };
  await page
    .getByLabel("生成输入计划", { exact: true })
    .fill(JSON.stringify(input));
  await page
    .getByRole("button", { name: "准备并检查输入包", exact: true })
    .click();
  const packet = page.getByTestId("generation-packet");
  await expect(packet).toContainText("face_identity · face-front");
  await expect
    .poll(() =>
      packet
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(320);
  expect(
    JSON.parse(await page.getByLabel("实际输入记录").inputValue())[0].asset,
  ).toBe("face-front");
  await page.setExtraHTTPHeaders({ "x-test-role": "reader" });
  await page.reload();
  await page.getByRole("tab", { name: "参考制作", exact: true }).click();
  await page
    .getByRole("button", {
      name: "suwei-face reference_pack · r5 · approved",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "批准为参考", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存候选修订", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("参考名称")).toBeDisabled();
});

test("reference wizard builds a classified draft and preserves invalid JSON after a failed save", async ({
  page,
}) => {
  await page.goto("/projects/reference-test/compositions/main");
  await page.getByRole("tab", { name: "参考制作", exact: true }).click();
  await page.getByRole("button", { name: "新建输入计划", exact: true }).click();
  const plan = JSON.parse(
    await page.getByLabel("生成输入计划", { exact: true }).inputValue(),
  );
  expect(plan.capabilities.verifiedAt).toBe("");
  expect(plan.capabilities.evidence).toBe("");
  await page
    .getByRole("button", { name: "准备并检查输入包", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "TARGET_CAPABILITIES_REQUIRED",
  );
  await expect(page.getByTestId("generation-packet")).toHaveCount(0);
  await page.getByLabel("新建参考类型").selectOption("character_body");
  await page
    .getByLabel("参考归属", { exact: true })
    .selectOption("character:suwei@1/default");
  await page.getByRole("button", { name: "创建候选草稿", exact: true }).click();
  await page.getByRole("button", { name: "添加独立视图", exact: true }).click();
  await expect(page.getByLabel("参考视角")).toHaveValue("front");
  await page
    .getByText("完整结构与来源清单（图外 sidecar）", { exact: true })
    .click();
  const editor = page.getByLabel("参考结构 JSON");
  expect(JSON.parse(await editor.inputValue()).category).toBe("character_body");
  await editor.fill('{"broken":');
  await page.getByRole("button", { name: "保存候选修订", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已保留");
  await expect(editor).toHaveValue('{"broken":');
  await expect(
    page.getByText("参考资料或审阅有未保存草稿", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("link", { name: "Video Compose 首页", exact: true })
    .click();
  await expect(page).toHaveURL(/reference-test\/compositions\/main$/);
  await expect(editor).toHaveValue('{"broken":');
});
