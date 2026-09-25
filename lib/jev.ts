import { TypeSafeClient, score, noul, choice } from "@typesafe-ai/sdk";
import { digestForModel, type Digest } from "./digest.ts";
import type { Candidate } from "./analyst.ts";
import { parseDdl } from "./sql-check.mjs";

export type Dim = "bottleneck_fit" | "semantic_safety" | "ease" | "root_cause";
export const WEIGHTS: Record<Dim, number> = {
  bottleneck_fit: 0.4,
  semantic_safety: 0.3,
  ease: 0.15,
  root_cause: 0.15,
};
const SAFETY_FLOOR = 0.6;
const SAFETY_HARD_FLOOR = 0.45;
const CONFIDENCE_FLOOR = 0.35;

const BOTTLENECK = [
  "Unrelated to the costly operator or the worst estimate error in the plan.",
  "Touches a minor operator; the dominant cost is untouched.",
  "Partly addresses the dominant cost; a scan or spill probably remains.",
  "Directly removes the dominant cost for this query shape.",
  "Removes the dominant cost and the pattern behind it, so the shape itself changes.",
] as const;
const SAFETY = [
  "Changes results: a predicate, join, grouping, or NULL handling is altered.",
  "Likely changes results in edge cases: duplicates, ordering, tie-breaking.",
  "Equivalent on most data but leans on unstated assumptions.",
  "Clearly equivalent, with a stated reason.",
  "Equivalent and checkable: ships a comparison or rollback plan.",
] as const;
const EASE = [
  "Needs a schema plus application redesign and a release.",
  "Needs an application deploy with change control on the app tier.",
  "DBA work with approval, e.g. an index create during a window.",
  "One rewritten query or session setting, reviewable in minutes.",
  "Copy-paste change with no server-side change at all.",
] as const;

export type DimScore = {
  value: number;
  confidence: number | null;
  /** "rule" when set deterministically from the option's SQL instead of asked of Jev. */
  source?: "rule";
};
export type Ranked = {
  key: string;
  evidence_support?: number;
  operational_safety?: number;
  dims: Record<Dim, DimScore>;
  composite: number;
  flags: string[];
};
export type Verdict = {
  order: Ranked[];
  headline: string | null;
  source: "jev" | "composite" | "none";
  status?: "selected" | "abstained" | "unavailable";
  version?: number;
  jev_pick: string | null;
  jev_confidence: number;
  /** Why no change is recommended, when the analyst found nothing to fix. */
  reason?: string;
  /** Jev's probability for each choice, including no_suitable_action: how clear-cut the decision was. */
  jev_probabilities?: Record<string, number>;
  agrees: boolean;
  anything_worth_running: number;
  weights: Record<Dim, number>;
  flags: string[];
};

// A hung Jev used to cost 60 s (20 s timeout, retried twice). Timeouts are not retried: a Jev that did not
// answer in 20 s rarely answers on the next try, and the report says so instead. HTTP 429/5xx still retry.
export const makeJevClient = (apiKey: string, model = "jev-latest") =>
  new TypeSafeClient({
    apiKey,
    defaultModel: model,
    timeout: 20_000,
    retry: { apiTimeoutError: false },
  });

const norm = (s: number, levels: number) =>
  Math.max(0, Math.min(1, s / (levels - 1)));

