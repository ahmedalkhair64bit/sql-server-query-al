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

  const bad = {
    byKey: { a: scored(4, 1, 2, 1), b: GOOD.byKey.b },
    cross: GOOD.cross,
  };
  const v2 = await judgeCandidates(digest, idxOnly, fakeJev(bad));
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
