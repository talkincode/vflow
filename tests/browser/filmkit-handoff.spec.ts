import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => { await request.post("/__test/reset"); });
test("fixed revision handoff is available to readers; missing selections and writer drafts are not called ready", async ({ page }) => {
  await page.goto("/projects/demo/compositions/episode-001");
  await page.getByRole("tab", { name: "协议", exact: true }).click();
  await expect(page.getByLabel("filmkit 拉取命令")).toHaveValue(/--revision 1 --mode production/);
  await page.getByLabel("filmkit 交接方式").selectOption("assemble");
  await expect(page.getByLabel("filmkit 拉取命令")).toHaveCount(0);
  await page.getByRole("region", { name: "filmkit 交接", exact: true }).getByRole("button", { name: "shot-001", exact: true }).click();
  await expect(page.getByRole("tab", { name: "分镜", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("画面提示词", { exact: true }).fill("交接前需要保存");
  await page.getByRole("tab", { name: "协议", exact: true }).click();
  await page.getByLabel("filmkit 交接方式").selectOption("production");
  await expect(page.getByLabel("filmkit 拉取命令")).toHaveCount(0);
  await page.getByRole("tab", { name: "分镜", exact: true }).click();
  await page.getByTestId("inspector-save-btn").click();
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #2");
  await page.getByRole("tab", { name: "协议", exact: true }).click();
  await expect(page.getByLabel("filmkit 拉取命令")).toHaveValue(/--revision 2 --mode production/);
  await page.setExtraHTTPHeaders({ "x-test-role": "reader" });
  await page.reload();
  await page.getByRole("tab", { name: "协议", exact: true }).click();
  await expect(page.getByLabel("filmkit 拉取命令")).toHaveValue(/--revision 2/);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});
