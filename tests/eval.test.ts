import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlanText } from "../lib/plan-parser.mjs";
import { detectFindings } from "../lib/findings.mjs";
import { checkCandidateSql, parseDdl } from "../lib/sql-check.mjs";
import { buildValidationScript } from "../lib/validation-pack.mjs";
import { compareDigests } from "../lib/compare.mjs";

const cases = JSON.parse(readFileSync("fixtures/eval/cases.json", "utf8"))
  .cases as {
  file: string;
  expect_findings: string[];
  correct_fix_types: string[];
}[];
const load = (file: string) =>
  parsePlanText(readFileSync(`fixtures/eval/${file}`, "utf8"))[0];

// ---- item 6: the evaluation set, deterministic half (the live half is scripts/eval-plans.mjs) ----
for (const c of cases)
  test(`eval: ${c.file} detects ${c.expect_findings.join(", ") || "nothing to fix"}`, () => {
    const found = detectFindings(load(c.file));
    const rules = new Set(found.map((f) => f.rule));
    for (const r of c.expect_findings)
      assert.ok(rules.has(r), `missing ${r}: ${[...rules]}`);
    if (!c.expect_findings.length)
      assert.deepEqual(
        found.filter((f) => f.severity !== "info"),
        [],
        "a healthy plan must not raise warnings",
      );
  });

// ---- item 1: findings ----
test("findings sit in the model evidence ahead of raw operators", async () => {
  const { digestForModel } = await import("../lib/digest.ts");
  const kinds = digestForModel(load("key-lookup.sqlplan")).evidence.map(
    (e) => e.kind,
  );
  assert.ok(kinds.indexOf("finding") < kinds.indexOf("operator"));
});
test("a repeated estimate miss up the tree is one finding", () => {
  const f = detectFindings(load("parameter-sniffing.sqlplan"));
  assert.equal(f.filter((x) => x.rule === "row_estimate_error").length, 1);
});

// ---- item 2: SQL checks ----
const d = load("key-lookup.sqlplan");
const idx = (sql: string, extra = {}) =>
  checkCandidateSql({ option_type: "index", sql_to_run: sql, ...extra }, d);
test("a well-formed covering index on real columns passes", () => {
  const r = idx(
    "CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId_Cover] ON [dbo].[Orders] ([CustomerId]) INCLUDE ([Status], [Total]) WITH (ONLINE = ON);",
  );
  assert.deepEqual(r.errors, []);
  assert.ok(
    r.warnings.some((w) => /already seeks/.test(w)),
    "near-duplicate of IX_Orders_CustomerId",
  );
});
test("invented tables and columns are rejected", () => {
  assert.ok(
    idx("CREATE INDEX IX_A ON dbo.Invoices (CustomerId);").errors.some((e) =>
      /does not appear/.test(e),
    ),
  );
  assert.ok(
    idx(
      "CREATE INDEX IX_A ON dbo.Orders (CustomerId) INCLUDE (Discount);",
    ).errors.some((e) => /Discount/.test(e)),
  );
});
test("an existing index name, missing DDL and broken SQL are rejected", () => {
  assert.ok(
    idx(
      "CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);",
    ).errors.some((e) => /already exists/.test(e)),
  );
  assert.ok(
    idx("UPDATE STATISTICS dbo.Orders;").errors.some((e) =>
      /CREATE INDEX/.test(e),
    ),
  );
  assert.ok(
    idx("CREATE INDEX IX_B ON dbo.Orders ((CustomerId);").errors.some((e) =>
      /not well-formed/.test(e),
    ),
  );
  assert.ok(
    idx(
      "CREATE INDEX IX_B ON dbo.Orders (CustomerId) WHERE Status = 'x;",
    ).errors.some((e) => /not well-formed/.test(e)),
  );
});
test("unique and clustered indexes warn", () => {
  assert.ok(
    idx("CREATE UNIQUE INDEX IX_U ON dbo.Orders (CustomerId);").warnings.some(
      (w) => /UNIQUE/.test(w),
    ),
  );
});
test("range columns ahead of equality columns warn", () => {
  const p = load("residual-scan-estimated.sqlplan");
  const table = p.missingIndexes[0].table;
  const withRange = {
    ...p,
    missingIndexes: [
      {
        table,
        equality: ["CategoryId"],
        inequality: ["Discontinued"],
        included: [],
        impact: 90,
      },
    ],
  };
  const sql = (keys: string) => ({
    option_type: "index",
    sql_to_run: `CREATE INDEX IX_P ON dbo.Products (${keys}) INCLUDE (Name);`,
  });
  assert.ok(
    checkCandidateSql(sql("Discontinued, CategoryId"), withRange).warnings.some(
      (w) => /equality columns should lead/.test(w),
    ),
  );
  assert.ok(
    !checkCandidateSql(
      sql("CategoryId, Discontinued"),
      withRange,
    ).warnings.some((w) => /equality/.test(w)),
  );
});
test("a rewrite must keep the statement type", () => {
  const r = checkCandidateSql(
    { option_type: "rewrite", sql_to_run: "DELETE FROM dbo.Orders WHERE 1=0" },
    d,
  );
  assert.ok(r.errors.some((e) => /DELETE/.test(e)));
  const ok = checkCandidateSql(
    {
      option_type: "rewrite",
      sql_to_run:
        "WITH x AS (SELECT 1 AS a) SELECT o.OrderId FROM dbo.Orders o",
    },
    d,
  );
  assert.deepEqual(ok.errors, []);
});
test("DDL parsing understands brackets, dots inside brackets and INCLUDE", () => {
  const p = parseDdl(
    "CREATE NONCLUSTERED INDEX [IX.x] ON [Sales].[Order Lines] ([Line Id] DESC, B) INCLUDE ([C]);",
  );
  assert.deepEqual(p.indexes[0].table, ["Sales", "Order Lines"]);
  assert.equal(p.indexes[0].name, "IX.x");
  assert.deepEqual(p.indexes[0].keys, ["Line Id", "B"]);
  assert.deepEqual(p.indexes[0].include, ["C"]);
});
test("analyst options with invented columns are rejected before Jev", async () => {
  const { proposeCandidates } = await import("../lib/analyst.ts");
  const option = (key: string, sql: string) => ({
    key,
    title: "Covering index",
    diagnosis: "Key lookup runs 60,000 times against the clustered index.",
    actions: [
      {
        title: "Create index",
        detail: "Covering index",
        effort: "medium",
        requires_change_control: true,
      },
    ],
    option_type: "index",
    sql_to_run: sql,
    expected: "Lookup disappears",
    evidence_ids: ["s1:statement"],
    validation: ["compare reads"],
    rollback: ["drop it"],
  });
  const body = {
    candidates: [
      option(
        "good",
        "CREATE INDEX IX_Orders_Cover ON dbo.Orders (CustomerId) INCLUDE (Status, Total);",
      ),
      option(
        "bad",
        "CREATE INDEX IX_Orders_Bad ON dbo.Orders (CustomerId) INCLUDE (Discount);",
      ),
    ],
  };
  const res = new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
    }),
  );
  const out = await proposeCandidates(
    { baseUrl: "http://x", apiKey: "k", model: "m", extra: {} },
    d,
    "",
    async () => res.clone(),
  );
  assert.deepEqual(out[0].rejected_reasons, []);
  assert.ok(out[1].rejected_reasons.some((r) => /Discount/.test(r)));
});

