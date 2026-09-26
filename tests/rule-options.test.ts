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

// ---- more patterns ----
const fromXml = (xml: string) => recommendStatement(parsePlanText(xml));
const variant = (statement: string, predicate: string) =>
  fromXml(
    readFileSync("fixtures/eval/non-sargable.sqlplan", "utf8")
      .replace(/StatementText="[^"]*"/, `StatementText="${statement}"`)
      .replace(/ScalarString="datepart[^"]*"/, `ScalarString="${predicate}"`),
  );

test("CAST(col AS date) = value becomes a one-day range; LEFT(col, n) = 'text' becomes a LIKE prefix", () => {
  const cast = ruleOptions(
    variant(
      "SELECT o.OrderId FROM dbo.Orders o WHERE CAST(o.OrderDate AS date) = @d",
      "CONVERT(date,[Shop].[dbo].[Orders].[OrderDate] as [o].[OrderDate],0)=[@d]",
    ),
  );
  assert.equal(
    cast[0].sql_to_run,
    "SELECT o.OrderId FROM dbo.Orders o WHERE o.OrderDate >= @d AND o.OrderDate < DATEADD(day, 1, @d);",
  );
  const left = ruleOptions(
    variant(
      "SELECT o.OrderId FROM dbo.Orders o WHERE LEFT(o.OrderDate, 4) = '2025'",
      "substring([Shop].[dbo].[Orders].[OrderDate] as [o].[OrderDate],(1),(4))='2025'",
    ),
  );
  assert.match(left[0].sql_to_run, /o\.OrderDate LIKE '2025%'/);
  // LEFT(col, 3) = 'abcd' cannot be the same rows as a prefix of a different length: no option.
  assert.deepEqual(
    ruleOptions(
      variant(
        "SELECT o.OrderId FROM dbo.Orders o WHERE LEFT(o.OrderDate, 3) = '2025'",
        "substring([Shop].[dbo].[Orders].[OrderDate] as [o].[OrderDate],(1),(3))='2025'",
      ),
    ).filter((o: any) => o.key.startsWith("rule_sargable")),
    [],
  );
});

test("statistics: refresh the stale ones behind a real estimate error; create the missing ones", () => {
  assert.deepEqual(sqlOf("stale-statistics.sqlplan"), [
    "UPDATE STATISTICS [dbo].[Events] [IX_Events_CreatedAt] WITH FULLSCAN;",
  ]);
  assert.deepEqual(
    ruleOptions(
      recommendStatement(
        parsePlanText(
          decodeBytes(
            readFileSync(
              "fixtures/external/html-query-plan/test_plans/columns_with_no_statistics.sqlplan",
            ),
          ),
        ),
      ),
    ).map((o: any) => o.sql_to_run),
    [
      "CREATE STATISTICS [ST_TestTableA_TestTableB_Id] ON [myschema].[TestTableA] ([TestTableB_Id]) WITH FULLSCAN;",
    ],
  );
});

test("row goal, table variable, implicit conversion and blocking get their textbook fixes", () => {
  assert.deepEqual(sqlOf("row-goal.sqlplan"), [
    "SELECT TOP (10) o.OrderId FROM dbo.Orders o JOIN dbo.Customers c ON c.CustomerId = o.CustomerId WHERE c.Region = 'EMEA' ORDER BY o.OrderId OPTION (USE HINT ('DISABLE_OPTIMIZER_ROWGOAL'));",
  ]);
  assert.deepEqual(sqlOf("table-variable.sqlplan"), [
    "SELECT o.OrderId FROM @ids i JOIN dbo.Orders o ON o.OrderId = i.Id OPTION (RECOMPILE);",
  ]);
  const conv = ruleOptions(plan("implicit-conversion.sqlplan"));
  assert.equal(conv[0].title, "Send @code as varchar(20) to match AccountCode");
  assert.equal(conv[0].option_type, "app");
  const block = ruleOptions(plan("blocking-waits.sqlplan"));
  assert.equal(block[0].key, "rule_find_blocker");
});
