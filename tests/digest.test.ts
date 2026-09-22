import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { digestPlan, PlanError, digestForModel } =
  await import("../lib/digest.ts");

export const PLAN = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.4085.2">
 <BatchSequence><Batch><Statements>
  <StmtSimple StatementId="1" StatementSubtreeCost="4.871" StatementOptmLevel="FULL"
              StatementText="SELECT o.Id FROM Sales.Orders o WHERE o.CustomerId = @c1 AND o.Total &gt; 500">
   <StatementOptmEarlyAbortReason>GoodEnoughPlanFound</StatementOptmEarlyAbortReason>
   <QueryBlock QueryHash="0x1A" QueryPlanHash="0x2B">
    <RelOp NodeId="0" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="1000"
           EstimateIO="41.6" EstimateCPU="39.0" EstimatedTotalSubtreeCost="4.10" Parallel="false">
      <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1243500" ActualExecs="1"
        ActualElapsedms="2411" ActualCPUms="2210"/></RunTimeInformation>
      <IndexScan Database="[wide]" Schema="[Sales]" Table="[Orders]"/>
      <Warnings><NoJoinPredicate/><SpillToTempDb SpillLevel="2"/>
        <WaitTime WaitType="PAGEIOLATCH_SH" WaitTime="812"/></Warnings>
    </RelOp>
    <RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="3"
           EstimateIO="0.7" EstimateCPU="0.02" EstimatedTotalSubtreeCost="0.77" Parallel="true">
      <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="4" ActualExecs="2"/></RunTimeInformation>
      <IndexScan Database="[wide]" Schema="[Sales]" Table="[Customer]"/>
    </RelOp>
    <MissingIndexes><MissingIndexGroup Impact="94.17">
      <MissingIndex Database="[wide]" Schema="[Sales]" Table="[Orders]">
        <ColumnGroup Usage="EQUALITY"><Column Name="[CustomerId]"/></ColumnGroup>
        <ColumnGroup Usage="INEQUALITY"><Column Name="[Total]"/></ColumnGroup>
        <IncludedColumns><Column Name="[Id]"/></IncludedColumns>
      </MissingIndex></MissingIndexGroup></MissingIndexes>
    <NonParallelPlanReason>Could Not Generate Valid Parallel Plan</NonParallelPlanReason>
   </QueryBlock>
  </StmtSimple>
 </Statements></Batch></BatchSequence>
