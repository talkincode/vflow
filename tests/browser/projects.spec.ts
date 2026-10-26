import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("project library, composition selection, direct URLs and browser history work across two projects", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "你的创作项目" }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(3);
  await page.getByLabel("搜索项目").fill("城市");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.getByRole("link", { name: "打开项目 城市观察" }).click();
  await expect(page).toHaveURL(/\/projects\/city$/);
  await expect(page.getByTestId("project-title")).toHaveText("城市观察");
  await expect(page.locator(".composition-card")).toHaveCount(2);
  await page.getByRole("link", { name: "打开编排 城市 · 第一集" }).click();
  await expect(page).toHaveURL(/\/projects\/city\/compositions\/episode-001$/);
  await expect(page.getByTestId("composition-title")).toHaveText(
    "城市 · 第一集",
  );
  await expect(page.getByTestId("inspector-desc-input")).toHaveValue(
    "城市天际线",
  );
  await page.getByLabel("切换编排").selectOption("episode-002");
  await expect(page).toHaveURL(/episode-002$/);
  await expect(page.getByTestId("composition-title")).toHaveText(
    "城市 · 第二集",
  );
  await page.reload();
  await expect(page.getByTestId("composition-title")).toHaveText(
    "城市 · 第二集",
  );
  await page.goBack();
  await expect(page.getByTestId("composition-title")).toHaveText(
    "城市 · 第一集",
  );
  await page.getByRole("link", { name: "全部项目", exact: true }).click();
  await page.getByRole("link", { name: "打开项目 工作台验收" }).click();
  await page.getByRole("link", { name: "打开编排 雨巷 · 第一集" }).click();
  await expect(page.getByTestId("composition-title")).toHaveText(
    "雨巷 · 第一集",
  );
  await expect(page.getByLabel("画面提示词", { exact: true })).toHaveValue(
    "画面提示词 1",
  );
});

