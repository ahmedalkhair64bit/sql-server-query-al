import { TypeSafeClient, score, noul, choice } from "@typesafe-ai/sdk";
import { digestForModel, type Digest } from "./digest.ts";
import type { Candidate } from "./analyst.ts";

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

export type Ranked = {
  key: string;
  evidence_support?: number;
  operational_safety?: number;
  dims: Record<Dim, { value: number; confidence: number | null }>;
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
  agrees: boolean;
  anything_worth_running: number;
  weights: Record<Dim, number>;
  flags: string[];
};

export const makeJevClient = (apiKey: string, model = "jev-latest") =>
  new TypeSafeClient({ apiKey, defaultModel: model, timeout: 20_000 });

const norm = (s: number, levels: number) =>
  Math.max(0, Math.min(1, s / (levels - 1)));

function rank(
  c: Candidate,
  a: {
    bottleneck_fit: { score: number; confidence: number | null };
    semantic_safety: { score: number; confidence: number | null };
    ease: { score: number; confidence: number | null };
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
    },
    ease: {
      value: norm(a.ease.score, EASE.length),
      confidence: a.ease.confidence,
    },
    root_cause: { value: a.root_cause.noul, confidence: null }, // noul reports no confidence
  } as Record<Dim, { value: number; confidence: number | null }>;
  const composite = (Object.keys(WEIGHTS) as Dim[]).reduce(
    (s, k) => s + WEIGHTS[k] * dims[k].value,
    0,
  );
  const confs = Object.values(dims)
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

export async function judgeCandidates(
  digest: Digest,
  candidates: Candidate[],
  client: TypeSafeClient,
  signal?: AbortSignal,
): Promise<Verdict> {
  const plan = digestForModel(digest);
  const per = await Promise.all(
    candidates.map((c) =>
      client.systemOne(
        {
          state: { plan, candidate: c },
          questions: {
            bottleneck_fit: score(
              "How directly do the actions in `candidate` attack the dominant bottleneck in `plan` — the most expensive operator and the worst estimate error?",
              BOTTLENECK,
            ),
            semantic_safety: score(
              "If `candidate` is applied, how certain is it that the query still returns exactly the same rows as the original?",
              SAFETY,
            ),
            ease: score(
              "How easy is `candidate` to apply in a real shop, counting people, approvals, and downtime?",
              EASE,
            ),
            evidence_supported: noul(
              "The material diagnosis and expected benefit in `candidate` are supported by the cited `plan.evidence`, without invented facts or confusing estimates with measured runtime.",
            ),
            operational_safe: noul(
              "The actions in `candidate` have acceptable operational risk for review as a first step, considering locks, downtime, prerequisites, validation and rollback. Unknown prerequisites require verification before execution.",
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

  const order = candidates
    .map((c, i) => rank(c, per[i].answers))
    .sort((a, b) => b.composite - a.composite);
  const eligible = candidates.filter(
    (c) =>
      !order
        .find((r) => r.key === c.key)!
        .flags.some((f) =>
          [
            "verify_semantics",
            "invalid_evidence",
            "low_confidence",
            "unsupported_claim",
            "operational_risk",
          ].includes(f),
        ) &&
      order.find((r) => r.key === c.key)!.dims.bottleneck_fit.value >= 0.25,
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
      flags: ["no_suitable_action"],
    };
  const cross = await client.systemOne(
    {
      state: {
        plan,
        options: eligible,
        judgments: JSON.parse(JSON.stringify(order)),
      },
      questions: {
        first_to_run: choice(
          "Which option should the DBA review first, considering complete actions, evidence, prerequisites, safety, operational risk and the judgments? Choose no_suitable_action if evidence is insufficient or all actions are unsuitable. A plan estimate is not a measured improvement.",
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
  return {
    version: 2,
    status: useJev ? "selected" : "abstained",
    order,
    source: useJev ? "jev" : "none",
    headline: useJev ? pick.choice : null,
    jev_pick: valid ? pick.choice : null,
    jev_confidence: pick.confidence,
    agrees: valid && pick.choice === order[0].key,
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