type Scored = { score: number; confidence: number | null; source?: "rule" };
function rank(
  c: Candidate,
  a: {
    bottleneck_fit: Scored;
    semantic_safety: Scored;
    ease: Scored;
    root_cause: { noul: number };
    evidence_supported?: { noul: number };
    operational_safe?: { noul: number };
  },
): Ranked {
  for (const value of [
    a.bottleneck_fit.score,
    a.semantic_safety.score,
    a.ease.score,
    a.root_cause.noul,
  ]) {
    if (!Number.isFinite(value))
      throw new Error("Jev returned an invalid score.");
  }
  const dims = {
    bottleneck_fit: {
      value: norm(a.bottleneck_fit.score, BOTTLENECK.length),
      confidence: a.bottleneck_fit.confidence,
    },
    semantic_safety: {
      value: norm(a.semantic_safety.score, SAFETY.length),
      confidence: a.semantic_safety.confidence,
      ...(a.semantic_safety.source ? { source: a.semantic_safety.source } : {}),
    },
    ease: {
      value: norm(a.ease.score, EASE.length),
      confidence: a.ease.confidence,
      ...(a.ease.source ? { source: a.ease.source } : {}),
    },
    root_cause: { value: a.root_cause.noul, confidence: null }, // noul reports no confidence
  } as Record<Dim, DimScore>;
  const composite = (Object.keys(WEIGHTS) as Dim[]).reduce(
    (s, k) => s + WEIGHTS[k] * dims[k].value,
    0,
  );
  // Only doubt about fit or safety blocks an option. Measured on the real Jev, uncertainty about *effort*
  // (how easy an application change is) vetoed a safe, well-supported fix; it is now shown, not blocking.
  const confs = [dims.bottleneck_fit, dims.semantic_safety]
    .map((d) => d.confidence)
    .filter((x): x is number => x !== null);
  const flags: string[] = [];
  // Live Jev scores an index create around 0.57 ("probably equivalent, no proof stated"), so a blanket floor
  // flags every index option and the warning becomes noise. Semantics only move when the query text changes:
  // flag a rewrite below the soft floor, or anything at all below the hard floor.
  const safety = dims.semantic_safety.value;
  if (
    safety < SAFETY_HARD_FLOOR ||
    (c.option_type === "rewrite" && safety < SAFETY_FLOOR)
  )
    flags.push("verify_semantics");
  if (confs.length && Math.min(...confs) < CONFIDENCE_FLOOR)
    flags.push("low_confidence");
  if (dims.ease.confidence !== null && dims.ease.confidence < CONFIDENCE_FLOOR)
    flags.push("effort_uncertain");
  if (c.actions.some((x) => x.requires_change_control))
    flags.push("change_control");
  if (c.rejected_reasons?.length) flags.push("invalid_evidence");
  if (a.evidence_supported && a.evidence_supported.noul < 0.5)
    flags.push("unsupported_claim");
  if (a.operational_safe && a.operational_safe.noul < 0.5)
    flags.push("operational_risk");
  return {
    key: c.key,
    evidence_support: a.evidence_supported?.noul,
    operational_safety: a.operational_safe?.noul,
    dims,
    composite: Number(composite.toFixed(4)),
    flags,
  };
}

// Answers that follow from the option's own SQL, so Jev is not asked for an opinion on them.
// A nonclustered, non-unique index or a statistics change cannot alter the rows a query returns, and the
// work it takes is known from its type. Unique, clustered, columnstore or filtered indexes stay with Jev.
export function ruleDims(c: Candidate): {
  semantic_safety?: Scored;
  ease?: Scored;
} {
  if (!c.sql_to_run || c.rejected_reasons?.length) return {};
  const ddl = parseDdl(c.sql_to_run);
  const rolledBack = (c.rollback?.length ?? 0) > 0;
  const safety = {
    score: rolledBack ? 4 : 3,
    confidence: null,
    source: "rule" as const,
  };
  if (
    c.option_type === "statistics" &&
    ddl.statistics.length &&
    !ddl.indexes.length
  )
    return {
      semantic_safety: safety,
      ease: { score: 3, confidence: null, source: "rule" },
    };
  if (
    c.option_type === "index" &&
    ddl.indexes.length &&
    ddl.indexes.every(
      (i) => !i.unique && !i.clustered && !i.columnstore && !i.filtered,
    )
  )
    return {
      semantic_safety: safety,
      ease: { score: 2, confidence: null, source: "rule" },
    };
  return {};
}

// Base evidence every judgment sees, plus what the option itself cites. Sending the full 48 KB digest to
// every call diluted attention and cost; the findings and top operators carry the bottleneck.
const BASE_KINDS = new Set([
  "statement",
  "query_time",
  "memory_grant",
  "finding",
]);
export function planFor(digest: Digest, cited: string[]) {
  const plan = digestForModel(digest);
  const want = new Set(cited);
  let operators = 0;
  plan.evidence = plan.evidence.filter(
    (e) =>
      BASE_KINDS.has(e.kind) ||
      want.has(e.id) ||
      (e.kind === "operator" && operators++ < 5),
  );
  return plan;
}

