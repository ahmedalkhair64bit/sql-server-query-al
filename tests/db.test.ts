import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/qai-`);
const q = await import("../lib/db.ts");

test("user, settings upsert, analysis lifecycle", () => {
  const id = q.createUser("a@b.c", "salt:hash");
  assert.equal(q.userByEmail("a@b.c")?.id, id);
  assert.equal(q.userByEmail("nope@x.y"), null);
  assert.equal(q.userEmail(id)?.email, "a@b.c");

  const s = { analyst_base_url: "http://x/v1", analyst_key: "k1", analyst_model: "m",
              analyst_extra: "{}", jev_key: "j", jev_model: "jev-latest", onboarded: 1 };
  q.saveSettings(id, s);
  q.saveSettings(id, { ...s, analyst_key: "k2" });
  assert.equal(q.getSettings(id)?.analyst_key, "k2", "upsert not insert");

  const aid = q.newAnalysis(id, "Orders scan", "<xml/>");
  q.patchAnalysis(aid, { status: "done", oul: "root = Report([])", digest: "{}" });
  assert.equal(q.listAnalyses(id)[0].title, "Orders scan");
  assert.equal(q.getAnalysis(aid, id)?.status, "done");
  q.renameAnalysis(aid, id, "Renamed");
  assert.equal(q.getAnalysis(aid, id)?.title, "Renamed");
  q.deleteAnalysis(aid, id);
  assert.equal(q.getAnalysis(aid, id), null);
});

test("session resolves only while unexpired", () => {
  const id = q.createUser("s@b.c", "h");
  q.putSession("tok", id, Date.now() + 1000);
  assert.equal(q.sessionUserId("tok"), id);
  q.putSession("old", id, Date.now() - 1);
  assert.equal(q.sessionUserId("old"), null);
  q.dropSession("tok");
  assert.equal(q.sessionUserId("tok"), null);
});

test("rows are plain objects so they can cross the server -> client boundary", () => {
  const id = q.createUser("plain@x.y", "h");
  const aid = q.newAnalysis(id, "t", "<xml/>");
  const row = q.listAnalyses(id)[0];
  assert.equal(Object.getPrototypeOf(row), Object.prototype, "listAnalyses returned a null-prototype row");
  assert.equal(Object.getPrototypeOf(q.getAnalysis(aid, id)!), Object.prototype, "getAnalysis");
  q.saveSettings(id, { analyst_base_url: "b", analyst_key: "k", analyst_model: "m", analyst_extra: "{}",
    jev_key: "j", jev_model: "v", onboarded: 1 });
  assert.equal(Object.getPrototypeOf(q.getSettings(id)!), Object.prototype, "getSettings");
});
