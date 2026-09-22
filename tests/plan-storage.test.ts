import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "qai-plan-test-"));
const {
  ingestPlan,
  ownedPlan,
  listStatements,
  statementDigest,
  attachPlan,
  releasePlan,
} = await import("../lib/server/plans.ts");
const { newAnalysis, db } = await import("../lib/db.ts");
const bytes = (s: string) => new Blob([s]).stream();
const xml =
  '<ShowPlanXML><StmtSimple StatementText="SELECT 1" StatementSubTreeCost="2"/><StmtSimple StatementText="SELECT 2" StatementSubTreeCost="9"/></ShowPlanXML>';
test("disk-backed index, ownership and shared file lifecycle", async () => {
  const p = await ingestPlan(bytes(xml), "owner", "test.sqlplan");
  assert.equal(p.count, 2);
  assert.equal(p.recommended, "s2");
  assert.ok(ownedPlan(p.id, "owner"));
  assert.equal(ownedPlan(p.id, "other"), null);
  assert.equal((await statementDigest(p.id, "s1")).sql, "SELECT 1");
  assert.equal((await listStatements(p.id)).length, 2);
  const a = newAnalysis("owner", "first", ""),
    b = newAnalysis("owner", "second", "");
  attachPlan(a, p.id, "s1");
  attachPlan(b, p.id, "s2");
  await releasePlan(a);
  assert.ok(existsSync(join(process.env.DATA_DIR!, "plans", p.id)));
  await releasePlan(b);
  assert.equal(ownedPlan(p.id, "owner"), null);
  assert.ok(!existsSync(join(process.env.DATA_DIR!, "plans", p.id)));
  assert.throws(() => attachPlan(a, p.id, "s1"), /removed/);
});
test("cancelled and malformed uploads never register a plan", async () => {
  const before = (
    db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }
  ).n;
  await assert.rejects(
    () => ingestPlan(bytes("<ShowPlanXML><bad>"), "owner", "bad.xml"),
    /stopped parsing/,
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => ingestPlan(bytes(xml), "owner", "cancel.xml", ac.signal),
    /cancelled/,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n,
    before,
  );
});
test("unknown statement fails instead of selecting a different statement", async () => {
  const p = await ingestPlan(bytes(xml), "owner", "test.xml");
  await assert.rejects(() => statementDigest(p.id, "s999"), /not found/);
});
