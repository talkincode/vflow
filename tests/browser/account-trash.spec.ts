import { test, expect } from "@playwright/test";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
test("trash confirmation recovers from failure, preserves child deletion across project restoration", async ({
  page,
  request,
}) => {
  await page.goto("/projects/city");
  await page.getByRole("button", { name: "删除编排 城市 · 第一集" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "删除编排 城市 · 第一集" }).click();
  await request.post("/__test/fail-next?stage=lifecycleChange");
  await page.getByRole("button", { name: "确认移入回收站" }).click();
  await expect(page.getByRole("alert")).toContainText("确认信息已保留");
  await page.getByRole("button", { name: "确认移入回收站" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".composition-card")).toHaveCount(1);
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.getByRole("button", { name: "确认移入回收站" }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(
    page
      .getByTestId("trash-composition-episode-001")
      .getByRole("button", { name: "恢复", exact: true }),
  ).toBeDisabled();
  await page
    .getByTestId("trash-project-city")
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await expect(page.getByTestId("trash-project-city")).toHaveCount(0);
  await expect(page.getByTestId("trash-composition-episode-001")).toBeVisible();
  await page
    .getByTestId("trash-composition-episode-001")
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "回收站是空的" }),
  ).toBeVisible();
  await page.goto("/projects/city");
  await expect(page.locator(".composition-card")).toHaveCount(2);
});
test("owner explicitly shares a private project, then revokes it; account navigation exposes logout", async ({
  page,
  browser,
}) => {
  await page.goto("/projects/private");
  await expect(page.getByRole("link", { name: "退出登录" })).toHaveAttribute(
    "href",
    "/logout",
  );
  const other = await browser.newContext({
    extraHTTPHeaders: { "x-test-role": "reader" },
  });
  const reader = await other.newPage();
  await reader.goto("/");
  await expect(
    reader.getByRole("link", { name: "打开项目 私人草稿" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "共享设置" }).click();
  await page.getByLabel("共享给账号").fill("bob-reader@talkincode.net");
  await page.getByRole("button", { name: "授权共享" }).click();
  await expect(
    page.getByRole("button", { name: "撤销 bob-reader@talkincode.net" }),
  ).toBeVisible();
  await reader.reload();
  await reader.getByRole("link", { name: "打开项目 私人草稿" }).click();
  await expect(reader.getByTestId("project-title")).toHaveText("私人草稿");
  await expect(reader.getByRole("button", { name: "共享设置" })).toHaveCount(0);
  await expect(
    reader.getByRole("button", { name: "删除项目", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "撤销 bob-reader@talkincode.net" })
    .click();
  await expect(
    page.getByRole("button", { name: "撤销 bob-reader@talkincode.net" }),
  ).toHaveCount(0);
  await reader.reload();
  await expect(reader.getByTestId("project-title")).toHaveCount(0);
  await expect(reader.getByRole("alert")).toContainText(
    "你没有这个项目的访问权限",
  );
  await other.close();
});

test("restored browser pages discard the previous account and expired session content", async ({
  page,
}) => {
  await page.goto("/projects/private");
  await expect(page.getByTestId("project-title")).toHaveText("私人草稿");
  await page.setExtraHTTPHeaders({ "x-test-role": "reader" });
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(page.getByTestId("project-title")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "你没有这个项目的访问权限",
  );
  await page.route("**/v1/session", (route) =>
    route.fulfill({
      status: 401,
      contentType: "text/html",
      body: "Access session expired",
    }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(page.getByRole("heading", { name: "登录已失效" })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);
});
