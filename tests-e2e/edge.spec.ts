import { test, expect } from "@playwright/test";
import type { DatabaseSync } from "node:sqlite";
import { openQaDatabase } from "./qa-db";
import { randomUUID } from "node:crypto";

test.use({ storageState: ".auth/user.json" });

// The app opens this file too (WAL), so writes here are just another connection.
function withDb<T>(fn: (d: DatabaseSync) => T): T {
  const d = openQaDatabase();
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

test("a row left running renders what exists instead of redirecting forever", async ({
  page,
}) => {
  const id = withDb((d) => {
    // The setup project's account, not "the newest user": the webkit specs sign up their own accounts and
    // would otherwise put this row under an account the stored session cannot open (404, not the note).
    const userId = d
      .prepare(
        "SELECT id FROM users WHERE email LIKE 'qa+%@qai.test' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { id: string };
    const aid = randomUUID();
    // Backdated so it never becomes the rail's first row: history.spec.ts depends on that row being a real run.
    d.prepare(
      "INSERT INTO analyses (id, user_id, title, xml, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      aid,
      userId.id,
      "Orphaned run",
      "<ShowPlanXML/>",
      "running",
      Date.now() - 3_600_000,
      Date.now() - 3_600_000,
    );
    return aid;
  });
  await page.goto(`/app/${id}`);
  await expect(
    page.getByText(/This run was interrupted before it finished/),
  ).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toContain(`/app/${id}`); // the old redirect sent this to itself
  await expect(page.getByRole("button", { name: "Analyse" })).toHaveCount(0);
});

test("an email another account already has is refused inline", async ({
  page,
}) => {
  withDb((d) =>
    d
      .prepare(
        "INSERT OR IGNORE INTO users (id, email, pass, created_at) VALUES (?,?,?,?)",
      )
      .run(randomUUID(), "taken@qai.test", "salt:hash", Date.now()),
  );
  await page.goto("/settings");
  await page.fill("#email", "taken@qai.test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("form p[role=alert]")).toContainText(
    "That email already has an account",
    { timeout: 15_000 },
  );
  const still = withDb(
    (d) =>
      (
        d
          .prepare("SELECT email FROM users WHERE email = ?")
          .get("taken@qai.test") as { email: string }
      ).email,
  );
  expect(still).toBe("taken@qai.test");
});
