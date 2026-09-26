import test from "node:test";
import assert from "node:assert/strict";
const { judgeCandidates, WEIGHTS, jevFallback } = await import("../lib/jev.ts");
const { TypeSafeClient } = await import("@typesafe-ai/sdk");

const digest = {
  sql: "SELECT",
  bytes: 1,
  subtreeCost: 1,
  parallel: false,
  nonParallelReason: null,
  earlyAbort: null,
  tables: [],
  rowGuessErrors: [],
  missingIndexes: [],
  warnings: [],
  waits: [],
  topOperators: [
    {
      id: "0",
      op: "Clustered Index Scan",
      cost: 4.1,
      estRows: 1000,
      actualRows: 1200000,
      execs: 1,
      io: 40,
      cpu: 39,
      spillLevels: 2,
      parallel: false,
    },
  ],
} as any;
const candidates = [
  {
    key: "a",
    title: "Covering index",
    diagnosis: "Scan of a million rows; no key exists on CustomerId.",
    actions: [
      {
        title: "Create index",
        detail: "CREATE INDEX",
        effort: "medium",
        requires_change_control: true,
      },
    ],
    option_type: "index",
    sql_to_run:
      "CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId] ON [dbo].[Orders] ([CustomerId]) INCLUDE ([TotalDue]);",
    expected: "seek instead of scan",
  },
  {
    key: "b",
    title: "Add TOP 100",
    diagnosis: "Too many rows leave the scan, so cut them off.",
    actions: [
      {
        title: "Add TOP 100",
        detail: "TOP 100",
        effort: "low",
        requires_change_control: false,
      },
    ],
    option_type: "rewrite",
    sql_to_run: "SELECT TOP 100 * FROM dbo.Orders ORDER BY TotalDue DESC;",
    expected: "less I/O",
  },
] as any;

const scored = (fit: number, safe: number, ease: number, cause: number) => ({
  bottleneck_fit: {
    type: "score",
    score: fit,
    confidence: 0.9,
    legend: {},
    probabilities: {},
  },
  semantic_safety: {
    type: "score",
    score: safe,
    confidence: 0.8,
    legend: {},
    probabilities: {},
  },
  ease: {
    type: "score",
    score: ease,
    confidence: 0.7,
    legend: {},
    probabilities: {},
  },
  root_cause: { type: "noul", noul: cause },
});

