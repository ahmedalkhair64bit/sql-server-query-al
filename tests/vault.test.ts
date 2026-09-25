import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.APP_SECRET = "unit-test-secret-value";
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/qai-vault-`);
const { seal, open, mask } = await import("../lib/vault.ts");
const db = await import("../lib/db.ts");
const { saveModelSettings, analystConfig, settingsView, jevKey } = await import("../lib/settings.ts");

test("seal/open round-trips; junk and tamper yield empty", () => {
  assert.equal(open(seal("sk-abc123")), "sk-abc123");
  assert.equal(open("deadbeef.00.zzz"), "");
  assert.equal(open(""), "");
  assert.equal(mask("sk-abcdefgh1234"), "••••1234");
  assert.equal(mask(""), "");
});

test("blank secret keeps the stored key", () => {
  const u = db.createUser("v@x.y", "h");
  const fd = (o: Record<string, string>) => { const f = new FormData();
    Object.entries(o).forEach(([k, v]) => f.set(k, v)); return f; };
  saveModelSettings(u, fd({ analyst_base_url: "https://api/x/v1/", analyst_key: "sk-1111", analyst_model: "gpt",
    analyst_extra: '{"temperature":0.2}', jev_key: "ts-1", jev_model: "jev-latest" }));
  assert.equal(analystConfig(u)?.apiKey, "sk-1111");

  // Bad JSON is refused with a reason instead of silently becoming {}.
  const bad = saveModelSettings(u, fd({ analyst_base_url: "https://api/y/v1", analyst_key: "", analyst_model: "gpt",
    analyst_extra: "not json", jev_key: "", jev_model: "" }));
  assert.equal(bad.ok, false);
  assert.equal(analystConfig(u)?.baseUrl, "https://api/x/v1", "a refused save changes nothing");
  saveModelSettings(u, fd({ analyst_base_url: "https://api/y/v1", analyst_key: "", analyst_model: "gpt",
    analyst_extra: "{}", jev_key: "", jev_model: "" }));
  const c = analystConfig(u)!;
  assert.equal(c.baseUrl, "https://api/y/v1", "trailing slash trimmed");
  assert.equal(c.apiKey, "sk-1111", "blank must not wipe the key");
  assert.deepEqual(c.extra, {});
  assert.equal(jevKey(u), "ts-1");
  assert.equal(settingsView(u).has_analyst, true);
  assert.equal(settingsView(u).analyst_key_masked, "••••1111");
  assert.equal((settingsView(u) as Record<string, unknown>).analyst_key, undefined, "no raw key to the client");
});

test("saveSettings never blanks a stored secret, whoever calls it", () => {
  const u = db.createUser("k@x.y", "h");
  const base = { analyst_base_url: "b", analyst_key: "sealed", analyst_model: "m", analyst_extra: "{}",
                 jev_key: "jevsealed", jev_model: "j", onboarded: 1 };
  db.saveSettings(u, base);
  db.saveSettings(u, { ...base, analyst_key: "", jev_key: "" });
  assert.equal(db.getSettings(u)?.analyst_key, "sealed");
  assert.equal(db.getSettings(u)?.jev_key, "jevsealed");
  assert.equal(db.getSettings(u)?.analyst_base_url, "b", "non-secret fields still update");
});
