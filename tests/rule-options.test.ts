import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlanText, recommendStatement } from "../lib/plan-parser.mjs";
import { decodeBytes } from "../lib/plan-decoder.mjs";
import { ruleOptions, withRuleOptions } from "../lib/rule-options.mjs";
import { checkCandidateSql } from "../lib/sql-check.mjs";

const plan = (f: string) =>
  recommendStatement(
    parsePlanText(decodeBytes(readFileSync(`fixtures/eval/${f}`))),
  );
const sqlOf = (f: string) =>
  ruleOptions(plan(f)).map((o: any) => o.sql_to_run.replace(/\s+/g, " "));

test("an eager index spool becomes the index SQL Server kept building", () => {
  assert.deepEqual(sqlOf("index-spool.sqlplan"), [
    "CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId] ON [dbo].[Orders] ([CustomerId]) INCLUDE ([Total]);",
  ]);
});

test("a key lookup is covered with the seek's keys and the looked-up columns, never reusing a name", () => {
  assert.deepEqual(sqlOf("key-lookup.sqlplan"), [
    "CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId_Covering] ON [dbo].[Orders] ([CustomerId]) INCLUDE ([Status], [Total]);",
  ]);
});

test("YEAR(col) = N is rewritten as a range with its index as one option, or alone when the index exists", () => {
  assert.deepEqual(sqlOf("non-sargable-accurate-estimates.sqlplan"), [
    "CREATE NONCLUSTERED INDEX [IX_Tickets_CreatedOn] ON [dbo].[Tickets] ([CreatedOn]); SELECT COUNT(*) FROM dbo.Tickets WHERE CreatedOn >= '20240101' AND CreatedOn < '20250101';",
  ]);
  // The plan already scans IX_Orders_OrderDate: only YEAR() stops the seek.
  assert.deepEqual(sqlOf("non-sargable.sqlplan"), [
    "SELECT o.OrderId FROM dbo.Orders o WHERE o.OrderDate >= '20250101' AND o.OrderDate < '20260101';",
  ]);
});

test("parameter sniffing and an unmatched filtered index get OPTION (RECOMPILE) on the full statement", () => {
  assert.deepEqual(sqlOf("parameter-sniffing.sqlplan"), [
    "SELECT * FROM dbo.Orders o WHERE o.Status = @status OPTION (RECOMPILE);",
  ]);
  assert.deepEqual(sqlOf("unmatched-filtered-index.sqlplan"), [
    "SELECT o.OrderId FROM dbo.Orders o WHERE o.Status = @s OPTION (RECOMPILE);",
  ]);
});

test("a healthy plan gets no rule options, and every rule option passes the SQL checks", () => {
  assert.deepEqual(ruleOptions(plan("healthy.sqlplan")), []);
  const cases = JSON.parse(readFileSync("fixtures/eval/cases.json", "utf8"))
    .cases as { file: string }[];
  for (const { file } of cases) {
    const d = plan(file);
    for (const o of ruleOptions(d))
      assert.deepEqual(checkCandidateSql(o, d).errors, [], `${file} ${o.key}`);
  }
});

test("a model option that creates the same index as a rule option is dropped for the rule's", () => {
  const rule = ruleOptions(plan("index-spool.sqlplan"));
  const model = [
    {
      key: "idx_model",
      option_type: "index",
      sql_to_run:
        "CREATE INDEX IX_Other ON dbo.Orders (CustomerId) INCLUDE (Total, Status);",
    },
    { key: "rewrite_model", option_type: "rewrite", sql_to_run: "SELECT 1" },
  ];
  const merged = withRuleOptions(rule, model as any);
  assert.deepEqual(
    merged.map((o: any) => o.key),
    [rule[0].key, "rewrite_model"],
  );
});

test("a query that already runs in milliseconds is decided by rule: nothing to tune for speed", async () => {
  const { fastQueryReason } = await import("../lib/rule-options.mjs");
  assert.match(fastQueryReason(plan("healthy.sqlplan"))!, /ran in \d+ ms/);
  assert.equal(
    fastQueryReason(plan("key-lookup.sqlplan")),
    null,
    "5.2 s is worth tuning",
  );
  assert.equal(
    fastQueryReason(plan("residual-scan-estimated.sqlplan")),
    null,
    "an estimated plan has no measured time",
  );
});