</ShowPlanXML>`;

test("digests what matters in a showplan", () => {
  const d = digestPlan(PLAN);
  assert.match(d.sql, /o\.Total > 500/, "XML entities decoded");
  assert.equal(d.subtreeCost, 4.871);
  assert.equal(d.earlyAbort, "GoodEnoughPlanFound");
  assert.equal(d.nonParallelReason, "Could Not Generate Valid Parallel Plan");
  assert.deepEqual(d.tables, ["wide.Sales.Orders", "wide.Sales.Customer"]);
  assert.equal(d.topOperators[0].op, "Clustered Index Scan");
  assert.equal(d.topOperators[0].spillLevels, 2);
  assert.equal(d.topOperators[0].actualRows, 1243500);
  assert.equal(d.topOperators[0].parallel, false);
  assert.deepEqual(d.missingIndexes[0], {
    table: "wide.Sales.Orders",
    equality: ["CustomerId"],
    inequality: ["Total"],
    included: ["Id"],
    impact: 94.17,
  });
  assert.ok(d.warnings.includes("NoJoinPredicate"));
  assert.ok(d.warnings.some((w) => w.startsWith("SpillToTempDb")));
  assert.deepEqual(d.waits, [{ type: "PAGEIOLATCH_SH", ms: 812 }]);
  assert.ok((d.rowGuessErrors[0].ratio ?? 0) > 100);
  assert.equal(d.bytes, PLAN.length);
});
test("a BOM-prefixed plan still digests — SSMS writes .sqlplan as UTF-16 with a BOM", () => {
  assert.equal(digestPlan("\uFEFF" + PLAN).subtreeCost, 4.871);
});
test("rejects input that is not a plan", () => {
  for (const bad of ["", "SELECT 1", "<html></html>", "<ShowPlanXML><trunc"])
    assert.throws(() => digestPlan(bad), PlanError);
});
test("digestForModel stays bounded on a fat plan", () => {
  const big =
    `<ShowPlanXML><Batch><Statements><StmtSimple StatementText="q">` +
    Array.from(
      { length: 400 },
      (_, i) =>
        `<RelOp NodeId="${i}" LogicalOp="Scan" EstimateRows="1" EstimatedTotalSubtreeCost="${i}"/>`,
    ).join("") +
    `</StmtSimple></Statements></Batch></ShowPlanXML>`;
  const v = digestForModel(digestPlan(big)) as {
    topOperators: unknown[];
    tables: unknown[];
  };
  assert.ok(v.topOperators.length <= 12);
});
test("a real .sqlplan digests", () => {
  let xml: string;
  try {
    xml = readFileSync("fixtures/real.sqlplan", "utf8");
  } catch {
    return console.log("skip: no fixtures/real.sqlplan");
  }
  const d = digestPlan(xml);
  assert.ok(
    d.topOperators.length > 0,
    "no operators found — check attribute spellings",
  );
  assert.ok(d.sql.length > 0);
});

// ---- plan file decoding (lib/plan-file.ts: the browser reads a .sqlplan into bytes, then hands text to the digest) ----
const enc = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i);
    b[i * 2 + 1] = 0;
  }
  return b;
};
const utf16be = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = 0;
    b[i * 2 + 1] = s.charCodeAt(i);
  }
  return b;
};
const sample =
  '<?xml version="1.0"?><ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.0"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1"/></Statements></Batch></BatchSequence></ShowPlanXML>';

test("every .sqlplan encoding SSMS and friends produce arrives as clean text", async () => {
  const { decodePlan } = await import("../lib/plan-file.ts");
  const cases: [string, Uint8Array][] = [
    ["utf-8", enc(sample)],
    ["utf-8 + bom", enc("\uFEFF" + sample)],
    [
      "utf-16le + bom (what SSMS writes)",
      Uint8Array.from([0xff, 0xfe, ...utf16le(sample)]),
    ],
    ["utf-16be + bom", Uint8Array.from([0xfe, 0xff, ...utf16be(sample)])],
    ["utf-16le, no bom", utf16le(sample)],
    ["utf-16be, no bom", utf16be(sample)],
  ];
  for (const [name, bytes] of cases) {
    const out = decodePlan(bytes);
    assert.ok(
      out.startsWith("<?xml"),
      `${name}: starts with ${JSON.stringify(out.slice(0, 12))}`,
    );
    assert.ok(!out.includes("\0"), `${name}: still contains NUL bytes`);
    assert.equal(
      digestPlan(out).sql,
      "SELECT 1",
      `${name}: digest after decode`,
    );
  }
});

test("a parse failure says why instead of blaming the export", async () => {
  const { PlanError } = await import("../lib/digest.ts");
  const e: unknown = (() => {
    try {
      digestPlan("<ShowPlanXML><Unclosed></ShowPlanXML>");
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(e instanceof PlanError);
  assert.ok(e.message.length > 40, `message too thin: ${e.message}`);
  assert.notEqual(
    e.message,
    "That XML will not parse — re-export the actual execution plan.",
  );
});

test("a deeply nested real plan parses (spaghettified plans are thousands of tags deep)", async () => {
  // fast-xml-parser defaults to maxNestedTags: 128. A 2.7 MB production plan measured 2729 deep and died
  // with "Maximum nested tags exceeded", which read like a corrupt export.
  const depth = 3000;
  const open = "<ShowPlanXML><RelOp NodeId='1'>".repeat(1);
  const inner =
    "<RelOp NodeId='n'>".repeat(depth) +
    "<ColumnReference Column='[dbo].[t].[c]'/>" +
    "</RelOp>".repeat(depth);
  let err: unknown = null;
  let out: any = null;
  try {
    out = digestPlan(open + inner + "</RelOp></ShowPlanXML>");
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, String((err as Error)?.message));
  assert.equal(out.topOperators.length, 12, "digest should rank, not truncate");
});

// ---- real-plan shapes measured on a 2.7 MB production plan (plan-cxpaket.sqlplan) ----
test("table names come off the Object child, not the scan element", async () => {
  // ShowPlan carries Database/Schema/Table on <Object>, so reading them off <IndexScan> returned nothing:
  // a 51-object production plan digested to zero tables and the model never saw a table name.
  const xml = `<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1">
    <QueryPlan><RelOp PhysicalOp="Index Scan"><IndexScan>
      <Object Database="[crm]" Schema="[dbo]" Table="[Orders]" Index="[IX_Orders_CustomerId]" />
    </IndexScan></RelOp>
    <RelOp PhysicalOp="Table Scan"><TableScan>
      <Object Database="[crm]" Schema="[dbo]" Table="[Customers]" />
    </TableScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
  assert.deepEqual(digestPlan(xml).tables, [
    "crm.dbo.Orders",
    "crm.dbo.Customers",
  ]);
});

test("numeric character references in StatementText become the characters", () => {
  // SSMS writes the plan text with &#xD;&#xA; line breaks: 90 of them in the production plan, so the
  // analyst model was handed entity noise instead of SQL.
  const xml = `<ShowPlanXML><BatchSequence><Batch><Statements>
    <StmtSimple StatementText="SELECT a &#xD;&#xA;FROM dbo.T WHERE x &gt; 1 &amp; y = 2"/>
  </Statements></Batch></BatchSequence></ShowPlanXML>`;
  const sql = digestPlan(xml).sql;
  assert.match(sql, /FROM dbo\.T/);
  assert.match(sql, /\n/);
  assert.ok(!sql.includes("&#x"), sql);
  assert.match(sql, /x > 1 & y = 2/);
});
