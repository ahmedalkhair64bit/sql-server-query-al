// Tests Jev on its own: for every evaluation plan, a fixed set of hand-written options (one correct fix,
// a plausible decoy that misses the real problem, and sometimes a risky option) goes through the same
// SQL checks as real analyst output, then to the real Jev. Jev passes a case when it picks the correct
// option's type, or declines where declining is right (the healthy plan).
//
//   JEV_API_KEY=... [JEV_MODEL=jev-latest] npm run eval:jev [-- --json]
//
// This isolates Jev's judgment from the analyst model: no analyst key is needed.
import { readFileSync } from "node:fs";
import { parsePlanText } from "../lib/plan-parser.mjs";

const key = process.env.JEV_API_KEY;
if (!key) {
  console.error("Set JEV_API_KEY (your TypeSafe key).");
  process.exit(1);
}
const { proposeCandidates } = await import("../lib/analyst.ts");
const { judgeCandidates, makeJevClient } = await import("../lib/jev.ts");
const { digestForModel } = await import("../lib/digest.ts");

const opt = (
  key,
  option_type,
  title,
  diagnosis,
  sql_to_run,
  expected,
  extra = {},
) => ({
  key,
  option_type,
  title,
  diagnosis,
  sql_to_run,
  expected,
  actions: [
    {
      title,
      detail: extra.detail ?? diagnosis,
      effort: extra.effort ?? "low",
      requires_change_control:
        extra.cc ?? ["index", "schema"].includes(option_type),
    },
  ],
  prerequisites: extra.pre ?? [
    "Confirm the statement and parameters match production.",
  ],
  validation: [
    "Compare logical reads, CPU and elapsed time before and after with SET STATISTICS IO, TIME ON.",
  ],
  rollback: [
    extra.rollback ??
      "Revert the change and confirm the original plan returns.",
  ],
});

