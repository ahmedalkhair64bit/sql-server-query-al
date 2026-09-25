import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePlanText,
  PlanError,
  createPlanParser,
} from "../lib/plan-parser.mjs";
import { decodeBytes, createDecoder } from "../lib/plan-decoder.mjs";
import { digestForModel } from "../lib/digest.ts";
import { readFileSync } from "node:fs";
const wrap = (inner: string) =>
  `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements>${inner}</Statements></Batch></BatchSequence></ShowPlanXML>`;
const stmt = (id: number, inner: string, cost = 1) =>
  `<StmtSimple StatementId="${id}" StatementText="SELECT ${id}" StatementSubTreeCost="${cost}"><QueryPlan>${inner}</QueryPlan></StmtSimple>`;
test("batch statements and nested operators retain their own evidence", () => {
  const xml = wrap(
    stmt(
      1,
      `<RelOp NodeId="0" PhysicalOp="Nested Loops" EstimateRows="0"><RunTimeInformation><RunTimeCountersPerThread ActualRows="3" ActualExecutions="1"/></RunTimeInformation><RelOp NodeId="1" PhysicalOp="Index Scan" EstimateRows="2" Parallel="true"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="4" ActualExecutions="1"/><RunTimeCountersPerThread Thread="1" ActualRows="5" ActualExecutions="1"/></RunTimeInformation></RelOp></RelOp>`,
    ) + stmt(2, `<RelOp NodeId="0" PhysicalOp="Sort" EstimateRows="3"/>`, 22),
  );
  const [a, b] = parsePlanText(xml);
  assert.equal(
    a.topOperators.find((o: { id: string }) => o.id === "0")?.actualRows,
    3,
  );
  assert.equal(
    a.topOperators.find((o: { id: string }) => o.id === "1")?.actualRows,
    9,
  );
  assert.equal(
    a.topOperators.find((o: { id: string }) => o.id === "1")?.execs,
    2,
  );
  assert.equal(b.topOperators[0].actualRows, null);
  assert.equal(b.subtreeCost, 22);
  assert.equal(a.rowGuessErrors[0].ratio, null);
  assert.equal(a.rowGuessErrors[0].zeroMismatch, true);
  assert.notEqual(
    digestForModel(a).evidence[0].id,
    digestForModel(b).evidence[0].id,
  );
});
test("nested statements do not inherit child statement operators", () => {
  const parsed = parsePlanText(
    wrap(
      `<StmtCond StatementText="IF 1=1"><Statements>${stmt(1, '<RelOp NodeId="0" PhysicalOp="Scan"/>')}</Statements></StmtCond>`,
    ),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed.find((d) => d.sql === "IF 1=1")?.operatorCount, 0);
});
test("included columns, waits, attributes and future statements surface", () => {
  const [d] = parsePlanText(
    wrap(
      `<StmtFuture StatementText="SELECT 1" StatementOptmEarlyAbortReason="TimeOut"><QueryPlan NonParallelPlanReason="MaxDOPSetToOne"><WaitStats><Wait WaitType="CXPACKET" WaitTimeMs="123"/></WaitStats><MissingIndexes><MissingIndexGroup Impact="70"><MissingIndex Schema="[dbo]" Table="[Orders]"><ColumnGroup Usage="INCLUDE"><Column Name="[Total]"/></ColumnGroup></MissingIndex></MissingIndexGroup></MissingIndexes></QueryPlan></StmtFuture>`,
    ),
  );
  assert.equal(d.earlyAbort, "TimeOut");
  assert.equal(d.nonParallelReason, "MaxDOPSetToOne");
  assert.equal(d.missingIndexes[0].included[0], "Total");
  assert.deepEqual(d.waits, [{ type: "CXPACKET", ms: 123 }]);
});
test("DTD, invalid XML and non-plan documents are rejected", () => {
  for (const xml of [
    '<!DOCTYPE ShowPlanXML [<!ENTITY e SYSTEM "file:///etc/passwd">]><ShowPlanXML>&e;</ShowPlanXML>',
    "<ShowPlanXML><StmtSimple></ShowPlanXML>",
    "<x><ShowPlanXML/></x>",
  ])
    assert.throws(() => parsePlanText(xml), PlanError);
});
test("UTF-32 both endian forms decode incrementally and reject invalid scalars", () => {
  const xml = wrap(stmt(1, ""));
  for (const le of [true, false]) {
    const chars = [0xfeff, ...Array.from(xml, (c) => c.codePointAt(0)!)];
    const bytes = Buffer.alloc(chars.length * 4);
    chars.forEach((cp, i) =>
      le ? bytes.writeUInt32LE(cp, i * 4) : bytes.writeUInt32BE(cp, i * 4),
    );
    assert.equal(decodeBytes(bytes), xml);
    const decoder = createDecoder(le ? "utf-32le" : "utf-32be");
    let out = "";
    for (let i = 0; i < bytes.length; i += 7)
      out += decoder.write(bytes.subarray(i, i + 7));
    out += decoder.end();
    assert.equal(out, xml);
  }
  assert.throws(() =>
    decodeBytes(Uint8Array.from([255, 254, 0, 0, 0, 0, 17, 0])),
  );
});
test("streamed tokens and Unicode survive every chunk boundary", () => {
  const xml = wrap('<StmtSimple StatementText="SELECT &#x1F600; &amp; café"/>');
  const out: ReturnType<typeof parsePlanText> = [];
  const parser = createPlanParser(
    (d: ReturnType<typeof parsePlanText>[number]) => out.push(d),
  );
  for (const char of xml) parser.write(char);
  parser.end();
  assert.equal(out[0].sql, "SELECT 😀 & café");
});
test("large SQL has explicit omissions and cannot be rewritten", () => {
  const [d] = parsePlanText(
    wrap(`<StmtSimple StatementText="${"SELECT ".repeat(10000)}"/>`),
  );
  assert.ok(d.sqlTruncated);
  assert.ok(d.sql.length <= 64000);
  assert.equal(digestForModel(d).sql_truncated, true);
  assert.ok(digestForModel(d).coverage.length);
});

