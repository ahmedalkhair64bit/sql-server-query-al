import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const dir = process.env.DATA_DIR ?? "data";
mkdirSync(dir, { recursive: true });

// Open on first query, not at import: `next build` imports every page through lib/auth -> lib/db in ~6 parallel
// workers, and six processes running DDL against one file at once fails with "database is locked".
let _db: DatabaseSync | null = null;
function openDb(): DatabaseSync {
  if (_db) return _db;
  const d = new DatabaseSync(`${dir}/qai.db`);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;`);
  d.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY, analyst_base_url TEXT NOT NULL DEFAULT '', analyst_key TEXT NOT NULL DEFAULT '',
      analyst_model TEXT NOT NULL DEFAULT '', analyst_extra TEXT NOT NULL DEFAULT '{}',
      jev_key TEXT NOT NULL DEFAULT '', jev_model TEXT NOT NULL DEFAULT 'jev-latest',
      onboarded INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, xml TEXT NOT NULL,
      digest TEXT, candidates TEXT, verdict TEXT, oul TEXT,
      status TEXT NOT NULL DEFAULT 'running', error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_analyses_user ON analyses(user_id, created_at DESC);`);
  // Columns added after the first release: existing /data volumes get them on first open.
  const cols = new Set(
    (d.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has("comparison")) d.exec("ALTER TABLE analyses ADD COLUMN comparison TEXT");
  if (!cols.has("note")) d.exec("ALTER TABLE analyses ADD COLUMN note TEXT");
  const settingCols = new Set(
    (d.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map((c) => c.name),
  );
  // Last connection test per model (JSON), and whether the statement text may be sent to the analyst.
  if (!settingCols.has("analyst_status")) d.exec("ALTER TABLE settings ADD COLUMN analyst_status TEXT");
  if (!settingCols.has("jev_status")) d.exec("ALTER TABLE settings ADD COLUMN jev_status TEXT");
  if (!settingCols.has("send_sql")) d.exec("ALTER TABLE settings ADD COLUMN send_sql INTEGER NOT NULL DEFAULT 1");
  _db = d;
  return d;
}
// Proxy keeps the terse call sites (db.prepare) while deferring the open; methods must be bound to the real
// instance or node:sqlite rejects the receiver ("Illegal invocation").
export const db: DatabaseSync = new Proxy({} as DatabaseSync, {
  get: (_t, k) => {
    const v = (openDb() as any)[k];
    return typeof v === "function" ? v.bind(openDb()) : v;
  },
});

const now = () => Date.now();
type Row = string | number | null;
// node:sqlite hands back null-prototype objects. React refuses to serialize those into a client component
// ("Only plain objects ... can be passed to Client Components"), so every row is spread back to a normal object here.
const plain = <T>(r: unknown): T | null => (r ? { ...r } as T : null);
const one = <T>(sql: string, ...p: Row[]): T | null => plain<T>(db.prepare(sql).get(...p));
// node:sqlite binds null/number/string/bigint/Buffer only: pass 0/1, never booleans.

export type SettingsInput = { analyst_base_url: string; analyst_key: string; analyst_model: string;
  analyst_extra: string; jev_key: string; jev_model: string; onboarded: number };
export type Analysis = { id: string; title: string; xml: string; digest: string | null; candidates: string | null;
  verdict: string | null; oul: string | null; status: string; error: string | null; created_at: number;
  comparison: string | null; note: string | null };

export function createUser(email: string, passHash: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, email, pass, created_at) VALUES (?,?,?,?)").run(id, email, passHash, now());
  return id;
}
export const userByEmail = (email: string) =>
  one<{ id: string; pass: string }>("SELECT id, pass FROM users WHERE email = ?", email);
export const userEmail = (id: string) => one<{ email: string }>("SELECT email FROM users WHERE id = ?", id);

