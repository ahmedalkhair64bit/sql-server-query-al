import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePlanText,
  PlanError,
  createPlanParser,
} from "../lib/plan-parser.mjs";
import { decodeBytes, createDecoder } from "../lib/plan-decoder.mjs";
import { digestForModel } from "../lib/digest.ts";
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
  assert.notEqual(a.evidence[0].id, b.evidence[0].id);
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