// ---- a nested actual plan shaped like an SSMS export: Sort > Nested Loops > (Index Seek, Key Lookup x50,000) ----
const nested = () =>
  parsePlanText(readFileSync("fixtures/nested-actual.sqlplan", "utf8"))[0];
test("operator cost is the operator's own, not its subtree", () => {
  const d = nested();
  const byId = Object.fromEntries(
    d.topOperators.map((o: { id: string }) => [o.id, o]),
  );
  // Subtree costs are 12.3 / 12.28 / 0.0032 / 12.27: the Sort and Nested Loops add almost nothing.
  assert.equal(byId["0"].cost, 0.02);
  assert.equal(byId["1"].cost, 0.0068);
  assert.equal(byId["3"].cost, 12.27);
  assert.equal(byId["3"].subtreeCost, 12.27);
});
test("an actual plan ranks operators by their own measured time", () => {
  const d = nested();
  assert.equal(d.topOperators[0].op, "Key Lookup");
  assert.equal(d.topOperators[0].actualElapsedMs, 3900);
  assert.equal(d.topOperators[0].logicalReads, 160000);
  // Row mode reports time including children: the Sort's own time is 4100 - 4050.
  const sort = d.topOperators.find((o: { id: string }) => o.id === "0");
  assert.equal(sort.actualElapsedMs, 50);
});
test("row estimates compare per execution, so nested-loop inner sides are not false misses", () => {
  const d = nested();
  const ids = d.rowGuessErrors.map((r: { id: string }) => r.id);
  // Key Lookup: estimate 1 per execution, 50,000 rows over 50,000 executions — accurate.
  assert.ok(!ids.includes("3"), JSON.stringify(d.rowGuessErrors));
  // The seek really expected 1 row and read 50,000: that is the genuine miss.
  const seek = d.rowGuessErrors.find((r: { id: string }) => r.id === "2");
  assert.equal(seek.est, 1);
  assert.equal(seek.actual, 50000);
  assert.equal(seek.ratio, 50000);
});
test("runtime, memory, parameter, statistics and index evidence is extracted", () => {
  const d = nested();
  assert.deepEqual(d.queryTime, { cpuMs: 3900, elapsedMs: 4100 });
  assert.equal(d.memoryGrant.grantedKb, 900000);
  assert.equal(d.memoryGrant.maxUsedKb, 2048);
  assert.deepEqual(d.parameters, [
    { name: "@c", compiled: "(42)", runtime: "(7)", differs: true },
  ]);
  assert.equal(d.statistics[0].modifications, 880000);
  assert.equal(d.statistics[0].samplingPercent, 0.4);
  assert.deepEqual(
    d.indexes.map((i: { index: string }) => i.index),
    ["IX_Orders_Customer", "PK_Orders"],
  );
  assert.equal(d.ceVersion, 160);
  assert.equal(d.queryHash, "0xAA");
  const seek = d.topOperators.find((o: { id: string }) => o.id === "2");
  assert.deepEqual(seek.seekColumns, ["CustomerId"]);
  assert.equal(seek.object, "db.Sales.Orders.IX_Orders_Customer");
  const lookup = d.topOperators.find((o: { id: string }) => o.id === "3");
  assert.equal(lookup.lookup, true);
  assert.match(lookup.predicate, /\[Total\]>\(500\)/);
});
test("operator warnings name their operator; statement warnings do not", () => {
  const d = nested();
  assert.ok(
    d.warnings.some((w: string) =>
      w.startsWith("PlanAffectingConvert ConvertIssue=Seek Plan"),
    ),
    JSON.stringify(d.warnings),
  );
  assert.ok(
    d.warnings.includes("ColumnsWithNoStatistics column=db.Sales.Orders.Total"),
    JSON.stringify(d.warnings),
  );
  assert.ok(
    d.warnings.includes("Node 3 Key Lookup: ColumnsWithNoStatistics"),
    JSON.stringify(d.warnings),
  );
});
test("each fact is stored and sent once", () => {
  const d = nested();
  assert.equal(d.evidence, undefined, "evidence is derived, not stored");
  const m = digestForModel(d) as Record<string, unknown> & {
    evidence: { id: string; kind: string }[];
  };
  for (const k of [
    "topOperators",
    "rowGuessErrors",
    "missingIndexes",
    "warnings",
  ])
    assert.equal(m[k], undefined, `${k} duplicated beside evidence`);
  const kinds = new Set(m.evidence.map((e) => e.kind));
  for (const k of [
    "statement",
    "query_time",
    "memory_grant",
    "operator",
    "parameter",
    "missing_index",
    "warning",
    "indexes_used",
    "statistics",
  ])
    assert.ok(kinds.has(k), `missing evidence kind ${k}`);
  assert.equal(new Set(m.evidence.map((e) => e.id)).size, m.evidence.length);
  // The Index Seek's estimate miss rides on its operator evidence instead of a second row_error entry.
  assert.ok(!m.evidence.some((e) => e.kind === "row_error"));
});
test("a digest stored by the previous version still yields the same evidence IDs", () => {
  const legacy = {
    version: 2,
    statementId: "s1",
    sql: "SELECT 1",
    bytes: 1,
    subtreeCost: 1,
    parallel: false,
    nonParallelReason: null,
    earlyAbort: null,
    tables: [],
    topOperators: [
      {
        id: "4",
        op: "Sort",
        cost: 1,
        estRows: 1,
        actualRows: null,
        execs: null,
        parallel: false,
      },
    ],
    rowGuessErrors: [],
    missingIndexes: [
      { table: "t", equality: ["a"], inequality: [], included: [], impact: 50 },
    ],
    warnings: ["NoJoinPredicate"],
    waits: [],
    evidence: [
      { id: "s1:statement" },
      { id: "s1:operator:4" },
      { id: "s1:index:0" },
      { id: "s1:warning:0" },
    ],
  };
  const ids = digestForModel(legacy as never).evidence.map((e) => e.id);
  for (const e of legacy.evidence) assert.ok(ids.includes(e.id), e.id);
});

