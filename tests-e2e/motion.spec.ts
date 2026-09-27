import { test, expect } from "@playwright/test";

// A failed sign-in shakes the form, marks the fields, keeps the email and clears the marks once the
// person starts correcting them.
test("a wrong password marks the fields, keeps the email and clears on edit", async ({
  page,
}) => {
  await page.goto("/login");
  await page.fill("#email", "nobody@qai.test");
  await page.fill("#password", "not the password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.locator("#auth-error")).toBeVisible();
  await expect(page.locator("form.auth-form")).toHaveClass(/t-shake/);
  // The class alone is not enough: another animation rule could cancel it.
  await expect(page.locator("form.auth-form")).toHaveCSS(
    "animation-name",
    "t-shake",
  );
  await expect(page.locator("#password")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#email")).toHaveValue("nobody@qai.test");
  await expect(page.locator("#password")).toHaveValue("");
  await page.fill("#password", "x");
  await expect(page.locator("#password")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#auth-error")).toHaveCount(0);
});