const ASK_SAFETY = () =>
  score(
    "If `candidate` is applied, how certain is it that the query still returns exactly the same rows as the original?",
    SAFETY,
  );
const ASK_EASE = () =>
  score(
    "How easy is `candidate` to apply in a real shop, counting people, approvals, and downtime?",
    EASE,
  );

export async function judgeCandidates(
  digest: Digest,
  candidates: Candidate[],
  client: TypeSafeClient,
  signal?: AbortSignal,
  /** The DBA's own note: constraints Jev must weigh, e.g. "no schema changes this week". */
  constraints = "",
): Promise<Verdict> {
  if (!candidates.length)
    throw new Error("There are no options for Jev to judge.");
  const rules = candidates.map(ruleDims);
  const context: Record<string, string> = constraints.trim()
    ? { constraints: constraints.slice(0, 2000) }
    : {};
  // One failed judgment excludes that option instead of discarding every answer Jev gave.
  const settled = await Promise.allSettled(
    candidates.map((c, i) =>
      client.systemOne(
        {
          state: {
            plan: planFor(digest, c.evidence_ids ?? []),
            candidate: c,
            ...context,
          },
          questions: {
            bottleneck_fit: score(
              "How directly do the actions in `candidate` attack the dominant bottleneck in `plan`? The bottleneck is the critical `plan.evidence` findings and the operator with the highest own time or reads (own estimated cost when the plan is not actual), plus the worst row-estimate error.",
              BOTTLENECK,
            ),
            ...(rules[i].semantic_safety
              ? {}
              : { semantic_safety: ASK_SAFETY() }),
            ...(rules[i].ease ? {} : { ease: ASK_EASE() }),
            evidence_supported: noul(
              "The material diagnosis and expected benefit in `candidate` are supported by the cited `plan.evidence`, without invented facts or confusing estimates with measured runtime.",
            ),
            operational_safe: noul(
              "The actions in `candidate` have acceptable operational risk for review as a first step, considering locks, downtime, prerequisites, validation and rollback, and the DBA's `constraints` when present. Unknown prerequisites require verification before execution.",
            ),
            root_cause: noul(
              "The diagnosis in `candidate` names the actual cause of the cost in `plan`, not a symptom of it.",
            ),
          },
        },
        { signal },
      ),
    ),
  );
  if (signal?.aborted) throw new Error("Jev review cancelled.");
  if (settled.every((r) => r.status === "rejected"))
    throw (settled[0] as PromiseRejectedResult).reason;

  const failed = new Set<string>();
  const order = candidates
    .map((c, i) => {
      const r = settled[i];
      if (r.status === "rejected") {
        failed.add(c.key);
        const blank = rank(c, {
          bottleneck_fit: { score: 0, confidence: null },
          semantic_safety: { score: 0, confidence: null },
          ease: { score: 0, confidence: null },
          root_cause: { noul: 0 },
        });
        return {
          ...blank,
          flags: [
            ...blank.flags.filter((f) => f === "change_control"),
            "jev_failed",
          ],
        };
      }
      const answers = r.value.answers as Parameters<typeof rank>[1];
      return rank(c, {
        ...answers,
        semantic_safety: rules[i].semantic_safety ?? answers.semantic_safety,
        ease: rules[i].ease ?? answers.ease,
      });
    })
    .sort((a, b) => b.composite - a.composite);
  const BLOCKING = [
    "verify_semantics",
    "invalid_evidence",
    "low_confidence",
    "unsupported_claim",
    "operational_risk",
    "jev_failed",
  ];
  const isEligible = (r: Ranked) =>
    !r.flags.some((f) => BLOCKING.includes(f)) &&
    r.dims.bottleneck_fit.value >= 0.25;
  const eligibleRanked = order.filter(isEligible);
  const eligible = eligibleRanked.map((r) =>
    candidates.find((c) => c.key === r.key)!,
  );
  if (!eligible.length)
    return {
      version: 2,
      status: "abstained",
      order,
      source: "none",
      headline: null,
      jev_pick: null,
      jev_confidence: 0,
      agrees: false,
      anything_worth_running: 0,
      weights: WEIGHTS,
      flags: ["no_suitable_action", ...(failed.size ? ["jev_partial"] : [])],
    };
  const cross = await client.systemOne(
    {
      state: {
        plan: planFor(
          digest,
          eligible.flatMap((c) => c.evidence_ids ?? []),
        ),
        options: eligible,
        judgments: JSON.parse(JSON.stringify(eligibleRanked)),
        ...context,
      },
      questions: {
        first_to_run: choice(
          "Which option should the DBA review first, considering complete actions, the critical findings in `plan.evidence`, prerequisites, safety, operational risk, the judgments and the DBA's `constraints` when present? Choose no_suitable_action if evidence is insufficient or all actions are unsuitable. A plan estimate is not a measured improvement.",
          {
            ...Object.fromEntries(
              eligible.map((c) => [c.key, `${c.title} — ${c.expected}`]),
            ),
            no_suitable_action: "No defensible first action; collect evidence.",
          },
        ),
        anything_worth_running: noul(
          "At least one option is supported by plan evidence and likely to improve the query without changing its results.",
        ),
      },
    },
    { signal },
  );
  const pick = cross.answers.first_to_run;
  const worth = cross.answers.anything_worth_running.noul;
  const valid = eligible.some((c) => c.key === pick.choice);
  const useJev = valid && pick.confidence >= 0.5 && worth >= 0.5;
  const flags: string[] = [];
  if (pick.confidence < 0.5) flags.push("low_confidence");
  if (worth < 0.5) flags.push("nothing_clearly_worthwhile");
  if (!valid) flags.push("no_suitable_action");
  if (failed.size) flags.push("jev_partial");
  return {
    version: 2,
    status: useJev ? "selected" : "abstained",
    order,
    source: useJev ? "jev" : "none",
    headline: useJev ? pick.choice : null,
    jev_pick: valid ? pick.choice : null,
    jev_confidence: pick.confidence,
    jev_probabilities: pick.probabilities ?? undefined,
    // Agreement with the best option Jev could choose, not with an ineligible composite leader.
    agrees: valid && pick.choice === eligibleRanked[0].key,
    anything_worth_running: worth,
    weights: WEIGHTS,
    flags,
  };
}

