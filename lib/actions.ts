"use server";
import { releasePlan } from "./server/plans";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  userByEmail,
  getSettings,
  renameAnalysis,
  deleteAnalysis,
  analysisIdsFor,
  dropOtherSessions,
  userPassword,
  setPassword,
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
  passwordOk,
  currentSessionHash,
} from "@/lib/auth";
import { saveModelSettings } from "@/lib/settings";

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

type Result = { ok: boolean; error?: string; message?: string } | null;

/** Model settings. The onboarding form sends `after`: it requires a complete configuration first. */
export async function saveModelsAction(
  _: Result,
  fd: FormData,
): Promise<Result> {
  const u = await requireUser();
  const onboarding = String(fd.get("after") ?? "").startsWith("/setup");
  const r = saveModelSettings(u.id, fd, { require: onboarding });
  if (!r.ok) return r;
  if (onboarding) redirect("/setup?step=3");
  revalidatePath("/settings");
  revalidatePath("/app", "layout");
  return { ok: true, message: "Model settings saved." };
}

/** Email and password. A new password needs the current one and signs out every other session. */
export async function saveAccountAction(
  _: Result,
  fd: FormData,
): Promise<Result> {
  const u = await requireUser();
  const email = String(fd.get("email") ?? "").trim();
  const current = String(fd.get("current_password") ?? "");
  const next = String(fd.get("new_password") ?? "");
  const changes: string[] = [];
  if (next) {
    if (!verifyPassword(current, userPassword(u.id)?.pass ?? ""))
      return { ok: false, error: "The current password is wrong." };
    if (!passwordOk(next))
      return {
        ok: false,
        error: "Use at least 10 characters for the new password.",
      };
    setPassword(u.id, hashPassword(next));
    const keep = await currentSessionHash();
    if (keep) dropOtherSessions(u.id, keep);
    changes.push("Password changed; other devices were signed out.");
  }
  if (email && email.toLowerCase() !== u.email) {
    const r = changeEmail(u.id, email);
    if (!r.ok) return r;
    changes.push("Email updated.");
  }
  revalidatePath("/settings");
  return { ok: true, message: changes.join(" ") || "Nothing to change." };
}

/** Deletes every analysis the user owns. The form must carry the typed confirmation. */
export async function deleteAllAction(
  _: Result,
  fd: FormData,
): Promise<Result> {
  const u = await requireUser();
  if (String(fd.get("confirm") ?? "").trim() !== "DELETE")
    return { ok: false, error: "Type DELETE to confirm." };
  const ids = analysisIdsFor(u.id);
  for (const id of ids) {
    deleteAnalysis(id, u.id);
    await releasePlan(id);
  }
  revalidatePath("/settings");
  revalidatePath("/app", "layout");
  return {
    ok: true,
    message: `Deleted ${ids.length} ${ids.length === 1 ? "analysis" : "analyses"}.`,
  };
}
