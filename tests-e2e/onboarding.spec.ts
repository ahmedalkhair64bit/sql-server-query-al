import { test, expect, type Page } from "@playwright/test";

// Fresh accounts: this file covers the first-run guide, connection tests, and the account and data settings.
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(process.env.QAI_LIVE === "1", "Uses the controlled providers");

const PROVIDER = "http://127.0.0.1:18889/v1";
async function signUp(page: Page, tag: string) {
  const email = `${tag}+${Date.now()}@qai.test`;
  await page.goto("/signup");
  await page.fill("#email", email);
  await page.fill("#password", "onboarding password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  return email;
}
async function fillModels(page: Page, over: Record<string, string> = {}) {
  await page.selectOption("#analyst_provider", "custom");
  await page.fill("#analyst_base_url", over.base ?? PROVIDER);
  await page.fill("#analyst_key", over.key ?? "qa-controlled-key");
  await page.fill("#analyst_model", over.model ?? "qa-controlled-model");
  await page.fill("#jev_key", over.jev ?? "qa-controlled-key");
}

test("the guide cannot finish without models, tests connections, and ends on the sample plan", async ({
  page,
}) => {
  await signUp(page, "guide");
  await expect(
    page.getByRole("heading", { name: "Welcome to SQL Server Query AI" }),
  ).toBeVisible();
  await expect(page.locator(".flow li")).toHaveCount(4);
  await page.getByRole("link", { name: "Connect models" }).click();

  // An empty save stays on step 2 and says what is missing.
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.locator(".form-actions [role=alert]")).toContainText(
    "Still needed",
  );
  await expect(page).toHaveURL(/step=2/);
  await expect(page.getByRole("link", { name: "Next" })).toHaveCount(0);

  // Presets fill the URL.
  await page.selectOption("#analyst_provider", "gemini");
  await expect(page.locator("#analyst_base_url")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );

  // Connection tests explain failures, then pass, and list the key's models.
  await fillModels(page, { key: "qa-bad-key" });
  await page.getByRole("button", { name: "Test analyst connection" }).click();
  await expect(
    page.locator(".status-line[data-state=failed]").first(),
  ).toContainText("API key was rejected (HTTP 401)");
  await page.fill("#analyst_key", "qa-controlled-key");
  await page.fill("#analyst_model", "qa-missing-model");
  await page.getByRole("button", { name: "Test analyst connection" }).click();
  await expect(
    page.locator(".status-line[data-state=failed]").first(),
  ).toContainText("HTTP 404");
  await page.fill("#analyst_model", "qa-controlled-model");
  await page.getByRole("button", { name: "Test analyst connection" }).click();
  await expect(
    page.locator(".status-line[data-state=ok]").first(),
  ).toContainText("Connected");
  await expect(page.getByText(/2 models found for this key/)).toBeVisible();
  await page.getByRole("button", { name: "Test Jev connection" }).click();
  await expect(page.locator(".status-line[data-state=ok]")).toHaveCount(2);

  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "You are ready" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".checklist li[data-state=ok]")).toHaveCount(2);

  // The sample plan arrives uploaded and ready to analyse.
  await page.getByRole("link", { name: "Analyse the sample plan" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator("#statement")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#note")).toHaveValue(/Sample plan/);
  await expect(page.locator(".model-badge")).toContainText("Models connected");
});

test("a failing model is reported on the last step instead of 'ready'", async ({
  page,
}) => {
  await signUp(page, "failing");
  await page.goto("/setup?step=2");
  await fillModels(page, { jev: "qa-bad-key" });
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "A connection needs attention" }),
  ).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.locator(".checklist li[data-state=failed]")).toContainText(
    "TypeSafe API key was rejected",
  );
  await expect(
    page.getByRole("link", { name: "Continue anyway" }),
  ).toBeVisible();
  await page.goto("/app");
  await expect(page.locator(".model-badge")).toContainText(
    "Model check failed",
  );
});

test("password change needs the current password and signs out other devices; data can be exported and cleared", async ({
  page,
  browser,
}) => {
  const email = await signUp(page, "account");
  await page.goto("/setup?step=2");
  await fillModels(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "You are ready" }),
  ).toBeVisible({ timeout: 45_000 });

  // A second device signed in to the same account.
  const other = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const second = await other.newPage();
  await second.goto("/login");
  await second.fill("#email", email);
  await second.fill("#password", "onboarding password");
  await second.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(second).toHaveURL(/\/app$/);

  await page.goto("/settings#account");
  await expect(page.locator("#email")).toHaveValue(email);
  await page.fill("#current_password", "not the password");
  await page.fill("#new_password", "a brand new password");
  await page.getByRole("button", { name: "Update account" }).click();
  await expect(page.locator("#account [role=alert]")).toContainText(
    "current password is wrong",
  );
  await page.fill("#current_password", "onboarding password");
  await page.fill("#new_password", "a brand new password");
  await page.getByRole("button", { name: "Update account" }).click();
  await expect(page.locator("#account [role=status]")).toContainText(
    "other devices were signed out",
  );

  await second.goto("/app");
  await expect(second).toHaveURL(/\/login/);
  await other.close();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  // Data: export, then delete everything behind a typed confirmation.
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", "fixtures/sample.sqlplan");
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page).toHaveURL(/\/app\/.+/, { timeout: 120_000 });
  await page.goto("/settings#data");
  const exported = await page.request.get("/api/export");
  expect(exported.headers()["content-disposition"]).toContain("attachment");
  const body = await exported.json();
  expect(body.analyses.length).toBe(1);
  expect(body.analyses[0].digest.statementId).toBeTruthy();
  await page.locator(".danger-zone summary").click();
  await page.fill("#confirm", "delete");
  await page.getByRole("button", { name: "Delete all analyses" }).click();
  await expect(page.locator("#data [role=alert]")).toContainText("Type DELETE");
  await page.fill("#confirm", "DELETE");
  await page.getByRole("button", { name: "Delete all analyses" }).click();
  await expect(page.locator("#data [role=status]")).toContainText(
    "Deleted 1 analysis",
  );
  expect(
    (await (await page.request.get("/api/export")).json()).analyses.length,
  ).toBe(0);
});

test("a save error clears once the form is edited", async ({ page }) => {
  await signUp(page, "stale");
  await page.goto("/setup?step=2");
  await page.getByRole("button", { name: "Save and continue" }).click();
  const alert = page.locator(".form-actions [role=alert]");
  await expect(alert).toContainText("Still needed");
  await page.fill("#analyst_model", "x");
  await expect(alert).toHaveCount(0);
});
