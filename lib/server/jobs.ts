import {
  analystConfig,
  jevKey,
  jevModel,
  digestForModels,
} from "../settings.ts";
import { proposeCandidates, AnalystError } from "../analyst.ts";
import {
  judgeCandidates,
  jevFallback,
  makeJevClient,
  nothingToFix,
} from "../jev.ts";
import { patchAnalysis } from "../db.ts";
import type { Digest } from "../digest.ts";
import { createHash } from "node:crypto";

/**
 * Bump when the analysis pipeline changes what it would answer (prompts, rules, thresholds), so results
 * from before the change are not reused.
 */
export const PIPELINE_VERSION = "2026-09-26.2";

/**
 * Identifies an identical request: the exact evidence the models would see (after the privacy setting),
 * the note, both models' settings, and the pipeline version. Same key, same answer: the stored result is
 * reused instead of asking the models again. Reported from use: the same plan gave a different action plan
 * on every run, which made the tool look unreliable.
 */
export function runKey(userId: string, digest: Digest, note: string): string {
  const analyst = analystConfig(userId);
  return createHash("sha256")
    .update(
      JSON.stringify([
        PIPELINE_VERSION,
        digestForModels(userId, digest),
        note.trim(),
        analyst?.baseUrl,
        analyst?.model,
        analyst?.extra,
        jevModel(userId),
      ]),
    )
    .digest("hex");
}

// An analysis runs on the server, not inside the page that started it. Leaving the page, opening
// Settings or another report only stops *watching*; the run continues and its report fills in. Reported
// from real use: reasoning models take minutes, and losing a run to a tap on another page (with no way to
// rerun it) meant uploading the plan again.

export type Listener = (event: string, data: unknown) => void;
type Job = {
  id: string;
  userId: string;
  stage: string;
  startedAt: number;
  ac: AbortController;
  stopped: boolean;
  listeners: Set<Listener>;
};

/** Longest a run may take before it is stopped: a provider that never answers must not hold a job forever. */
export const JOB_LIMIT_MS = 15 * 60_000;
/** Runs one user may have going at once (MAX_RUNS_PER_USER, default 5): runs no longer end with the page. */
export const MAX_RUNNING_PER_USER =
  Number(process.env.MAX_RUNS_PER_USER) > 0
    ? Number(process.env.MAX_RUNS_PER_USER)
    : 5;

// Route handlers can be bundled separately; one registry per process keeps them in agreement.
const g = globalThis as typeof globalThis & { __qaiJobs?: Map<string, Job> };
const jobs = (g.__qaiJobs ??= new Map<string, Job>());

export const runningJob = (id: string) => {
  const j = jobs.get(id);
  return j ? { stage: j.stage, startedAt: j.startedAt } : null;
};
export const runningCount = (userId: string) =>
  [...jobs.values()].filter((j) => j.userId === userId).length;

/** Adds a watcher to a running analysis; returns the unsubscribe function, or null if it is not running. */
export function watch(id: string, listener: Listener): (() => void) | null {
  const j = jobs.get(id);
  if (!j) return null;
  j.listeners.add(listener);
  return () => j.listeners.delete(listener);
}

/** Stops a run on the user's request. Returns false when it is not running (already finished). */
export function stopAnalysis(id: string, userId: string): boolean {
  const j = jobs.get(id);
  if (!j || j.userId !== userId) return false;
  j.stopped = true;
  j.ac.abort();
  return true;
}

/**
 * Starts the analysis in the background. `first` is subscribed before any event is sent, so the page that
 * started the run sees every stage.
 */
export function startAnalysis(
  opts: { id: string; userId: string; digest: Digest; note: string },
  first?: Listener,
) {
  const job: Job = {
    id: opts.id,
    userId: opts.userId,
    stage: "digesting",
    startedAt: Date.now(),
    ac: new AbortController(),
    stopped: false,
    listeners: new Set(first ? [first] : []),
  };
  jobs.set(opts.id, job);
  // Cleared until this run finishes: a stopped or failed run must not be reused.
  patchAnalysis(opts.id, { status: "running", error: "", run_key: "" });
  const limit = setTimeout(() => job.ac.abort(), JOB_LIMIT_MS);
  void run(job, opts.digest, opts.note).finally(() => {
    clearTimeout(limit);
    jobs.delete(job.id);
  });
}

async function run(job: Job, digest: Digest, note: string) {
  const emit = (event: string, data: unknown) => {
    for (const l of job.listeners) {
      try {
        l(event, data);
      } catch {
        job.listeners.delete(l); // a closed page must not break the run
      }
    }
  };
  const stage = (s: string) => {
    job.stage = s;
    emit("stage", { stage: s });
  };
  const { id, userId } = job;
  try {
    const analyst = analystConfig(userId),
      jev = jevKey(userId);
    if (!analyst || !jev)
      throw new Error("Configure the analyst and Jev in Settings first.");
    stage("digesting");
    // The page renders the stored digest (operators, warnings); the models get the privacy-filtered one.
    emit("digest", digest);
    stage("proposing");
    const modelDigest = digestForModels(userId, digest);
    let candidates;
    try {
      candidates = await proposeCandidates(
        analyst,
        modelDigest,
        note,
        undefined,
        job.ac.signal,
      );
    } catch (e) {
      // The analyst saying there is nothing to fix is a result, not a failure.
      if (
        job.ac.signal.aborted ||
        !(e instanceof AnalystError) ||
        !/^Insufficient evidence/.test(e.message)
      )
        throw e;
      const verdict = nothingToFix(
        e.message.replace(/^Insufficient evidence:\s*/, ""),
      );
      patchAnalysis(id, {
        candidates: "[]",
        verdict: JSON.stringify(verdict),
        status: "done",
        run_key: runKey(userId, digest, note),
      });
      emit("candidates", []);
      emit("verdict", verdict);
      emit("done", { id });
      return;
    }
    patchAnalysis(id, { candidates: JSON.stringify(candidates) });
    emit("candidates", candidates);
    stage("judging");
    let verdict;
    try {
      verdict = await judgeCandidates(
        modelDigest,
        candidates,
        makeJevClient(jev, jevModel(userId)),
        job.ac.signal,
        note,
      );
    } catch {
      if (job.ac.signal.aborted) throw new Error("aborted");
      verdict = jevFallback(
        candidates,
        "Jev could not be reached. Retry the decision when the service is available.",
      );
    }
    if (job.ac.signal.aborted) throw new Error("aborted");
    // Only a complete decision is reused; one made while Jev was down or partial should be retried.
    const complete =
      verdict.status !== "unavailable" &&
      !verdict.flags.includes("jev_partial");
    patchAnalysis(id, {
      verdict: JSON.stringify(verdict),
      status: "done",
      run_key: complete ? runKey(userId, digest, note) : "",
    });
    emit("verdict", verdict);
    emit("done", { id });
  } catch (e) {
    const message = job.stopped
      ? "Stopped before it finished. Use Run again to start it over with the same plan."
      : job.ac.signal.aborted
        ? `Stopped after ${JOB_LIMIT_MS / 60_000} minutes without an answer from the models. Use Run again to retry.`
        : (e as Error).message;
    patchAnalysis(id, {
      status: job.stopped ? "stopped" : "failed",
      error: message,
    });
    emit("error", { stage: "analysis", message });
    emit("done", { id });
  }
}
