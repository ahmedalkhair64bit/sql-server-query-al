"use server";
import { releasePlan } from "./server/plans";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  userByEmail,
  getSettings,
  renameAnalysis,
  deleteAnalysis,
  db,
} from "@/lib/db";
import {
  signUpNewUser,
  verifyPassword,
  startSession,
  endSession,
  requireUser,
  changeEmail,
  emailOk,
  hashPassword,
} from "@/lib/auth";
import { saveSettingsForm } from "@/lib/settings";

export async function signUp(_: unknown, fd: FormData) {
  const r = signUpNewUser(
    String(fd.get("email") ?? ""),
    String(fd.get("password") ?? ""),
  );
  if (!r.ok) return r;
  await startSession(r.id);
  redirect("/setup");
}
export async function signIn(_: unknown, fd: FormData) {
  const e = String(fd.get("email") ?? "")
    .trim()
    .toLowerCase();
  const u = emailOk(e) ? userByEmail(e) : null;
  if (!u || !verifyPassword(String(fd.get("password") ?? ""), u.pass))
    return { ok: false, error: "Email or password is wrong." };
  await startSession(u.id);
  redirect(getSettings(u.id)?.onboarded === 1 ? "/app" : "/setup");
}
export async function signOut() {
  await endSession();
  redirect("/login");
}

export async function rename(_: unknown, fd: FormData) {
  const u = await requireUser();
  const id = String(fd.get("id") ?? "");
  const title = String(fd.get("title") ?? "")
    .trim()
    .slice(0, 120);
  if (id && title) renameAnalysis(id, u.id, title);
  revalidatePath("/app");
}
export async function remove(_: unknown, fd: FormData) {
  const u = await requireUser();
  const id = String(fd.get("id") ?? "");
  const owned = db
    .prepare("SELECT id FROM analyses WHERE id=? AND user_id=?")
    .get(id, u.id);
  if (owned) {
    deleteAnalysis(id, u.id);
    await releasePlan(id);
  }
  revalidatePath("/app");
}

export async function saveSettingsAction(_: unknown, fd: FormData) {
  const u = await requireUser();
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (password && password.length < 10)
    return { ok: false, error: "Use at least 10 characters." };
  saveSettingsForm(u.id, fd);
  // The wizard sends `after`: a configured user must land on the readiness screen, and the setup page
  // forwards configured users away from steps 1-2, so "Saved." would never be seen there.
  if (String(fd.get("after") ?? "").startsWith("/setup"))
    redirect("/setup?step=3");
  if (password)
    db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(
      hashPassword(password),
      u.id,
    );
  if (email) {
    const r = changeEmail(u.id, email);
    if (!r.ok) return r;
  }
  revalidatePath("/settings");
  return { ok: true };
}
