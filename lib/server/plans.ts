import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { db, patchAnalysis } from "../db.ts";
import type { Digest } from "../digest.ts";
export const MAX_PLAN_BYTES = 100_000_000;
const root = () => resolve(process.env.DATA_DIR ?? "data", "plans");
export type StatementSummary = {
  id: string;
  sql: string;
  estimatedCost: number | null;
  actual: boolean;
  offset: number;
  length: number;
};
export type PlanRow = {
  id: string;
  user_id: string;
  name: string;
  bytes: number;
  count: number;
  recommended: string;
  created_at: number;
};
function init() {
  db.exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,count INTEGER NOT NULL,recommended TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS analysis_plans(analysis_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,statement_id TEXT NOT NULL);`);
}
export function ownedPlan(id: string, userId: string): PlanRow | null {
  init();
  return (
    (db
      .prepare("SELECT * FROM plans WHERE id=? AND user_id=?")
      .get(id, userId) as PlanRow) ?? null
  );
}
export async function listStatements(planId: string, page = 0) {
  const result: StatementSummary[] = [];
  let i = 0;
  const input = createReadStream(join(root(), planId, "index.ndjson"));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (i++ < page * 50) continue;
      result.push(JSON.parse(line));
      if (result.length === 50) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return result;
}
export async function statementDigest(
  planId: string,
  id: string,
): Promise<Digest> {
  const input = createReadStream(join(root(), planId, "index.ndjson"));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let found: StatementSummary | undefined;
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (row.id === id) {
        found = row;
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!found) throw new Error("Statement not found.");
  const fd = await open(join(root(), planId, "statements.ndjson"), "r");
  try {
    const b = Buffer.alloc(found.length);
    await fd.read(b, 0, b.length, found.offset);
    return JSON.parse(b.toString());
  } finally {
    await fd.close();
  }
}
let active = 0;
export async function ingestPlan(
  body: ReadableStream<Uint8Array>,
  userId: string,
  name: string,
  signal?: AbortSignal,
) {
  if (active >= 2)
    throw new Error("Two uploads are already processing. Try again shortly.");
  active++;
  const id = randomUUID(),
    directory = join(root(), id),
    file = join(directory, "source.xml");
  let bytes = 0;
  try {
    await cleanupUnusedPlans(userId);
    await mkdir(directory, { recursive: true });
    const fd = await open(file, "wx");
    const reader = body.getReader();
    try {
      while (true) {
        if (signal?.aborted) throw new Error("Upload cancelled.");
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_PLAN_BYTES) {
          await reader.cancel();
          throw new Error("Plan exceeds the 100 MB limit.");
        }
        await fd.write(value);
      }
    } finally {
      reader.releaseLock();
      await fd.close();
    }
    const meta = await new Promise<{ count: number; recommended: string }>(
      (yes, no) => {
        // Kept as a runtime file: Next copies it through outputFileTracingIncludes.
        const workerUrl = pathToFileURL(
          join(process.cwd(), "lib", "plan-worker.mjs"),
        ).href;
        const worker = new Worker(`import(${JSON.stringify(workerUrl)})`, {
          eval: true,
          workerData: { file, directory },
          resourceLimits: { maxOldGenerationSizeMb: 512 },
        });
        const abort = () => {
          void worker.terminate();
          no(new Error("Upload cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          void worker.terminate();
          no(
            new Error(
              "Plan parsing exceeded 120 seconds. Split the batch and retry.",
            ),
          );
        }, 120000);
        const clean = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        worker.once("message", (r) => {
          clean();
          if (r.ok) yes(r);
          else no(new Error(r.error));
        });
        worker.once("error", (e) => {
          clean();
          no(e);
        });
        worker.once("exit", (code) => {
          clean();
          if (code !== 0) no(new Error(`Plan worker stopped (${code}).`));
        });
        if (signal?.aborted) abort();
      },
    );
    if (signal?.aborted) throw new Error("Upload cancelled.");
    init();
    db.prepare("INSERT INTO plans VALUES(?,?,?,?,?,?,?)").run(
      id,
      userId,
      name.slice(0, 160),
      bytes,
      meta.count,
      meta.recommended,
      Date.now(),
    );
    return {
      id,
      name,
      bytes,
      count: meta.count,
      recommended: meta.recommended,
      statements: await listStatements(id),
    };
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  } finally {
    active--;
  }
}
export function attachPlan(
  analysisId: string,
  planId: string,
  statementId: string,
) {
  init();
  const attached = db
    .prepare("INSERT INTO analysis_plans SELECT ?,id,? FROM plans WHERE id=?")
    .run(analysisId, statementId, planId);
  if (attached.changes !== 1) {
    patchAnalysis(analysisId, {
      status: "failed",
      error: "The uploaded plan was removed. Upload it again.",
    });
    throw new Error("The uploaded plan was removed. Upload it again.");
  }
}
export async function releasePlan(analysisId: string) {
  init();
  const row = db
    .prepare("SELECT plan_id FROM analysis_plans WHERE analysis_id=?")
    .get(analysisId) as { plan_id: string } | undefined;
  db.prepare("DELETE FROM analysis_plans WHERE analysis_id=?").run(analysisId);
  if (row) await removeIfUnused(row.plan_id);
}
async function removeIfUnused(id: string) {
  // Claim deletion synchronously so another request cannot attach a new reference during disk cleanup.
  const removed = db
    .prepare(
      "DELETE FROM plans WHERE id=? AND NOT EXISTS (SELECT 1 FROM analysis_plans WHERE plan_id=?) RETURNING id",
    )
    .get(id, id);
  if (removed) await rm(join(root(), id), { recursive: true, force: true });
}
async function cleanupUnusedPlans(userId: string) {
  init();
  const rows = db
    .prepare("SELECT id FROM plans WHERE user_id=? AND created_at<?")
    .all(userId, Date.now() - 86400000) as { id: string }[];
  for (const row of rows) await removeIfUnused(row.id);
}
