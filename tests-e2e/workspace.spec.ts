import { test, expect } from "@playwright/test";
test.use({ storageState: ".auth/user.json" });
test("navigation, theme, focus, and screenshots have no page errors", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "A clearer path to a faster query." }),
  ).toBeVisible();
  if (isMobile) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Open sidebar" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Open sidebar" }).click();
  }
  await page.getByRole("button", { name: "Dark appearance" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "A clearer path to a faster query." }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: testInfo.outputPath("workspace-dark.png"),
    fullPage: true,
  });
  if (isMobile)
    await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "Light appearance" }).click();
  if (isMobile) {
    await page.keyboard.press("Escape");
    await expect(page.locator(".rail")).toBeHidden();
  }
  await page.screenshot({
    path: testInfo.outputPath("workspace-light.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBe(0);
  const bounds = await page
    .locator(".workspace-main,.main,.analysis-workspace,.welcome,.composer")
    .evaluateAll((els) =>
      els.map((el) => ({
        class: el.className,
        width: el.getBoundingClientRect().width,
        right: el.getBoundingClientRect().right,
        display: getComputedStyle(el).display,
        viewport: innerWidth,
      })),
    );
  expect(bounds.filter((b) => b.right > b.viewport + 1)).toEqual([]);
  expect(await page.evaluate(() => innerWidth)).toBe(
    page.viewportSize()!.width,
  );
  expect(errors).toEqual([]);
});
test("multi-statement selection never mixes batch evidence", async ({
  page,
}) => {
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", {
    name: "batch.sqlplan",
    mimeType: "application/xml",
    buffer: Buffer.from(
      '<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1" StatementSubTreeCost="1"/><StmtSimple StatementText="SELECT 2" StatementSubTreeCost="9"/></Statements></Batch></BatchSequence></ShowPlanXML>',
    ),
  });
  await expect(page.locator("#statement")).toHaveValue("s2");
  await expect(page.locator("#statement option")).toHaveCount(2);
  await page.selectOption("#statement", "s1");
  await expect(page.locator("#statement")).toHaveValue("s1");
});
test("new analysis clears a selected upload", async ({ page, isMobile }) => {
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
  await expect(page.locator("#statement")).toBeVisible();
  if (isMobile)
    await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("link", { name: /New analysis/ }).click();
  if (isMobile) {
    await page.keyboard.press("Escape");
    await expect(page.locator(".rail")).toBeHidden();
  }
  await expect(page.locator("#statement")).toHaveCount(0);
});
