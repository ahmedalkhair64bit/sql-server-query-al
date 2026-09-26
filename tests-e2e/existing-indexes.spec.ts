import { test, expect } from "@playwright/test";
test.use({ storageState: ".auth/user.json" });

// A plan names the indexes it used but not their keys, so a suggested index could duplicate one the table
// already has. The DBA pastes the result of a read-only query and the suggestion extends the existing index.
test("pasted existing indexes turn a duplicate index into DROP_EXISTING on the existing one", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/app");
  await page.setInputFiles(
    "input[type=file]",
    "fixtures/eval/key-lookup.sqlplan",
  );
  await expect(page.locator("#statement")).toBeVisible();
  await page.getByText("Existing indexes").click();
  await page.getByRole("button", { name: "Copy query" }).click();
  const query = page.getByLabel("Existing indexes query");
  await expect(query).toHaveValue(/FROM sys\.indexes/);
  await expect(query).toHaveValue(/N'dbo\.Orders'/);

  await page.fill("#context", "not the result");
  await expect(page.getByText("Not recognised")).toBeVisible();
  await page.fill(
    "#context",
    JSON.stringify([
      {
        schema: "dbo",
        table: "Orders",
        rows: 60000,
        indexes: [
          {
            name: "IX_Orders_CustomerId",
            type: "NONCLUSTERED",
            unique: false,
            filtered: false,
            keys: [{ column: "CustomerId", desc: false }],
            include: [{ column: "OrderDate" }],
          },
        ],
      },
    ]),
  );
  await expect(page.getByText("Read 1 table and 1 index.")).toBeVisible();
  await page.fill("#note", "qa existing indexes");
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page.locator("[data-verdict]")).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText(/Extend IX_Orders_CustomerId/).first(),
  ).toBeVisible();
  await expect(page.getByText(/DROP_EXISTING = ON/).first()).toBeAttached();
});
