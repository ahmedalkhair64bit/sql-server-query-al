import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.APP_SECRET ??= "reuse-test-secret-value";
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/qai-reuse-`);
const db = await import("../lib/db.ts");
const s = await import("../lib/settings.ts");
const { runKey } = await import("../lib/server/jobs.ts");
const { parsePlanText, recommendStatement } =
  await import("../lib/plan-parser.mjs");

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const models = {
  analyst_base_url: "https://api.example.com/v1",
  analyst_key: "sk-test-1234",
  analyst_model: "model-a",
  analyst_extra: "{}",
  jev_key: "ts-5678",
  jev_model: "jev-latest",
};
const digest = () =>
  recommendStatement(
    parsePlanText(readFileSync("fixtures/eval/key-lookup.sqlplan", "utf8")),
  );

test("the same plan, note and models give the same key; any change gives a new one", () => {
  const u = db.createUser("reuse@x.y", "h");
  assert.ok(s.saveModelSettings(u, form(models)).ok);
  const k = runKey(u, digest(), "slow at month end");
  assert.equal(runKey(u, digest(), "slow at month end"), k, "same request");
  assert.equal(
    runKey(u, digest(), "  slow at month end  "),
    k,
    "surrounding spaces in the note do not matter",
  );
  assert.notEqual(runKey(u, digest(), "no schema changes"), k, "new note");
  const other = digest();
  other.topOperators[0].cost += 1;
  assert.notEqual(runKey(u, other, "slow at month end"), k, "new evidence");
  assert.ok(
    s.saveModelSettings(u, form({ ...models, analyst_model: "model-b" })).ok,
  );
  assert.notEqual(
    runKey(u, digest(), "slow at month end"),
    k,
    "a different analyst model is a different request",
  );
});

test("only a finished analysis with a decision is reused, newest first", () => {
  const u = db.createUser("reuse2@x.y", "h");
  const key = "k".repeat(64);
  const a = db.newAnalysis(u, "first", "");
  db.patchAnalysis(a, { status: "failed", run_key: key });
  assert.equal(
    db.findReusable(u, key),
    null,
    "a failed run is not reused",
  );
  db.patchAnalysis(a, { status: "done", verdict: '{"status":"selected"}' });
  assert.equal(db.findReusable(u, key)?.id, a);
  const other = db.createUser("reuse3@x.y", "h");
  assert.equal(db.findReusable(other, key), null, "never another user's");
});
