import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("account onboarding, settings persistence, sign-out and re-login", async ({
  page,
}) => {
  test.skip(process.env.QAI_LIVE === "1", "Uses controlled provider settings");
  const email = `account+${Date.now()}@qai.test`;
  const password = "account lifecycle password";
  await page.goto("/signup");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await page.getByRole("link", { name: "Connect models" }).click();
  await page.fill("#analyst_base_url", "http://127.0.0.1:18889/v1");
  await page.fill("#analyst_key", "qa-controlled-key");
  await page.fill("#analyst_model", "qa-original");
  await page.fill("#jev_key", "qa-controlled-key");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Step 3 of 3")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You are ready" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Upload my own plan" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/settings");
  await expect(page.locator("#analyst_key")).toHaveValue("");
  await expect(page.locator("#jev_key")).toHaveValue("");
  await expect(page.locator("#email")).toHaveValue(email);
  await page.fill("#analyst_model", "qa-updated");
  await page.locator("details.advanced summary").click();
  await page.fill("#analyst_extra", '{"temperature":0.2}');
  await page.getByRole("button", { name: "Save model settings" }).click();
  await expect(page.getByText("Model settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.locator("#analyst_model")).toHaveValue("qa-updated");
  await expect(page.locator("#analyst_extra")).toHaveValue(
    '{"temperature":0.2}',
  );
  await expect(page.getByText(/Leave empty to keep it/)).toHaveCount(2);
  await page
    .locator(".rail-footer")
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  for (const path of ["/app", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
  const response = await page.request.post("/api/plans", {
    data: "<ShowPlanXML/>",
    headers: { "Content-Type": "application/xml" },
  });
  expect(response.status()).toBe(401);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/settings");
  await expect(page.locator("#analyst_model")).toHaveValue("qa-updated");
  await expect(page.getByText(/Leave empty to keep it/)).toHaveCount(2);
});