// Neutral answers: Jev never spoke, so nothing is claimed about safety or fit. The UI must say so.
export function jevFallback(candidates: Candidate[], why: string): Verdict {
  // Scores are 0 because Jev never answered, not because the options are bad: drop every flag a score produced.
  const order = candidates
    .map((c) =>
      rank(c, {
        bottleneck_fit: { score: 0, confidence: null },
        semantic_safety: { score: 0, confidence: null },
        ease: { score: 0, confidence: null },
        root_cause: { noul: 0 },
      }),
    )
    .map((r) => ({
      ...r,
      flags: r.flags.filter((f) => f === "change_control"),
    }))
    .sort((a, b) => b.composite - a.composite);
  return {
    version: 2,
    status: "unavailable",
    order,
    source: "none",
    headline: null,
    jev_pick: null,
    jev_confidence: 0,
    agrees: false,
    anything_worth_running: 0,
    weights: WEIGHTS,
    flags: ["jev_unavailable", why.slice(0, 200)],
  };
}

// The analyst found nothing worth changing (a healthy plan). Recorded as a finished result, not an error.
export function nothingToFix(reason: string): Verdict {
  return {
    version: 2,
    status: "abstained",
    order: [],
    source: "none",
    headline: null,
    jev_pick: null,
    jev_confidence: 0,
    agrees: false,
    anything_worth_running: 0,
    weights: WEIGHTS,
    flags: ["nothing_to_fix"],
    reason: reason.slice(0, 1000),
  };
}
