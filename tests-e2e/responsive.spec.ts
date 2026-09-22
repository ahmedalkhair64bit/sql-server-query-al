import { test, expect } from "@playwright/test";
test.use({ storageState: ".auth/user.json" });

for (const width of [320, 375, 414, 768]) {
  test(`no horizontal scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/app");
    const over = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    const box = await page
      .getByRole("button", { name: "Analyse plan" })
      .boundingBox();
    // .btn is 10px padding + 15px line = 35px at these widths; 32 leaves room for subpixel rounding
    // while still failing a squashed or two-line control.
    expect(box!.height).toBeGreaterThanOrEqual(32);
  });
}

test("every settings field has a visible label", async ({ page }) => {
  await page.goto("/settings");
  // Scoped to the form: the rail's rename boxes are labelled for assistive tech with aria-label, not visibly.
  const orphans = await page.evaluate(() =>
    [...document.querySelectorAll(".settings-page form input")]
      .filter((el) => {
        const i = el as HTMLInputElement;
        return (
          i.type !== "hidden" &&
          (!i.id || !document.querySelector(`label[for="${i.id}"]`))
        );
      })
      .map(
        (el) => (el as HTMLInputElement).name || (el as HTMLInputElement).type,
      ),
  );
  expect(orphans).toEqual([]);
});
