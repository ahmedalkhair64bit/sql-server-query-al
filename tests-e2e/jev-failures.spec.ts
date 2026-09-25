import { test, expect } from "@playwright/test";
import { openQaDatabase } from "./qa-db";
import { randomUUID } from "node:crypto";
import { digestPlan } from "../lib/digest";
import { readFileSync } from "node:fs";
test.use({ storageState: ".auth/user.json" });
for (const status of ["abstained", "unavailable"])
  test(`stored ${status} result has no winner and keeps alternatives`, async ({
    page,
  }) => {
    const db = openQaDatabase();
    const user = db
      .prepare(
        "SELECT id FROM users WHERE email LIKE 'qa+%@qai.test' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { id: string };
    const id = randomUUID();
    const c = {
      version: 2,
      key: "review",
      title: "Review the baseline",
      diagnosis: "Current runtime evidence is incomplete.",
      actions: [
        {
          title: "Capture actual plan",
          detail: "Measure representative executions.",
          effort: "low",
          requires_change_control: false,
        },
      ],
      option_type: "ops",
      sql_to_run: "SELECT N'" + "x".repeat(5000) + "' AS [value];",
      expected: "Establish measured behavior.",
      evidence_ids: [],
      prerequisites: [],
      validation: ["Compare original results."],
      rollback: ["No production change."],
      rejected_reasons: [],
    };
    const verdict = {
      version: 2,
      status,
      source: "none",
      headline: null,
      order: [],
      jev_pick: null,
      jev_confidence: 0,
      agrees: false,
      anything_worth_running: 0,
      weights: {},
      flags: [
        status === "unavailable" ? "jev_unavailable" : "no_suitable_action",
      ],
    };
    db.prepare(
      "INSERT INTO analyses(id,user_id,title,xml,digest,candidates,verdict,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      user.id,
      `QA ${status}`,
      "",
      JSON.stringify(
        digestPlan(readFileSync("fixtures/sample.sqlplan", "utf8")),
      ),
      JSON.stringify([c]),
      JSON.stringify(verdict),
      "done",
      Date.now(),
      Date.now(),
    );
    db.close();
    await page.goto(`/app/${id}`);
    await expect(page.locator("[data-verdict]")).toContainText(
      /Jev declined to pick an action|Jev did not answer/,
    );
    await expect(page.locator("[data-verdict] h2")).not.toContainText(
      "Review the baseline",
    );
    await expect(page.locator(".option-card")).toContainText(
      "Review the baseline",
    );
    await expect(page.getByText("Recommended by Jev")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry Jev" })).toBeVisible();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const clipped = await page
        .locator(
          ".decision-hero,.option-card,.kpis,.finding-card,.timebars,.pipeline",
        )
        .evaluateAll((elements) =>
          elements
            .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
            .map((el) => el.className),
        );
      expect(clipped).toEqual([]);
    }
  });