// ---- item 4: validation script ----
test("the validation script declares parameters once and carries baseline, checks, change and rollback", () => {
  const s = buildValidationScript(
    {
      key: "cover",
      title: "Covering index",
      option_type: "index",
      sql_to_run:
        "CREATE INDEX IX_Orders_Cover ON dbo.Orders (CustomerId) INCLUDE (Status, Total);",
      rollback: [],
    },
    d,
  );
  assert.equal(s.match(/DECLARE @cust int = 1042;/g)?.length, 1);
  assert.match(s, /SET STATISTICS IO, TIME ON;/);
  assert.match(s, /OBJECT_ID\(N'\[dbo\]\.\[Orders\]'\)/);
  assert.match(s, /sys\.dm_db_stats_properties/);
  assert.match(s, /WHERE q\.query_hash = 0x1\b/);
  assert.match(s, /-- DROP INDEX \[IX_Orders_Cover\] ON \[dbo\]\.\[Orders\];/);
});
test("a rewrite's script proves equal results with EXCEPT both ways", () => {
  const s = buildValidationScript(
    {
      key: "rw",
      title: "Rewrite",
      option_type: "rewrite",
      sql_to_run:
        "SELECT o.OrderId, o.Status, o.Total FROM dbo.Orders AS o WHERE o.CustomerId = @cust ORDER BY o.OrderId;",
    },
    d,
  );
  assert.equal(s.match(/\nEXCEPT\n/g)?.length, 2);
  assert.ok(
    !/ORDER BY o\.OrderId\n\) AS/.test(s),
    "ORDER BY removed inside derived tables",
  );
});
test("a hash that is not a hex literal never reaches the script", () => {
  const s = buildValidationScript(
    { key: "k", title: "t", option_type: "ops", sql_to_run: null },
    { ...d, queryHash: "0x1; DROP TABLE x" },
  );
  assert.ok(!/DROP TABLE x/.test(s));
});

// ---- item 5: before/after comparison ----
test("a measured improvement resolves the finding it targeted", () => {
  const before = load("key-lookup.sqlplan");
  const after = structuredClone(before);
  after.queryTime = { cpuMs: 60, elapsedMs: 70 };
  after.topOperators = [
    {
      id: "1",
      op: "Index Seek",
      cost: 0.2,
      estRows: 60000,
      actualRows: 60000,
      execs: 1,
      parallel: false,
      logicalReads: 240,
    },
  ];
  const r = compareDigests(before, after);
  assert.equal(r.basis, "measured");
  assert.equal(r.verdict, "improved");
  assert.ok(r.resolved.some((f) => f.rule === "key_lookup"));
  assert.equal(r.sameQuery, true);
});
test("a slower after plan is a regression; estimated-only plans say so", () => {
  const before = load("key-lookup.sqlplan");
  const slower = {
    ...structuredClone(before),
    queryTime: { cpuMs: 9000, elapsedMs: 9000 },
  };
  assert.equal(compareDigests(before, slower).verdict, "regressed");
  const est = load("residual-scan-estimated.sqlplan");
  const cheaper = { ...structuredClone(est), subtreeCost: 0.5 };
  const r = compareDigests(est, cheaper);
  assert.equal(r.basis, "estimated");
  assert.equal(r.verdict, "improved");
  assert.match(r.summary, /estimated cost only/);
});
