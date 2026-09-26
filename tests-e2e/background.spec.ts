import { test, expect } from "@playwright/test";
test.use({ storageState: ".auth/user.json" });

// Reported from real use: opening Settings or another report while an analysis ran killed it, with no
// way to rerun it except uploading the plan again. A run now belongs to the server.
test("an analysis keeps running when you leave the page, and a stopped one can run again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const start = async (note: string) => {
    await page.goto("/app");
    await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
    await expect(page.locator("#statement")).toBeVisible();
    await page.fill("#note", note);
    await page.getByRole("button", { name: "Analyse plan" }).click();
    // It appears in history as soon as it starts.
    const item = page.locator(".history-link", { hasText: note });
    await expect(item).toBeVisible();
    return item;
  };

  // Leave mid-run for Settings, come back through history: the run is still going, then finishes.
  const first = await start("qa slow background run");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.goto("/app");
  await first.click();
  await expect(page.locator("[data-verdict]")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Stopped before it finished")).toHaveCount(0);

  // Stop a run on purpose, then Run again from the same plan: no upload.
  const second = await start("qa slow stop and rerun");
  await second.click();
  await expect(page.getByText("keeps running on the server")).toBeVisible();
  await page.getByRole("button", { name: "Stop analysis" }).click();
  await expect(page.getByText("Stopped before it finished")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(page.locator("[data-verdict]")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Run again" })).toHaveCount(0);
});

// Reported from use: the same plan gave a different action plan on every run. An identical request (same
// evidence, note and models) now opens the earlier report; "Run again anyway" asks the models again.
test("analysing the same plan again opens the earlier report, and Run again anyway asks again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const analyse = async () => {
    await page.goto("/app");
    await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
    await expect(page.locator("#statement")).toBeVisible();
    await page.fill("#note", "qa same plan twice");
    await page.getByRole("button", { name: "Analyse plan" }).click();
    await expect(page.locator("[data-verdict]")).toBeVisible({
      timeout: 60_000,
    });
    return page.url().replace(/\?.*$/, "");
  };
  const first = await analyse();
  await expect(page.locator(".reused-note")).toHaveCount(0);
  const second = await analyse();
  expect(second).toBe(first);
  await expect(page.locator(".reused-note")).toContainText(
    "Same plan, same answer",
  );
  await page.getByRole("button", { name: "Run again anyway" }).click();
  await expect(page.locator(".reused-note")).toHaveCount(0);
  await expect(page.locator("[data-verdict]")).toBeVisible({ timeout: 60_000 });
});
