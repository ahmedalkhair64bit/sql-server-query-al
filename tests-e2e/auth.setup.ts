import { test, expect } from "@playwright/test";

if (process.env.QAI_LIVE === "1" && (!process.env.JEV_API_KEY || !process.env.QAI_ANALYST_BASE_URL || !process.env.QAI_ANALYST_MODEL)) {
  throw new Error("Live tests require JEV_API_KEY, QAI_ANALYST_BASE_URL, and QAI_ANALYST_MODEL.");
}

const EMAIL = `qa+${Date.now()}@qai.test`;

test("signup + first-run guide configures both models", async ({ page }) => {
  await page.goto("/signup");
  await page.fill("#email", EMAIL);
  await page.fill("#password", "playwright password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await page.getByRole("link", { name: "Next" }).click();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();

  await page.fill(
    "#analyst_base_url",
    process.env.QAI_LIVE === "1"
      ? process.env.QAI_ANALYST_BASE_URL!
      : "http://127.0.0.1:18889/v1",
  );
  await page.fill("#analyst_key", process.env.QAI_ANALYST_KEY ?? "EMPTY");
  await page.fill(
    "#analyst_model",
    process.env.QAI_ANALYST_MODEL ?? "qa-controlled-model",
  );
  // Reasoning models stream thinking, not content: without this the report arrives empty.
  await page.fill(
    "#analyst_extra",
    process.env.QAI_ANALYST_EXTRA ??
      '{"chat_template_kwargs":{"enable_thinking":false}}',
  );
  await page.fill(
    "#jev_key",
    process.env.QAI_LIVE === "1"
      ? (process.env.JEV_API_KEY ?? "")
      : "qa-controlled-key",
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Step 3 of 3")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Analyst ready · Jev ready/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go" })).toBeVisible();
  await page.context().storageState({ path: ".auth/user.json" });
});

test("signed-out visitor is pushed to login", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/app");
  expect(page.url()).toContain("/login");
  await ctx.close();
});