export function putSession(tokenHash: string, userId: string, expiresAt: number) {
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .run(tokenHash, userId, now(), expiresAt);
}
export function sessionUserId(tokenHash: string): string | null {
  return one<{ user_id: string }>("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
    tokenHash, now())?.user_id ?? null;
}
export const dropSession = (tokenHash: string) =>
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
/** Sign out every other device after a password change. */
export const dropOtherSessions = (userId: string, keepHash: string) =>
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, keepHash);
export const userPassword = (id: string) => one<{ pass: string }>("SELECT pass FROM users WHERE id = ?", id);
export const setPassword = (id: string, passHash: string) =>
  db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(passHash, id);

export type StoredSettings = SettingsInput & {
  onboarded: number; analyst_status: string | null; jev_status: string | null; send_sql: number };
export const getSettings = (userId: string) =>
  one<StoredSettings>("SELECT * FROM settings WHERE user_id = ?", userId);
// Status and privacy are written apart from the form save, so a save never clears a test result.
export function setModelStatus(userId: string, target: "analyst" | "jev", status: string) {
  db.prepare(`UPDATE settings SET ${target === "analyst" ? "analyst_status" : "jev_status"} = ? WHERE user_id = ?`)
    .run(status, userId);
}
export const setSendSql = (userId: string, on: boolean) =>
  db.prepare("UPDATE settings SET send_sql = ? WHERE user_id = ?").run(on ? 1 : 0, userId);
export const analysisIdsFor = (userId: string) =>
  (db.prepare("SELECT id FROM analyses WHERE user_id = ?").all(userId) as { id: string }[]).map((r) => r.id);
export const exportAnalyses = (userId: string) =>
  (db.prepare(`SELECT id, title, status, error, created_at, digest, candidates, verdict, comparison
     FROM analyses WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as Record<string, unknown>[])
    .map((r) => ({ ...r }));

export function saveSettings(userId: string, s: SettingsInput) {
  // A blank secret means "keep what is stored" — enforced here, not only in the form layer, so no caller
  // (password change, onboarding re-save, a future import) can blank a stored key by omitting it.
  db.prepare(`INSERT INTO settings (user_id, analyst_base_url, analyst_key, analyst_model, analyst_extra,
      jev_key, jev_model, onboarded, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET analyst_base_url=excluded.analyst_base_url,
      analyst_key=COALESCE(NULLIF(excluded.analyst_key, ''), settings.analyst_key),
      analyst_model=excluded.analyst_model, analyst_extra=excluded.analyst_extra,
      jev_key=COALESCE(NULLIF(excluded.jev_key, ''), settings.jev_key),
      jev_model=excluded.jev_model, onboarded=excluded.onboarded, updated_at=excluded.updated_at`)
    .run(userId, s.analyst_base_url, s.analyst_key, s.analyst_model, s.analyst_extra, s.jev_key, s.jev_model,
         s.onboarded, now());
}

export function newAnalysis(userId: string, title: string, xml: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO analyses (id, user_id, title, xml, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, userId, title, xml, "running", now(), now());
  return id;
}

// patchAnalysis builds its SET list from object keys, so the keys have to be checked, not trusted.
const PATCHABLE = new Set(["digest", "candidates", "verdict", "oul", "status", "error", "title", "comparison", "note"]);
export function patchAnalysis(id: string, p: Record<string, string>) {
  const keys = Object.keys(p).filter((k) => PATCHABLE.has(k));
  if (!keys.length) return;
  db.prepare(`UPDATE analyses SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => p[k]), now(), id);
}
export const listAnalyses = (userId: string) =>
  (db.prepare("SELECT id, title, status, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as { id: string; title: string; status: string; created_at: number }[])
    .map((r) => ({ ...r }));
export const getAnalysis = (id: string, userId: string) =>
  one<Analysis>("SELECT * FROM analyses WHERE id = ? AND user_id = ?", id, userId);
export const renameAnalysis = (id: string, userId: string, title: string) =>
  db.prepare("UPDATE analyses SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(title, now(), id, userId);
export const deleteAnalysis = (id: string, userId: string) =>
  db.prepare("DELETE FROM analyses WHERE id = ? AND user_id = ?").run(id, userId);
