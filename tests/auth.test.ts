import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/qai-auth-`);
const { hashPassword, verifyPassword, hashToken, signUpNewUser, signupOpen } =
  await import("../lib/auth.ts");
const { retryAfter, recordFailure, clearFailures } =
  await import("../lib/throttle.ts");
const { isBlockedAddress, staticUrlProblem, modelUrlProblem } =
  await import("../lib/egress.ts");

test("the first account may sign up; later ones only when ALLOW_SIGNUP=1", () => {
  delete process.env.ALLOW_SIGNUP;
  assert.ok(signupOpen());
  assert.ok(signUpNewUser("owner@qai.test", "0123456789").ok);
  assert.ok(!signupOpen());
  const second = signUpNewUser("other@qai.test", "0123456789");
  assert.ok(!second.ok && /closed/.test(second.error));
  process.env.ALLOW_SIGNUP = "1";
  assert.ok(signUpNewUser("other@qai.test", "0123456789").ok);
  delete process.env.ALLOW_SIGNUP;
});

test("password hash round-trips and rejects", () => {
  const h = hashPassword("correct horse battery staple");
  assert.ok(h.includes(":"), "salt:hash shape");
  assert.ok(verifyPassword("correct horse battery staple", h));
  assert.ok(!verifyPassword("wrong", h));
});
test("malformed stored hash never verifies", () => {
  for (const bad of ["", "nosep", "a:", ":b", "zz:zz"])
    assert.ok(!verifyPassword("x", bad));
});
test("token hash is stable, 64 hex", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.match(hashToken("abc"), /^[0-9a-f]{64}$/);
});
test("changeEmail refuses an address another account already has", async () => {
  const { signUpNewUser, changeEmail } = await import("../lib/auth.ts");
  const db = await import("../lib/db.ts");
  process.env.ALLOW_SIGNUP = "1";
  const a = signUpNewUser("first@x.test", "0123456789ab");
  const b = signUpNewUser("second@x.test", "0123456789ab");
  delete process.env.ALLOW_SIGNUP;
  assert.ok(a.ok && b.ok);
  assert.deepEqual(changeEmail(b.id, "first@x.test"), {
    ok: false,
    error: "That email already has an account.",
  });
  assert.deepEqual(changeEmail(b.id, "not an email"), {
    ok: false,
    error: "Enter a valid email address.",
  });
  assert.deepEqual(changeEmail(b.id, " FIRST@X.TEST "), {
    ok: false,
    error: "That email already has an account.",
  });
  assert.equal(
    changeEmail(a.id, "first@x.test").ok,
    true,
    "own address is not a conflict",
  );
  assert.equal(changeEmail(b.id, "fresh@x.test").ok, true);
  assert.equal(db.userByEmail("fresh@x.test")!.id, b.id, "stored lower-cased");
});

test("five failed sign-ins lock that email for 15 minutes; success clears it", () => {
  const t = 1_000_000;
  for (let i = 0; i < 4; i++) recordFailure("a@x.io", "1.2.3.4", t);
  assert.equal(retryAfter("a@x.io", "1.2.3.4", t), 0);
  recordFailure("a@x.io", "1.2.3.4", t);
  assert.equal(
    retryAfter("a@x.io", "9.9.9.9", t + 1000),
    899,
    "locked from any address",
  );
  assert.equal(
    retryAfter("b@x.io", "5.5.5.5", t),
    0,
    "other emails unaffected",
  );
  assert.equal(
    retryAfter("a@x.io", "1.2.3.4", t + 15 * 60_000),
    0,
    "window expires",
  );
  clearFailures("a@x.io");
  assert.equal(retryAfter("a@x.io", "9.9.9.9", t), 0);
  for (let i = 0; i < 30; i++) recordFailure(`spray${i}@x.io`, "6.6.6.6", t);
  assert.ok(
    retryAfter("new@x.io", "6.6.6.6", t) > 0,
    "one address spraying many emails",
  );
});

test("model URLs may be local or private, never link-local or cloud metadata", async () => {
  for (const ip of [
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "fe80::1",
    "0.0.0.0",
    "100.100.100.200",
  ])
    assert.ok(isBlockedAddress(ip), ip);
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "::1", "8.8.8.8"])
    assert.ok(!isBlockedAddress(ip), ip);
  for (const url of [
    "http://169.254.169.254/computeMetadata/v1",
    "http://metadata.google.internal/v1",
    "http://[fe80::1]:8080/v1",
    "file:///etc/passwd",
  ])
    assert.ok(staticUrlProblem(url), url);
  for (const url of [
    "http://localhost:11434/v1",
    "http://10.1.2.3:8000/v1",
    "https://api.deepseek.com/v1",
  ])
    assert.equal(staticUrlProblem(url), null, url);
  assert.ok(await modelUrlProblem("http://169.254.169.254/latest/meta-data"));
  assert.equal(await modelUrlProblem("http://127.0.0.1:18889/v1"), null);
});
