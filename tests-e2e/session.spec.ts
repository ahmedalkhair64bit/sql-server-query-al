import { test, expect } from "@playwright/test";

// WebKit-only on purpose. Chromium accepts a `Secure` cookie on http://localhost; Safari does not, and it
// silently drops it, so a production build on plain http looked like "the wizard signed me out".
// This file must stay self-contained: it signs up its own account and never uses .auth/user.json.

test("signup, wizard links, and /app stay logged in over plain http", async ({
  page,
}) => {
  const email = `safari${Date.now()}@qai.test`;
  await page.goto("/signup");
  await page.fill("#email", email);
  await page.fill("#password", "0123456789ab");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/setup/, { timeout: 20_000 });
  await expect(page.getByText("Step 1 of 3")).toBeVisible();

  await page.getByRole("link", { name: "Connect models" }).click();
  await expect(page).toHaveURL(/step=2/);
  await expect(
    page.getByRole("heading", { name: "Connect your models", exact: true }),
  ).toBeVisible();

  // Step 3 without keys says what is missing instead of "Ready".
  await page.goto("/setup?step=3");
  await expect(
    page.getByRole("heading", { name: "Almost there" }),
  ).toBeVisible();

  // Session proof: this user has no keys yet, so the console gate sends them to the guide.
  // Signed-in lands on /setup?step=2; a lost session would land on /login.
  await page.goto("/app");
  await expect(page).toHaveURL(/\/setup\?step=2/);
});

test("a reload deep in the app keeps the session", async ({ page }) => {
  const email = `reload${Date.now()}@qai.test`;
  await page.goto("/signup");
  await page.fill("#email", email);
  await page.fill("#password", "0123456789ab");
  await page.getByRole("button", { name: "Create account" }).click();
  // Wait for the signup POST to finish: the cookie is not in effect until its response lands, and an
  // immediate goto races it (which reads as "the session did not survive a reload").
  await expect(page).toHaveURL(/\/setup/, { timeout: 20_000 });
  await page.goto("/settings");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // The form is still here after the reload: this is the account's own settings page, not the login form.
  await expect(
    page.getByRole("button", { name: "Save model settings" }),
  ).toBeVisible();
});