// The SDK's client takes an injectable fetch — no network in tests.
function fakeJev(map: any) {
  return new TypeSafeClient({
    apiKey: "test",
    fetch: (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      const answers = body.questions.first_to_run
        ? map.cross
        : map.byKey[body.state.candidate.key];
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any,
    retry: { maxRetries: 0 },
  });
}
const GOOD = {
  byKey: { a: scored(4, 4, 2, 1), b: scored(0.4, 0.5, 4, 0.1) },
  cross: {
    first_to_run: {
      type: "choice",
      choice: "a",
      confidence: 0.82,
      probabilities: { a: 0.82, b: 0.18 },
    },
    anything_worth_running: { type: "noul", noul: 0.9 },
  },
};

test("weights sum to 1", () =>
  assert.equal(
    Object.values(WEIGHTS).reduce((a, b) => a + b, 0),
    1,
  ));

test("jev picks the winner; the unsafe option is flagged and cannot lead", async () => {
  const v = await judgeCandidates(digest, candidates, fakeJev(GOOD));
  assert.equal(v.source, "jev");
  assert.equal(v.headline, "a");
  assert.equal(v.order[0].key, "a");
  assert.equal(v.agrees, true);
  assert.equal(v.jev_confidence, 0.82);
  assert.ok(
    v.order.find((r) => r.key === "b")!.flags.includes("verify_semantics"),
  );
  assert.ok(
    v.order.find((r) => r.key === "a")!.flags.includes("change_control"),
  );
  assert.ok(
    v.order.find((r) => r.key === "a")!.dims.bottleneck_fit.value === 1,
  );
});
test("a low-confidence jev pick abstains", async () => {
  const low = {
    byKey: GOOD.byKey,
    cross: {
      first_to_run: {
        type: "choice",
        choice: "b",
        confidence: 0.2,
        probabilities: { a: 0.4, b: 0.6 },
      },
      anything_worth_running: { type: "noul", noul: 0.4 },
    },
  };
  const v = await judgeCandidates(digest, candidates, fakeJev(low));
  assert.equal(v.source, "none");
  assert.equal(v.headline, null);
  assert.equal(v.agrees, false);
  assert.ok(v.flags.includes("low_confidence"));
  assert.ok(v.flags.includes("nothing_clearly_worthwhile"));
});
test("an unknown jev choice label abstains", async () => {
  const bogus = {
    byKey: GOOD.byKey,
    cross: {
      first_to_run: {
        type: "choice",
        choice: "zzz",
        confidence: 0.99,
        probabilities: { zzz: 0.99 },
      },
      anything_worth_running: { type: "noul", noul: 0.9 },
    },
  };
  const v = await judgeCandidates(digest, candidates, fakeJev(bogus));
  assert.equal(v.source, "none");
  assert.equal(v.headline, null);
  assert.equal(v.jev_pick, null);
});
test("unavailable Jev has no winner", () => {
  const v = jevFallback(candidates, "429 rate limited");
  assert.equal(v.source, "none");
  assert.ok(v.flags.includes("jev_unavailable"));
  assert.equal(v.order.length, 2);
});
test("a silent jev does not accuse every option of being unsafe", () => {
  const v = jevFallback(candidates, "fetch failed");
  // change_control is read off the candidate's own actions and stays; anything derived from a Jev score must go.
  const derived = (flags: string[]) =>
    flags.filter((f) => f !== "change_control");
  assert.deepEqual(
    v.order.map((r) => derived(r.flags)),
    [[], []],
  );
});
test("verify_semantics fires where semantics can actually move", async () => {
  // Real Jev scores an index create ~0.57 ("probably fine, no stated proof"), which a blanket <0.6 floor
  // flagged as unsafe on every run. Index-only options must not shout; rewrites and bad scores must.
  const idxOnly = [
    {
      ...candidates[0],
      option_type: "statistics",
      sql_to_run: "UPDATE STATISTICS dbo.Orders WITH FULLSCAN;",
    },
    candidates[1],
  ];
  const mid = {
    byKey: { a: scored(4, 2, 2, 1), b: scored(4, 2, 2, 1) },
    cross: GOOD.cross,
  };
  const v = await judgeCandidates(digest, idxOnly, fakeJev(mid));
  assert.ok(
    !v.order.find((r) => r.key === "a")!.flags.includes("verify_semantics"),
    "index create flagged",
  );
  assert.ok(
    v.order.find((r) => r.key === "b")!.flags.includes("verify_semantics"),
    "rewrite not flagged",
  );

  // A statistics change is scored safe by rule now; a bad Jev safety score still flags what Jev judges.
  const bad = {
    byKey: { a: scored(4, 1, 2, 1), b: GOOD.byKey.b },
    cross: GOOD.cross,
  };
  const opsOnly = [{ ...idxOnly[0], option_type: "ops" }, idxOnly[1]];
  const v2 = await judgeCandidates(digest, opsOnly, fakeJev(bad));
  assert.ok(
    v2.order.find((r) => r.key === "a")!.flags.includes("verify_semantics"),
    "bad score not flagged",
  );
});

test("a confident unsafe choice still cannot win", async () => {
  const v = await judgeCandidates(
    digest,
    candidates,
    fakeJev({
      ...GOOD,
      cross: {
        ...GOOD.cross,
        first_to_run: {
          type: "choice",
          choice: "b",
          confidence: 0.99,
          probabilities: { b: 0.99 },
        },
      },
    }),
  );
  assert.equal(v.headline, null);
  assert.equal(v.status, "abstained");
});
test("low evidence support or unacceptable operational risk excludes an option", async () => {
  const byKey = {
    a: {
      ...GOOD.byKey.a,
      evidence_supported: { type: "noul", noul: 0.1 },
      operational_safe: { type: "noul", noul: 0.9 },
    },
    b: GOOD.byKey.b,
  };
  const v = await judgeCandidates(
    digest,
    candidates,
    fakeJev({ ...GOOD, byKey }),
  );
  assert.equal(v.headline, null);
  assert.ok(
    v.order.find((r) => r.key === "a")?.flags.includes("unsupported_claim"),
  );
});
test("Jev can select a safe alternative over the composite leader", async () => {
  const byKey = { a: GOOD.byKey.a, b: scored(3, 4, 3, 0.9) };
  const v = await judgeCandidates(
    digest,
    candidates,
    fakeJev({
      ...GOOD,
      byKey,
      cross: {
        ...GOOD.cross,
        first_to_run: {
          type: "choice",
          choice: "b",
          confidence: 0.8,
          probabilities: { b: 0.8, a: 0.2 },
        },
      },
    }),
  );
  assert.equal(v.headline, "b");
  assert.equal(v.source, "jev");
  assert.equal(v.agrees, false);
});

// ---- deterministic dimensions, partial failures, focused evidence ----
const withRollback = (c: any) => ({ ...c, rollback: ["DROP INDEX"] });
test("index and statistics safety and ease are set by rule, not asked of Jev", async () => {
  const asked: string[][] = [];
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch: (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      asked.push(Object.keys(body.questions));
      const answers = body.questions.first_to_run
        ? GOOD.cross
        : GOOD.byKey[body.state.candidate.key as "a" | "b"];
      return new Response(
        JSON.stringify({ model: "jev", usage: {}, answers }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any,
    retry: { maxRetries: 0 },
  });
  const v = await judgeCandidates(
    digest,
    [withRollback(candidates[0]), candidates[1]],
    client,
  );
  const a = v.order.find((r) => r.key === "a")!;
  assert.equal(a.dims.semantic_safety.source, "rule");
  assert.equal(a.dims.semantic_safety.value, 1);
  assert.equal(a.dims.ease.value, 0.5);
  const perCandidate = asked.filter((q) => !q.includes("first_to_run"));
  assert.ok(perCandidate.some((q) => !q.includes("semantic_safety")));
  assert.ok(
    perCandidate.some((q) => q.includes("semantic_safety")),
    "the rewrite is still asked",
  );
});
test("a unique index is still judged by Jev", async () => {
  const { ruleDims } = await import("../lib/jev.ts");
  assert.deepEqual(
    ruleDims({
      ...candidates[0],
      sql_to_run: "CREATE UNIQUE INDEX IX ON dbo.Orders (CustomerId);",
    }),
    {},
  );
  assert.equal(
    ruleDims({
      ...candidates[0],
      option_type: "statistics",
      sql_to_run: "UPDATE STATISTICS dbo.Orders WITH FULLSCAN;",
    }).semantic_safety?.score,
    3,
  );
});
test("one failed judgment excludes that option instead of the whole verdict", async () => {
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch: (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      if (!body.questions.first_to_run && body.state.candidate.key === "b")
        return new Response("boom", { status: 400 });
      const answers = body.questions.first_to_run
        ? GOOD.cross
        : GOOD.byKey[body.state.candidate.key as "a"];
      return new Response(
        JSON.stringify({ model: "jev", usage: {}, answers }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any,
    retry: { maxRetries: 0 },
  });
  const v = await judgeCandidates(digest, candidates, client);
  assert.equal(v.headline, "a");
  assert.ok(v.flags.includes("jev_partial"));
  assert.ok(v.order.find((r) => r.key === "b")!.flags.includes("jev_failed"));
});
test("agrees compares with the best eligible option, not an ineligible leader", async () => {
  // b leads the composite but is unsafe; Jev picks a, the best option it may choose.
  const byKey = { a: scored(2, 4, 2, 0.8), b: scored(4, 0, 4, 1) };
  const v = await judgeCandidates(
    digest,
    candidates,
    fakeJev({ ...GOOD, byKey }),
  );
  assert.equal(v.order[0].key, "b");
  assert.equal(v.headline, "a");
  assert.equal(v.agrees, true);
});
test("Jev sees base evidence, findings, the top operators and what the option cites", async () => {
  const { planFor } = await import("../lib/jev.ts");
  const { parsePlanText } = await import("../lib/plan-parser.mjs");
  const { readFileSync } = await import("node:fs");
  const d = parsePlanText(
    readFileSync("fixtures/nested-actual.sqlplan", "utf8"),
  )[0];
  const plan = planFor(d, ["s1:stats:0"]);
  const kinds = new Set(plan.evidence.map((e) => e.kind));
  for (const k of [
    "statement",
    "query_time",
    "memory_grant",
    "finding",
    "operator",
  ])
    assert.ok(kinds.has(k), k);
  assert.ok(
    plan.evidence.some((e) => e.id === "s1:stats:0"),
    "cited evidence kept",
  );
  assert.ok(
    !plan.evidence.some((e) => e.kind === "parameter"),
    "uncited raw evidence dropped",
  );
});

test("the DBA's constraints reach every Jev question, and the choice probabilities are kept", async () => {
  const states: any[] = [];
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch: (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      states.push(body.state);
      const answers = body.questions.first_to_run
        ? GOOD.cross
        : GOOD.byKey[body.state.candidate.key as "a" | "b"];
      return new Response(
        JSON.stringify({ model: "jev", usage: {}, answers }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any,
    retry: { maxRetries: 0 },
  });
  const v = await judgeCandidates(
    digest,
    candidates,
    client,
    undefined,
    "No schema changes until Friday.",
  );
  assert.ok(states.length >= 3);
  for (const s of states)
    assert.equal(s.constraints, "No schema changes until Friday.");
  assert.deepEqual(v.jev_probabilities, { a: 0.82, b: 0.18 });
});

test("uncertainty about effort alone does not block an option; uncertainty about fit does", async () => {
  const unsureEase = {
    ...scored(4, 4, 2, 0.9),
    ease: {
      type: "score",
      score: 2,
      confidence: 0.1,
      legend: {},
      probabilities: {},
    },
  };
  const v = await judgeCandidates(
    digest,
    [{ ...candidates[0], option_type: "app", sql_to_run: null }, candidates[1]],
    fakeJev({ ...GOOD, byKey: { a: unsureEase, b: GOOD.byKey.b } }),
  );
  const a = v.order.find((r) => r.key === "a")!;
  assert.ok(a.flags.includes("effort_uncertain"));
  assert.ok(!a.flags.includes("low_confidence"));
  assert.equal(v.headline, "a");
  const unsureFit = {
    ...scored(4, 4, 2, 0.9),
    bottleneck_fit: {
      type: "score",
      score: 4,
      confidence: 0.1,
      legend: {},
      probabilities: {},
    },
  };
  const w = await judgeCandidates(
    digest,
    [{ ...candidates[0], option_type: "app", sql_to_run: null }, candidates[1]],
    fakeJev({ ...GOOD, byKey: { a: unsureFit, b: GOOD.byKey.b } }),
  );
  assert.ok(
    w.order.find((r) => r.key === "a")!.flags.includes("low_confidence"),
  );
  assert.equal(w.headline, null);
});

test("an empty option list is refused clearly, and 'nothing to fix' is a finished result", async () => {
  await assert.rejects(
    () => judgeCandidates(digest, [], fakeJev(GOOD)),
    /no options for Jev/,
  );
  const { nothingToFix } = await import("../lib/jev.ts");
  const v = nothingToFix("No performance problem in this plan.");
  assert.equal(v.headline, null);
  assert.deepEqual(v.flags, ["nothing_to_fix"]);
  assert.equal(v.reason, "No performance problem in this plan.");
});

test("an ops or app option with no SQL is scored safe by rule; one with SQL is still judged", async () => {
  const { ruleDims } = await import("../lib/jev.ts");
  const base = { ...candidates[0], rollback: ["x"] };
  assert.equal(
    ruleDims({ ...base, option_type: "ops", sql_to_run: null }).semantic_safety
      ?.source,
    "rule",
  );
  assert.equal(
    ruleDims({ ...base, option_type: "app", sql_to_run: null }).semantic_safety
      ?.score,
    3,
  );
  assert.deepEqual(
    ruleDims({
      ...base,
      option_type: "ops",
      sql_to_run: "ALTER DATABASE Shop SET READ_COMMITTED_SNAPSHOT ON;",
    }),
    {},
  );
  assert.deepEqual(
    ruleDims({ ...base, option_type: "rewrite", sql_to_run: "SELECT 1" }),
    {},
  );
  assert.equal(
    ruleDims({
      ...base,
      option_type: "ops",
      sql_to_run:
        "SELECT session_id, blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0;",
    }).semantic_safety?.source,
    "rule",
    "a read-only diagnostic on system views cannot change the query's rows",
  );
});

test("a split between two good options still selects Jev's favourite; a lean to 'more evidence' does not", async () => {
  const cross = (probabilities: Record<string, number>, choice: string) => ({
    first_to_run: {
      type: "choice",
      choice,
      confidence: probabilities[choice],
      probabilities,
    },
    anything_worth_running: { type: "noul", noul: 0.9 },
  });
  const both = { a: scored(4, 4, 2, 0.9), b: scored(4, 4, 3, 0.9) };
  const safeB = [
    candidates[0],
    {
      ...candidates[1],
      option_type: "statistics",
      sql_to_run: "UPDATE STATISTICS dbo.Orders;",
    },
  ];
  const split = await judgeCandidates(
    digest,
    safeB,
    fakeJev({
      byKey: both,
      cross: cross({ a: 0.45, b: 0.4, no_suitable_action: 0.15 }, "a"),
    }),
  );
  assert.equal(split.headline, "a");
  assert.ok(split.flags.includes("split_decision"));
  const unsure = await judgeCandidates(
    digest,
    safeB,
    fakeJev({
      byKey: both,
      cross: cross({ a: 0.4, b: 0.2, no_suitable_action: 0.4 }, "a"),
    }),
  );
  assert.equal(
    unsure.headline,
    null,
    "40% on 'collect more evidence' is not a split",
  );
  const weak = await judgeCandidates(
    digest,
    safeB,
    fakeJev({
      byKey: both,
      cross: cross({ a: 0.25, b: 0.24, no_suitable_action: 0.2, c: 0.31 }, "a"),
    }),
  );
  assert.equal(weak.headline, null, "not Jev's favourite");
});

test("statistics are never the first action on an actual plan whose estimates are already right", async () => {
  // From a real report: YEAR(CreationDate) = 2013 scanned 4.2M reads with estimates within 1%, yet Jev
  // picked UPDATE STATISTICS ... WITH FULLSCAN (fit 28%) because it scores safe and easy by rule.
  const accurate = {
    ...digest,
    actual: true,
    rowGuessErrors: [],
    topOperators: [
      {
        ...digest.topOperators[0],
        estRows: 5384900,
        actualRows: 5413518,
        spillLevels: null,
      },
    ],
  };
  const stats = {
    ...candidates[1],
    key: "stats",
    option_type: "statistics",
    sql_to_run: "UPDATE STATISTICS dbo.Posts WITH FULLSCAN;",
  };
  const offered: string[][] = [];
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch: (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.questions.first_to_run)
        offered.push(body.state.options.map((o: any) => o.key));
      const answers = body.questions.first_to_run
        ? {
            first_to_run: {
              type: "choice",
              choice: "a",
              confidence: 0.8,
              probabilities: { a: 0.8, no_suitable_action: 0.2 },
            },
            anything_worth_running: { type: "noul", noul: 0.9 },
          }
        : body.state.candidate.key === "stats"
          ? scored(2, 4, 3, 0.4)
          : scored(4, 3, 2, 0.9);
      return new Response(
        JSON.stringify({ model: "jev", usage: {}, answers }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any,
  });
  const v = await judgeCandidates(
    accurate as any,
    [candidates[0], stats],
    client,
  );
  assert.ok(
    v.order
      .find((r) => r.key === "stats")!
      .flags.includes("estimates_accurate"),
  );
  assert.ok(
    offered.length >= 1 && offered.every((o) => o.join() === "a"),
    "the statistics option is not offered as a first action",
  );
  assert.equal(v.headline, "a");

  // With a real estimate error, the same statistics option is a legitimate candidate.
  const wrong = {
    ...accurate,
    rowGuessErrors: [
      { id: "0", op: "Scan", est: 1, actual: 5000, ratio: 5000 },
    ],
  };
  const v2 = await judgeCandidates(
    wrong as any,
    [candidates[0], stats],
    client,
  );
  assert.ok(
    !v2.order
      .find((r) => r.key === "stats")!
      .flags.includes("estimates_accurate"),
  );
});

test("an option far behind on bottleneck fit is an alternative, not a first action", async () => {
  const weak = {
    ...candidates[1],
    key: "weak",
    option_type: "ops",
    sql_to_run: null,
  };
  const v = await judgeCandidates(
    digest,
    [candidates[0], weak],
    fakeJev({
      byKey: { a: scored(4, 3, 2, 0.9), weak: scored(1, 4, 4, 0.3) },
      cross: {
        first_to_run: {
          type: "choice",
          choice: "a",
          confidence: 0.7,
          probabilities: { a: 0.7, no_suitable_action: 0.3 },
        },
        anything_worth_running: { type: "noul", noul: 0.9 },
      },
    }),
  );
  assert.ok(
    v.order.find((r) => r.key === "weak")!.flags.includes("misses_bottleneck"),
  );
  assert.ok(
    !v.order.find((r) => r.key === "a")!.flags.includes("misses_bottleneck"),
  );
  assert.equal(v.headline, "a");
});

test("the original statement plus only result-preserving hints is safe and easy by rule", async () => {
  const { ruleDims, hintOnlyRewrite } = await import("../lib/jev.ts");
  const original = "SELECT * FROM dbo.Orders o WHERE o.Status = @status";
  assert.ok(hintOnlyRewrite(`${original}\nOPTION (RECOMPILE);`, original));
  assert.ok(
    hintOnlyRewrite(
      `${original} OPTION (USE HINT ('DISABLE_OPTIMIZER_ROWGOAL', 'FORCE_LEGACY_CARDINALITY_ESTIMATION'), MAXDOP 4)`,
      original,
    ),
  );
  assert.ok(
    !hintOnlyRewrite(
      `${original} AND o.Total > 0 OPTION (RECOMPILE)`,
      original,
    ),
    "the query itself changed",
  );
  assert.ok(
    !hintOnlyRewrite(`${original} OPTION (TABLE HINT (o, NOLOCK))`, original),
    "not an allowed hint",
  );
  assert.ok(!hintOnlyRewrite(original, original), "no hint at all");
  const dims = ruleDims(
    {
      ...candidates[0],
      option_type: "rewrite",
      sql_to_run: `${original} OPTION (RECOMPILE);`,
      rejected_reasons: [],
    },
    original,
  );
  assert.equal(dims.semantic_safety?.source, "rule");
  assert.equal(dims.ease?.score, 3);
});

test("the final choice is asked twice and averaged: a coin-flip between two close options settles", async () => {
  let n = 0;
  const both = { a: scored(4, 4, 2, 0.9), b: scored(4, 4, 2, 0.9) };
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch: (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      let answers;
      if (body.questions.first_to_run) {
        n++;
        // Sample 1 leans a (0.52/0.40), sample 2 leans b (0.47/0.45): the average favours a.
        const probabilities =
          n % 2
            ? { a: 0.52, b: 0.4, no_suitable_action: 0.08 }
            : { a: 0.45, b: 0.47, no_suitable_action: 0.08 };
        const choice = probabilities.a >= probabilities.b ? "a" : "b";
        answers = {
          first_to_run: {
            type: "choice",
            choice,
            confidence: probabilities[choice],
            probabilities,
          },
          anything_worth_running: { type: "noul", noul: 0.9 },
        };
      } else answers = both[body.state.candidate.key as "a" | "b"];
      return new Response(
        JSON.stringify({ model: "jev", usage: {}, answers }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as any,
  });
  const safeB = [
    candidates[0],
    {
      ...candidates[1],
      option_type: "statistics",
      sql_to_run: "UPDATE STATISTICS dbo.Orders;",
    },
  ];
  const v = await judgeCandidates(digest, safeB, client);
  assert.equal(n, 2, "two samples of the final choice");
  assert.equal(v.jev_pick, "a");
  assert.ok(Math.abs(v.jev_probabilities!.a - 0.485) < 1e-9);
});
