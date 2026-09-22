import { randomBytes, scryptSync, createHash, timingSafeEqual } from "node:crypto";
import { createUser, userByEmail, userEmail, putSession, sessionUserId, dropSession, getSettings, db } from "./db.ts";

export const SESSION_COOKIE = "qai_s";
export const SESSION_DAYS = 30;
export const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
export const passwordOk = (p: string) => p.length >= 10;   // trust boundary: signup + password change only

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const a = scryptSync(pw, Buffer.from(salt, "hex"), 64);
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function signUpNewUser(email: string, password: string): { ok: true; id: string } | { ok: false; error: string } {
  const e = email.trim().toLowerCase();
  if (!emailOk(e)) return { ok: false, error: "Enter a valid email address." };
  if (!passwordOk(password)) return { ok: false, error: "Use at least 10 characters." };
  if (userByEmail(e)) return { ok: false, error: "That email already has an account." };
  // ponytail: no rate limiting — single-container tool. Add a token bucket before exposing this to a network.
  return { ok: true, id: createUser(e, hashPassword(password)) };
}

// next/headers is imported lazily: `node --test` loads this module to test the crypto above, and the
// request-scoped binding must not be touched at import time.
const jar = async () => (await import("next/headers")).cookies();
const fwdProto = async () => ((await (await import("next/headers")).headers())).get("x-forwarded-proto") ?? "";

export function changeEmail(userId: string, email: string): { ok: true } | { ok: false; error: string } {
  const e = email.trim().toLowerCase();
  if (!emailOk(e)) return { ok: false, error: "Enter a valid email address." };
  const taken = userByEmail(e);
  if (taken && taken.id !== userId) return { ok: false, error: "That email already has an account." };
  // users.email is UNIQUE: without this check a collision is a 500 inside the settings form.
  if (!taken) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(e, userId);
  return { ok: true };
}

export async function startSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  putSession(hashToken(token), userId, Date.now() + SESSION_DAYS * 864e5);
  const secure = process.env.COOKIE_SECURE === "1" || (await fwdProto()).includes("https");
  (await jar()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure,
    path: "/", maxAge: SESSION_DAYS * 86400,
    // NODE_ENV is the wrong signal here. A production build served over plain http://localhost would set
    // Secure, Safari then refuses to store the cookie at all, and every page after signup looks signed-out.
    // (Chromium accepts Secure on localhost, which is why a chromium-only suite could never see it.)
    // Only a TLS proxy reports https; COOKIE_SECURE=1 forces it on for a direct https deploy.
  });
}
export async function endSession() {
  const store = await jar();
  const t = store.get(SESSION_COOKIE)?.value;
  if (t) dropSession(hashToken(t));
  store.delete(SESSION_COOKIE);
}
export async function sessionUser(): Promise<{ id: string; email: string } | null> {
  const t = (await jar()).get(SESSION_COOKIE)?.value;
  if (!t) return null;
  const id = sessionUserId(hashToken(t));
  if (!id) return null;
  const row = userEmail(id);
  return row ? { id, email: row.email } : null;
}
export async function requireUser(): Promise<{ id: string; email: string }> {
  const { redirect } = await import("next/navigation");   // lazy for the same reason as jar()
  const u = await sessionUser();
  if (!u) { redirect("/login"); throw new Error("redirecting to /login"); }  // redirect throws; this only satisfies the type
  return u;
}
export const needsOnboarding = (userId: string) => getSettings(userId)?.onboarded !== 1;
