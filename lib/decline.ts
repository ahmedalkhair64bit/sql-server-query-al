// What makes an option eligible to be recommended, and, when Jev recommends nothing, a plain account of
// why and what to do next. Shared by the decision (lib/jev.ts) and the report, so the report's counts and
// reasons always match the checks that were actually applied. Pure: no SDK or server imports.
import type { Candidate } from "./analyst.ts";
import type { Ranked, Verdict } from "./jev.ts";

/** Flags that keep an option from being recommended as the first action. */
export const BLOCKING_FLAGS = [
  "verify_semantics",
  "invalid_evidence",
  "low_confidence",
  "unsupported_claim",
  "operational_risk",
  "jev_failed",
  "estimates_accurate",
  "misses_bottleneck",
] as const;
/** Below this bottleneck fit an option is not a first action, whatever else it has going for it. */
export const MIN_FIT = 0.25;

/** Why each blocking flag stopped an option, worded for the DBA. */
const BLOCK_TEXT: Record<string, string> = {
  verify_semantics: "it may change the query's results",
  invalid_evidence: "its SQL or cited evidence failed the check",
  low_confidence: "Jev was unsure how it would behave",
  unsupported_claim: "the plan does not support its claimed effect",
  operational_risk: "it is risky to run on a production server",
  jev_failed: "Jev could not judge it",
  estimates_accurate:
    "the plan's estimates are already accurate, so statistics cannot help",
  misses_bottleneck: "it does not address the measured bottleneck",
};

export const passesChecks = (r: Ranked) =>
  !r.flags.some((f) => (BLOCKING_FLAGS as readonly string[]).includes(f)) &&
  r.dims.bottleneck_fit.value >= MIN_FIT;

/** The first reason an option was held back, or null when it passed every check. */
export function blockReason(r: Ranked): string | null {
  const f = r.flags.find((x) => BLOCK_TEXT[x]);
  if (f) return BLOCK_TEXT[f];
  if (r.dims.bottleneck_fit.value < MIN_FIT)
    return "it fits the measured bottleneck poorly";
  return null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export type Decline = {
  /** The headline: what kind of decline this is. */
  title: string;
  /** One sentence: why nothing was recommended. */
  reason: string;
  /** The option that came closest, and why it fell short. */
  closest: { key: string; title: string; why: string } | null;
  /** Concrete things the DBA can do to get a recommendation. */
  next: string[];
};

/**
 * Explains a decision where Jev recommended nothing. Reported from use: the old text ("Every option failed
 * a safety, evidence or fit check") showed even when options had passed and Jev itself chose to wait, next
 * to "3 passed every check", and named neither the nearest option nor a way forward.
 */
export function explainDecline(
  verdict: Verdict,
  candidates: Candidate[],
  context: { actual?: boolean } = {},
): Decline {
  const title = (key: string) =>
    candidates.find((c) => c.key === key)?.title ?? key;
  const order = verdict.order ?? [];
  const passed = order.filter(passesChecks);
  const probs = verdict.jev_probabilities ?? {};
  const declineP = probs.no_suitable_action ?? 0;
  const passedKeys = new Set(passed.map((r) => r.key));
  const ranked = Object.entries(probs)
    .filter(([k]) => k !== "no_suitable_action")
    .sort((a, b) => b[1] - a[1]);
  // What Jev's answer leaned to most, and its favourite among the options that passed the checks: only
  // an option that passed can be offered as the closest one.
  const top = ranked[0];
  const favourite = ranked.find(([k]) => passedKeys.has(k));

  let reason: string;
  let heading: string;
  let closest: Decline["closest"] = null;
  if (!passed.length) {
    heading = "No option passed the checks";
    reason = `None of the ${order.length} options passed the checks needed to recommend it.`;
    const best = order[0];
    if (best)
      closest = {
        key: best.key,
        title: title(best.key),
        why: `Held back because ${blockReason(best) ?? "it did not pass every check"}.`,
      };
  } else if (
    verdict.flags.includes("no_suitable_action") &&
    top &&
    top[1] > declineP &&
    !passedKeys.has(top[0])
  ) {
    // Jev's answer leaned to something it could not pick: an answer error, not a judgment.
    heading = "Jev's answer could not be used";
    const row = order.find((r) => r.key === top[0]);
    reason = row
      ? `Jev's answer favoured "${title(top[0])}", which had not passed the checks (${blockReason(row) ?? "held back"}), so nothing was selected. Retry Jev.`
      : "Jev's answer named an option that was not on the list, so nothing was selected. Retry Jev.";
    const best = passed[0];
    if (best)
      closest = {
        key: best.key,
        title: title(best.key),
        why: "The best-scored option that passed every check.",
      };
  } else if (verdict.flags.includes("no_suitable_action")) {
    heading = "Jev wants more evidence first";
    reason = `${passed.length} of ${order.length} options passed the checks, but Jev judged none of them a defensible first action and put ${pct(declineP)} on collecting more evidence.`;
    if (favourite)
      closest = {
        key: favourite[0],
        title: title(favourite[0]),
        why: `Jev's strongest alternative, with ${pct(favourite[1])} of its weight.`,
      };
  } else if (verdict.flags.includes("nothing_clearly_worthwhile")) {
    heading = "No option is clearly worth running";
    reason = `Jev put the chance that any option improves this query without changing its results at ${pct(verdict.anything_worth_running)}, under the 50% needed to recommend one.`;
    if (favourite)
      closest = {
        key: favourite[0],
        title: title(favourite[0]),
        why: `Jev's favourite, with ${pct(favourite[1])} of its weight.`,
      };
  } else {
    const p = favourite?.[1] ?? verdict.jev_confidence;
    heading = "No option stood out clearly";
    reason = `Jev's favourite had ${pct(p)} of its weight, short of the 50% needed to recommend it.`;
    if (favourite)
      closest = {
        key: favourite[0],
        title: title(favourite[0]),
        why: `${pct(p)} of Jev's weight; ${pct(declineP)} went to collecting more evidence.`,
      };
  }

  const next: string[] = [];
  if (context.actual === false)
    next.push(
      "Capture an actual execution plan (Include Actual Execution Plan in SSMS): measured rows and time give Jev far stronger evidence than estimates.",
    );
  next.push(
    "Add context: what is slow, how often it runs, and what you are allowed to change.",
  );
  if (candidates.some((c) => c.option_type === "index"))
    next.push(
      "Paste the table's existing indexes, so index options are checked against what is already there.",
    );
  if (closest)
    next.push(
      `Or review "${closest.title}" yourself: its SQL, validation and rollback are below.`,
    );
  return { title: heading, reason, closest, next };
}
