import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/qai-auth-`);
const { hashPassword, verifyPassword, hashToken } = await import("../lib/auth.ts");

test("password hash round-trips and rejects", () => {
  const h = hashPassword("correct horse battery staple");
  assert.ok(h.includes(":"), "salt:hash shape");
  assert.ok(verifyPassword("correct horse battery staple", h));
  assert.ok(!verifyPassword("wrong", h));
});
test("malformed stored hash never verifies", () => {
  for (const bad of ["", "nosep", "a:", ":b", "zz:zz"]) assert.ok(!verifyPassword("x", bad));
});
test("token hash is stable, 64 hex", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.match(hashToken("abc"), /^[0-9a-f]{64}$/);
});
test("changeEmail refuses an address another account already has", async () => {
  const { signUpNewUser, changeEmail } = await import("../lib/auth.ts");
  const db = await import("../lib/db.ts");
  const a = signUpNewUser("first@x.test", "0123456789ab");
  const b = signUpNewUser("second@x.test", "0123456789ab");
  assert.ok(a.ok && b.ok);
  assert.deepEqual(changeEmail(b.id, "first@x.test"), { ok: false, error: "That email already has an account." });
  assert.deepEqual(changeEmail(b.id, "not an email"), { ok: false, error: "Enter a valid email address." });
  assert.deepEqual(changeEmail(b.id, " FIRST@X.TEST "), { ok: false, error: "That email already has an account." });
  assert.equal(changeEmail(a.id, "first@x.test").ok, true, "own address is not a conflict");
  assert.equal(changeEmail(b.id, "fresh@x.test").ok, true);
  assert.equal(db.userByEmail("fresh@x.test")!.id, b.id, "stored lower-cased");
});