const CASES = {
  "key-lookup.sqlplan": [
    opt(
      "covering_index",
      "index",
      "Covering index on CustomerId",
      "The key lookup runs 60,000 times because IX_Orders_CustomerId lacks Status and Total.",
      "CREATE NONCLUSTERED INDEX IX_Orders_CustomerId_Cover ON dbo.Orders (CustomerId) INCLUDE (Status, Total) WITH (ONLINE = ON);",
      "The key lookup disappears; logical reads drop from about 180,000 to a few hundred.",
      { rollback: "DROP INDEX IX_Orders_CustomerId_Cover ON dbo.Orders;" },
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Orders",
      "Statistics may be stale and could affect the join choice.",
      "UPDATE STATISTICS dbo.Orders WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
    opt(
      "nolock",
      "rewrite",
      "Read with NOLOCK",
      "Locking may slow the lookups; reading uncommitted data avoids it.",
      "SELECT o.OrderId, o.Status, o.Total FROM dbo.Orders o WITH (NOLOCK) WHERE o.CustomerId = @cust",
      "Fewer lock waits.",
    ),
  ],
  "parameter-sniffing.sqlplan": [
    opt(
      "recompile",
      "rewrite",
      "OPTION (RECOMPILE) for the status filter",
      "The plan was compiled for the rare value 'Cancelled' and reused for 'Shipped', which returns 900,000 rows.",
      "SELECT * FROM dbo.Orders o WHERE o.Status = @status OPTION (RECOMPILE)",
      "Each execution gets a plan for its own value; the 900,000-row case scans instead of doing 900,000 lookups.",
    ),
    opt(
      "free_cache",
      "ops",
      "Clear the whole plan cache",
      "A bad cached plan is being reused.",
      null,
      "The next execution compiles a new plan.",
      { detail: "Run DBCC FREEPROCCACHE on the production server.", cc: true },
    ),
  ],
  "implicit-conversion.sqlplan": [
    opt(
      "fix_param_type",
      "app",
      "Send @code as varchar(20)",
      "The application sends nvarchar, forcing CONVERT_IMPLICIT on the varchar AccountCode column, which prevents a seek on IX_Customers_AccountCode.",
      null,
      "The predicate becomes sargable and the 2-million-row scan turns into a seek.",
      {
        detail:
          "Change the parameter type in the application's data access code to varchar(20).",
      },
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Customers",
      "Statistics may be out of date.",
      "UPDATE STATISTICS dbo.Customers WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
  ],
  "sort-spill.sqlplan": [
    opt(
      "fix_stats",
      "statistics",
      "Full-scan statistics on the OrderDate index",
      "The seek estimated 1,200 rows and returned 1.5 million, so the sort's memory grant was far too small and it spilled.",
      "UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate WITH FULLSCAN;",
      "A realistic estimate sizes the memory grant; the sort stops spilling to tempdb.",
    ),
    opt(
      "drop_order",
      "rewrite",
      "Remove the ORDER BY",
      "Sorting is expensive.",
      "SELECT o.CustomerId, o.Total FROM dbo.Orders o WHERE o.OrderDate >= @from",
      "No sort at all.",
    ),
    opt(
      "more_memory",
      "ops",
      "Add server memory",
      "The sort spilled because memory was short.",
      null,
      "More memory available for grants.",
      { effort: "high", cc: true },
    ),
  ],
  "stale-statistics.sqlplan": [
    opt(
      "update_stats",
      "statistics",
      "Update the ascending-key statistics",
      "IX_Events_CreatedAt statistics are 4.2 million modifications old and sampled at 0.8%, so the recent range is estimated at 10 rows instead of 4.1 million.",
      "UPDATE STATISTICS dbo.Events IX_Events_CreatedAt WITH FULLSCAN;",
      "The estimate for recent dates becomes realistic.",
    ),
    opt(
      "dup_index",
      "index",
      "Add another index on CreatedAt",
      "A new index could help the range query.",
      "CREATE INDEX IX_Events_CreatedAt_2 ON dbo.Events (CreatedAt);",
      "Faster range reads.",
    ),
  ],
  "residual-scan-estimated.sqlplan": [
    opt(
      "category_index",
      "index",
      "Index on CategoryId, Discontinued",
      "The clustered scan reads 3 million rows to return 420 because no index supports CategoryId = 7 AND Discontinued = 0.",
      "CREATE NONCLUSTERED INDEX IX_Products_Category ON dbo.Products (CategoryId, Discontinued) INCLUDE (Name);",
      "A seek reading about 420 rows instead of a 3-million-row scan (estimated plan: confirm with an actual plan).",
      { rollback: "DROP INDEX IX_Products_Category ON dbo.Products;" },
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Products",
      "Statistics may be stale.",
      "UPDATE STATISTICS dbo.Products WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
    opt(
      "nolock",
      "rewrite",
      "Read with NOLOCK",
      "Avoid locking during the scan.",
      "SELECT p.ProductId, p.Name FROM dbo.Products p WITH (NOLOCK) WHERE p.CategoryId = 7 AND p.Discontinued = 0",
      "Fewer lock waits.",
    ),
  ],
  "scalar-udf.sqlplan": [
    opt(
      "inline_udf",
      "rewrite",
      "Replace the scalar UDF with an inline table-valued function",
      "dbo.fn_OrderMargin runs once per row (13.2 s of UDF CPU out of 14.1 s) and forces a serial plan.",
      "SELECT o.OrderId, m.Margin FROM dbo.Orders o CROSS APPLY dbo.tvf_OrderMargin(o.OrderId) AS m WHERE o.OrderDate >= @from",
      "The margin is computed set-based; CPU drops from about 14 s to under a second.",
      {
        pre: [
          "Create dbo.tvf_OrderMargin with the same logic as the scalar function and verify identical results.",
        ],
      },
    ),
    opt(
      "maxdop",
      "ops",
      "Raise MAXDOP for this query",
      "More parallelism would spread the work.",
      null,
      "Faster execution.",
      { cc: true },
    ),
  ],
  "table-variable.sqlplan": [
    opt(
      "temp_table",
      "rewrite",
      "Use a temp table instead of @ids",
      "The table variable is estimated at 1 row but holds 250,000, so the optimizer chose 250,000 nested-loop seeks.",
      "SELECT o.OrderId FROM #ids AS i JOIN dbo.Orders AS o ON o.OrderId = i.Id",
      "With statistics on #ids the optimizer sees 250,000 rows and picks a hash or merge join.",
      { pre: ["Load the ids into #ids (with a primary key) instead of @ids."] },
    ),
    opt(
      "dup_pk_index",
      "index",
      "Index on Orders.OrderId",
      "An index on OrderId could speed up the join.",
      "CREATE INDEX IX_Orders_OrderId ON dbo.Orders (OrderId);",
      "Faster seeks.",
    ),
  ],
  "healthy.sqlplan": [
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Orders",
      "Statistics could be refreshed as routine maintenance.",
      "UPDATE STATISTICS dbo.Orders WITH FULLSCAN;",
      "Possibly marginally better estimates.",
    ),
    opt(
      "extra_index",
      "index",
      "Covering index on OrderId",
      "A narrower index could cover the query.",
      "CREATE INDEX IX_Orders_OrderId_Total ON dbo.Orders (OrderId) INCLUDE (Total);",
      "Marginally fewer reads.",
    ),
  ],
  "parallel-skew.sqlplan": [
    opt(
      "investigate_skew",
      "ops",
      "Investigate CustomerId skew and test a lower DOP",
      "One thread read 1.9 million rows while seven read 15,000 each; CXPACKET waits dominate, so parallelism is not helping.",
      null,
      "Understanding the skew; OPTION (MAXDOP 2) or a pre-aggregation removes the waiting threads.",
      {
        detail:
          "Check the row distribution per CustomerId and test OPTION (MAXDOP 2) against the current plan.",
      },
    ),
    opt(
      "app_cache",
      "app",
      "Cache the result in the application",
      "The query is slow, so cache it.",
      null,
      "Fewer executions.",
      { effort: "high" },
    ),
  ],
  "index-spool.sqlplan": [
    opt(
      "spool_index",
      "index",
      "Index on Orders (CustomerId) INCLUDE (Total)",
      "The optimizer builds an index spool over 2 million Orders rows on every execution because no index supports the correlated MAX(Total) by CustomerId.",
      "CREATE NONCLUSTERED INDEX IX_Orders_CustomerId_Total ON dbo.Orders (CustomerId) INCLUDE (Total);",
      "The eager index spool disappears; each customer's MAX(Total) becomes a seek.",
      { rollback: "DROP INDEX IX_Orders_CustomerId_Total ON dbo.Orders;" },
    ),
    opt(
      "inner_join",
      "rewrite",
      "Rewrite the subquery as an inner join",
      "Joins are faster than subqueries.",
      "SELECT c.CustomerId, MAX(o.Total) FROM dbo.Customers c JOIN dbo.Orders o ON o.CustomerId = c.CustomerId GROUP BY c.CustomerId",
      "Faster aggregation.",
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Orders",
      "Statistics may be stale.",
      "UPDATE STATISTICS dbo.Orders WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
  ],
  "non-sargable.sqlplan": [
    opt(
      "date_range",
      "rewrite",
      "Use a date range instead of YEAR()",
      "YEAR(OrderDate) = 2025 wraps the column in a function, so IX_Orders_OrderDate is scanned (2 million rows) instead of sought.",
      "SELECT o.OrderId FROM dbo.Orders o WHERE o.OrderDate >= '20250101' AND o.OrderDate < '20260101'",
      "An index seek on the 2025 range; the same rows, far fewer reads.",
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Orders",
      "Statistics may be stale.",
      "UPDATE STATISTICS dbo.Orders WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
  ],
  "blocking-waits.sqlplan": [
    opt(
      "find_blocker",
      "ops",
      "Find and fix the blocking session",
      "The one-row update waited 29.5 of 29.6 seconds on LCK_M_U: another session held the lock. The plan itself is a single-row seek.",
      null,
      "Identifying the blocker (sys.dm_exec_requests, blocked process report) and shortening its transaction removes the wait.",
      {
        detail:
          "Capture the blocking chain with sys.dm_exec_requests and a blocked process report, then shorten or reschedule the blocking transaction.",
      },
    ),
    opt(
      "sku_index",
      "index",
      "Covering index on Inventory (Sku) INCLUDE (Qty)",
      "A covering index would make the update faster.",
      "CREATE INDEX IX_Inventory_Sku_Qty ON dbo.Inventory (Sku) INCLUDE (Qty);",
      "Faster update.",
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Inventory",
      "Statistics may be stale.",
      "UPDATE STATISTICS dbo.Inventory WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
  ],
  "row-goal.sqlplan": [
    opt(
      "disable_rowgoal",
      "rewrite",
      "Disable the row goal for this query",
      "TOP (10) made the optimizer expect EMEA orders early; it read 1.8 million orders and did 1.8 million customer seeks because EMEA customers are rare.",
      "SELECT TOP (10) o.OrderId FROM dbo.Orders o JOIN dbo.Customers c ON c.CustomerId = o.CustomerId WHERE c.Region = 'EMEA' ORDER BY o.OrderId OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))",
      "The optimizer costs the full join and picks a plan that filters EMEA customers first.",
    ),
    opt(
      "refresh_stats",
      "statistics",
      "Refresh statistics on Customers",
      "Statistics may be stale.",
      "UPDATE STATISTICS dbo.Customers WITH FULLSCAN;",
      "Possibly better estimates.",
    ),
  ],
  "expensive-sort.sqlplan": [
    opt(
      "ordered_index",
      "index",
      "Index on (Status, OrderDate) delivering the order",
      "Sorting 900,000 rows is 87% of the elapsed time and needs a 500 MB grant; an index keyed on Status then OrderDate returns them already ordered.",
      "CREATE NONCLUSTERED INDEX IX_Orders_Status_OrderDate ON dbo.Orders (Status, OrderDate) INCLUDE (CustomerId, Total);",
      "The Sort operator and its memory grant disappear.",
      { rollback: "DROP INDEX IX_Orders_Status_OrderDate ON dbo.Orders;" },
    ),
    opt(
      "more_memory",
      "ops",
      "Add server memory",
      "The sort needs a lot of memory.",
      null,
      "More memory for grants.",
      { effort: "high", cc: true },
    ),
  ],
  "unmatched-filtered-index.sqlplan": [
    opt(
      "recompile",
      "rewrite",
      "OPTION (RECOMPILE) so the filtered index can match",
      "IX_Orders_Open filters Status = 'Open', but a parameterized predicate cannot be proven to match it, so the clustered index is scanned.",
      "SELECT o.OrderId FROM dbo.Orders o WHERE o.Status = @s OPTION (RECOMPILE)",
      "The optimizer sees the value, matches the filtered index and seeks it.",
    ),
    opt(
      "dup_index",
      "index",
      "Unfiltered index on Status",
      "An unfiltered index would always be usable.",
      "CREATE INDEX IX_Orders_Status_All ON dbo.Orders (Status) INCLUDE (OrderId);",
      "Usable index.",
    ),
  ],
  "linked-server.sqlplan": [
    opt(
      "openquery",
      "rewrite",
      "Filter on the remote server with OPENQUERY",
      "3 million rows cross the linked server and are filtered locally for Total > 1000.",
      "SELECT r.Id FROM OPENQUERY(REMOTESRV, 'SELECT Id FROM Sales.dbo.Orders WHERE Total > 1000') AS r",
      "Only the 4,000 matching rows cross the network.",
    ),
    opt(
      "bandwidth",
      "ops",
      "Increase network bandwidth to REMOTESRV",
      "The transfer is slow.",
      null,
      "Faster transfer.",
      { effort: "high", cc: true },
    ),
  ],
};

const expected = Object.fromEntries(
  JSON.parse(readFileSync("fixtures/eval/cases.json", "utf8")).cases.map(
    (c) => [c.file, c.correct_fix_types],
  ),
);
const client = makeJevClient(key, process.env.JEV_MODEL || "jev-latest");
const results = [];
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",")
  : null;
for (const [file, options] of Object.entries(CASES)) {
  if (only && !only.includes(file)) continue;
  const digest = parsePlanText(
    readFileSync(`fixtures/eval/${file}`, "utf8"),
  )[0];
  const ids = digestForModel(digest).evidence;
  const cite = [
    ids[0].id,
    ...ids
      .filter((e) => e.kind === "finding")
      .slice(0, 2)
      .map((e) => e.id),
  ];
  const body = {
    candidates: options.map((o) => ({ ...o, evidence_ids: cite })),
  };
  const fakeAnalyst = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
    );
  const started = Date.now();
  const row = { case: file, expected: expected[file] };
  try {
    const candidates = await proposeCandidates(
      { baseUrl: "x", apiKey: "x", model: "x", extra: {} },
      digest,
      "",
      fakeAnalyst,
    );
    row.rejectedByChecks = candidates
      .filter((c) => c.rejected_reasons.length)
      .map((c) => `${c.key}: ${c.rejected_reasons[0]}`);
    const v = await judgeCandidates(digest, candidates, client);
    const picked = candidates.find((c) => c.key === v.headline);
    row.picked = picked ? `${picked.key} (${picked.option_type})` : "declined";
    row.confidence = v.jev_confidence;
    row.worth = v.anything_worth_running;
    row.probabilities = v.jev_probabilities;
    row.flags = v.flags;
    row.detail = v.order.map((r) => ({
      key: r.key,
      evidence_support: r.evidence_support,
      operational_safety: r.operational_safety,
      dims: Object.fromEntries(
        Object.entries(r.dims).map(([k, d]) => [
          k,
          `${d.value.toFixed(2)}${d.confidence == null ? "" : ` c${d.confidence.toFixed(2)}`}${d.source ? " rule" : ""}`,
        ]),
      ),
    }));
    row.order = v.order.map(
      (r) =>
        `${r.key}:${r.composite.toFixed(2)}${r.flags.length ? `[${r.flags.join(",")}]` : ""}`,
    );
    row.pass = expected[file].length
      ? expected[file].includes(picked?.option_type)
      : !picked;
  } catch (e) {
    row.error = e.message.slice(0, 200);
    row.pass = false;
  }
  row.seconds = Math.round((Date.now() - started) / 1000);
  results.push(row);
  if (!process.argv.includes("--json"))
    console.log(
      `${row.pass ? "PASS" : "FAIL"}  ${file.padEnd(34)} picked=${row.picked ?? "error"}  expected=${expected[file].join("|") || "decline"}` +
        (row.confidence != null
          ? `  confidence=${row.confidence.toFixed(2)}`
          : "") +
        (row.error ? `  ERROR ${row.error}` : "") +
        `  (${row.seconds}s)`,
    );
}
const pass = results.filter((r) => r.pass).length;
if (process.argv.includes("--json"))
  console.log(JSON.stringify(results, null, 2));
console.log(
  `\nJev picked correctly or declined correctly on ${pass} of ${results.length} plans.`,
);