test("project creation retains the form on failure and composition creation opens the configured new workbench", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await expect(page.getByLabel("项目名称", { exact: true })).toBeFocused();
  await page.getByLabel("项目名称", { exact: true }).fill("山间来信");
  await page.getByLabel("项目简介", { exact: true }).fill("山村纪录片");
  await page.getByText("链接标识", { exact: true }).click();
  await page.getByLabel("项目标识", { exact: true }).fill("mountain");
  await request.post("/__test/fail-next?stage=createProject");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法完成操作");
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(
    "山间来信",
  );
  const before = await request.get("/v1/projects");
  expect(
    (await before.json()).projects.some(
      (project: { id: string }) => project.id === "mountain",
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/mountain$/);
  await expect(page.getByTestId("project-title")).toHaveText("山间来信");
  await expect(page.getByRole("heading", { name: "还没有编排" })).toBeVisible();
  await page.getByRole("button", { name: "＋ 新建编排" }).click();
  await page.getByLabel("编排名称", { exact: true }).fill("山村第一集");
  await page.getByLabel("画面规格", { exact: true }).selectOption("portrait");
  await page.getByLabel("编排帧率", { exact: true }).selectOption("24");
  await page.getByText("链接标识", { exact: true }).click();
  await page.getByLabel("编排标识", { exact: true }).fill("episode-001");
  await page.getByRole("button", { name: "创建编排", exact: true }).click();
  await expect(page).toHaveURL(
    /\/projects\/mountain\/compositions\/episode-001$/,
  );
  await expect(page.getByTestId("composition-title")).toHaveText("山村第一集");
  await expect(page.getByTestId("composition-revision")).toHaveText("修订 #1");
  const created = await request.get(
    "/v1/projects/mountain/compositions/episode-001",
  );
  expect((await created.json()).revisionRecord.document.format).toEqual({
    width: 1080,
    height: 1920,
    fps: 24,
  });
  await page.goBack();
  await expect(page.getByTestId("project-title")).toHaveText("山间来信");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "打开编排 山村第一集" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "全部项目", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "打开项目 山间来信" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test("lost creation response is safely retried without duplicate compositions", async ({
  page,
  request,
}) => {
  await page.goto("/projects/city");
  await page.getByRole("button", { name: "＋ 新建编排" }).click();
  await page.getByLabel("编排名称", { exact: true }).fill("第三集");
  let first = true;
  const payloads: unknown[] = [];
  await page.route("**/v1/projects/city/compositions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    payloads.push(route.request().postDataJSON());
    if (first) {
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Lost response" },
        }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "创建编排", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("编排名称", { exact: true })).toHaveValue(
    "第三集",
  );
  await page.getByRole("button", { name: "创建编排", exact: true }).click();
  await expect(page.getByTestId("composition-title")).toHaveText("第三集");
  expect(payloads).toHaveLength(2);
  expect(payloads[0]).toEqual(payloads[1]);
  const list = await request.get("/v1/projects/city/compositions");
  expect((await list.json()).compositions).toHaveLength(3);
});

test("leaving an edited workbench warns, cancel preserves the draft, and another project has no residual data", async ({
  page,
}) => {
  await page.goto("/projects/demo/compositions/episode-001");
  await page.getByLabel("画面提示词", { exact: true }).fill("只属于雨巷的草稿");
  let warned = false;
  page.once("dialog", async (dialog) => {
    warned = dialog.type() === "beforeunload";
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "全部项目", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/demo\/compositions\/episode-001$/);
  expect(warned).toBe(true);
  await expect(page.getByLabel("画面提示词", { exact: true })).toHaveValue(
    "只属于雨巷的草稿",
  );
  await page.getByRole("button", { name: "放弃草稿", exact: true }).click();
  await expect(page.getByTestId("save-status")).toHaveText("当前镜头已保存");
  await page.getByRole("link", { name: "全部项目", exact: true }).click();
  await page.getByRole("link", { name: "打开项目 城市观察" }).click();
  await page.getByRole("link", { name: "打开编排 城市 · 第一集" }).click();
  await expect(page.getByLabel("画面提示词", { exact: true })).toHaveValue("");
  await expect(
    page.getByTestId("inspector-resolved-subjects"),
  ).not.toContainText("信使");
  await page.getByRole("tab", { name: "素材", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(0);
  await expect(page.locator("#workspace-panel-assets")).toContainText(
    "上传参考素材",
  );
});

test("reader only sees authorized projects and cannot create in a read-only project or initialize a missing link", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-test-role": "reader" },
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator(".project-card")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "打开项目 私人草稿" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "打开项目 城市观察" }).click();
  await expect(page.getByTestId("project-role")).toHaveText("只读项目");
  await expect(
    page.getByRole("button", { name: "＋ 新建编排" }),
  ).toBeDisabled();
  await page.goto("/projects/private");
  await expect(page.getByRole("alert")).toContainText("没有这个项目的访问权限");
  await page.getByRole("link", { name: "返回项目列表" }).click();
  await expect(page.locator(".project-card")).toHaveCount(2);
  await page.goto("/projects/city/compositions/not-created");
  await expect(page.getByRole("alert")).toContainText("未找到此编排");
  await expect(page.getByTestId("btn-bootstrap-project")).toHaveCount(0);
  const state = await request.get("/v1/projects/city/compositions");
  expect((await state.json()).compositions).toHaveLength(2);
  await context.close();
});

test("project and creation layouts fit desktop and mobile, with keyboard dialog controls", async ({
  page,
}) => {
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".project-card")).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 1440)
      await page.screenshot({ path: "test-results/project-library.png" });
    await page.getByRole("button", { name: "＋ 新建项目" }).click();
    await expect(page.getByLabel("项目名称", { exact: true })).toBeFocused();
    await expect(page.getByRole("dialog")).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "＋ 新建项目" }),
    ).toBeFocused();
    await page.getByRole("link", { name: "打开项目 城市观察" }).click();
    await expect(page.getByTestId("project-title")).toHaveText("城市观察");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 1440)
      await page.screenshot({ path: "test-results/project-overview.png" });
  }
});
