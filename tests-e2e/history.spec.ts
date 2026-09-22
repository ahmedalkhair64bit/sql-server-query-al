import { test, expect } from "@playwright/test";
test.use({ storageState: ".auth/user.json" });
test("history search, rename, delete cancellation, reopen and navigation", async ({
  page,
}) => {
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
  await expect(page.locator("#statement")).toBeVisible();
  await page.fill("#note", "QA history lifecycle");
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page).toHaveURL(/\/app\/.+/);
  await page.goto("/app");
  await page
    .getByRole("textbox", { name: "Search history" })
    .fill("QA history lifecycle");
  let row = page.locator(".history-item").first();
  await expect(row).toBeVisible();
  await row.locator("summary").click();
  await row.locator("input[name=title]").fill("Renamed by QA");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search history" })
    .fill("Renamed by QA");
  await expect(row).toBeVisible();
  await row.locator(".history-link").click();
  await expect(page.locator("[data-verdict]")).toBeVisible();
  await page.reload();
  row = page.locator(".history-item").filter({
    has: page.getByRole("link", { name: "Renamed by QA", exact: true }),
  });
  await expect(page.locator("[data-verdict]")).toBeVisible();
  await row.locator("summary").click();
  page.once("dialog", (d) => d.dismiss());
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("[data-verdict]")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator("[data-verdict]")).toHaveCount(0);
});
