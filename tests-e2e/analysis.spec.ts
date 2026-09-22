import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.use({
  storageState: ".auth/user.json",
  permissions: ["clipboard-read", "clipboard-write"],
});
test("full run uses real upload, analyst and Jev contracts, then structured SQL and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
  await expect(page.locator("#statement")).toBeVisible();
  await page.fill("#note", "QA complete analysis");
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page).toHaveURL(/\/app\/.+/, { timeout: 180000 });
  await expect(page.locator("[data-verdict]")).toBeVisible();
  if (process.env.QAI_LIVE === "1")
    await expect(page.locator("[data-verdict]")).not.toContainText(
      "Decision engine unavailable",
    );
  expect(await page.locator(".option-card").count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".sql").first()).toBeVisible();
  await page.getByRole("button", { name: "Copy SQL" }).first().click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }).first(),
  ).toBeVisible();
  if (await page.evaluate(() => !!navigator.clipboard)) {
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).length,
    ).toBeGreaterThan(10);
  }
  await page.getByRole("button", { name: "Retry Jev" }).click();
  await expect(page.getByRole("button", { name: "Retry Jev" })).toBeEnabled({
    timeout: 60000,
  });
  const clipped = await page
    .locator(".decision-card,.option-card,.grid-metrics")
    .evaluateAll((elements) =>
      elements
        .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
        .map((el) => el.className),
    );
  expect(clipped).toEqual([]);
  await page.screenshot({
    path: "test-results/analysis-result.png",
    fullPage: true,
  });
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".rail")).toBeHidden();
  expect(errors).toEqual([]);
});
test("UTF-16 uploaded file is indexed on the server without a giant textarea", async ({
  page,
}) => {
  await page.goto("/app");
  const xml = readFileSync("fixtures/sample.sqlplan", "utf8").replace(
    /^\uFEFF/,
    "",
  );
  await page.setInputFiles("input[type=file]", {
    name: "utf16.sqlplan",
    mimeType: "application/xml",
    buffer: Buffer.from("\uFEFF" + xml, "utf16le"),
  });
  await expect(page.locator("#statement")).toBeVisible();
  await expect(page.locator("#xml")).toHaveCount(0);
});
test("paste mode and malformed XML have useful feedback", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Paste XML", exact: true }).click();
  await page.fill("#xml", "<ShowPlanXML><Unclosed></ShowPlanXML>");
  await page.getByRole("button", { name: "Read statements" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "stopped parsing",
  );
  await page.fill("#xml", readFileSync("fixtures/sample.sqlplan", "utf8"));
  await page.getByRole("button", { name: "Read statements" }).click();
  await expect(page.locator("#statement")).toBeVisible();
});
test("plain SQL is rejected as non-ShowPlan input", async ({ page }) => {
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", {
    name: "wrong.xml",
    mimeType: "application/xml",
    buffer: Buffer.from("SELECT * FROM dbo.Orders;"),
  });
  await expect(page.locator(".notice[role=alert]")).toBeVisible();
  await expect(page.locator("#statement")).toHaveCount(0);
});
test("stop cancels an in-flight analysis and allows a fresh run", async ({
  page,
}) => {
  test.skip(process.env.QAI_LIVE === "1", "Controlled latency scenario");
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
  await expect(page.locator("#statement")).toBeVisible();
  await page.fill("#note", "qa slow cancellation");
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page.getByRole("status")).toContainText("Your analyst");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Analyse plan" }),
  ).toBeEnabled();
  await expect(page.locator(".notice[role=alert]")).toContainText("Stopped");
});
