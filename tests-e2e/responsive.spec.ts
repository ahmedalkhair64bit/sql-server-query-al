import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
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

test("a long statement title fits a phone instead of widening the report", async ({
  page,
}) => {
  // Reported from a real phone: the report title comes from the statement, and a generated table name
  // longer than the screen could not wrap. It widened the report (582px on a 390px screen) and clipped the
  // error and metrics. The names here are invented; never put a user's schema into the repository.
  await page.setViewportSize({ width: 375, height: 800 });
  const long = `insert bulk APP_x1_GeneratedEntityWithAVeryLongNameHistoryArchive ([ENTITY_IDENTIFIER_COLUMN] BigInt, [CREATED_ON] DateTime)`;
  const plan = readFileSync("fixtures/sample.sqlplan", "utf8").replace(
    /StatementText="[^"]*"/,
    `StatementText="${long}"`,
  );
  await page.goto("/app");
  await page.setInputFiles("input[type=file]", {
    name: "long-title.sqlplan",
    mimeType: "application/xml",
    buffer: Buffer.from(plan),
  });
  await expect(page.locator("#statement")).toBeVisible();
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page).toHaveURL(/\/app\/.+/, { timeout: 120_000 });
  await page.reload();
  await expect(page.locator("h1").first()).toContainText("APP_x1_");
  const widths = await page.evaluate(() => ({
    screen: window.innerWidth,
    main: document.querySelector("main")!.scrollWidth,
    title: Math.round(
      document.querySelector("main h1")!.getBoundingClientRect().right,
    ),
  }));
  expect(widths.main).toBeLessThanOrEqual(widths.screen);
  expect(widths.title).toBeLessThanOrEqual(widths.screen);
});