test("deep nesting parses in linear time (namespace processing made it quadratic)", () => {
  const relop = (i: number) =>
    `<RelOp NodeId="${i}" PhysicalOp="Nested Loops" EstimateRows="1" EstimatedTotalSubtreeCost="1"><NestedLoops>`;
  const depth = 9000; // 18,000 tags: RelOp plus NestedLoops, inside the 20,000-tag limit
  const xml = wrap(
    `<StmtSimple StatementText="q"><QueryPlan>${Array.from({ length: depth }, (_, i) => relop(i)).join("")}${"</NestedLoops></RelOp>".repeat(depth)}</QueryPlan></StmtSimple>`,
  );
  const t = performance.now();
  const [d] = parsePlanText(xml);
  assert.equal(d.operatorCount, depth);
  assert.ok(performance.now() - t < 3000, `took ${Math.round(performance.now() - t)} ms`);
});
test("namespace prefixes on elements and attributes are ignored", () => {
  const [d] = parsePlanText(
    `<sp:ShowPlanXML xmlns:sp="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><sp:BatchSequence><sp:Batch><sp:Statements><sp:StmtSimple sp:StatementText="SELECT 1" StatementSubTreeCost="2"><sp:QueryPlan><sp:RelOp NodeId="0" PhysicalOp="Sort" EstimateRows="1" EstimatedTotalSubtreeCost="2"/></sp:QueryPlan></sp:StmtSimple></sp:Statements></sp:Batch></sp:BatchSequence></sp:ShowPlanXML>`,
  );
  assert.equal(d.sql, "SELECT 1");
  assert.equal(d.subtreeCost, 2);
  assert.equal(d.topOperators[0].op, "Sort");
});
