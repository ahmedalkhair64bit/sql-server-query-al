import test from "node:test";
import assert from "node:assert/strict";
const { proposeCandidates, extractJson, AnalystError } =
  await import("../lib/analyst.ts");

const cfg = {
  baseUrl: "https://api.test/v1",
  apiKey: "k",
  model: "m",
  extra: {},
};
const digest = {
  sql: "SELECT 1",
  bytes: 8,
  subtreeCost: 1,
  parallel: false,
  nonParallelReason: null,
  earlyAbort: null,
  tables: ["t"],
  topOperators: [],
  rowGuessErrors: [],
  missingIndexes: [],
  warnings: [],
  waits: [],
} as any;
const ok = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});
const CANDS = {
  candidates: [
    {
      key: "idx_customer",
      title: "Covering index",
      diagnosis: "Scan of 1.2M rows on Sales.Orders, no key on CustomerId.",
      actions: [
        {
          title: "Create index",
          detail: "CREATE INDEX ...",
          effort: "medium",
          requires_change_control: true,
        },
      ],
      option_type: "index",
      sql_to_run:
        "CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId] ON [dbo].[Orders] ([CustomerId]);",
      expected: "seek instead of scan",
    },
    {
      key: "rewrite_split",
      title: "Split the statement",
      diagnosis: "One statement scans everything then filters.",
      actions: [
        {
          title: "Deploy rewrite",
          detail: "Two statements",
          effort: "high",
          requires_change_control: true,
        },
      ],
      option_type: "rewrite",
      sql_to_run: "SELECT ...",
      expected: "far fewer logical reads",
    },
  ],
};

test("returns schema-valid candidates", async () => {
  const got = await proposeCandidates(
    cfg,
    digest,
    "",
    async () => ok(JSON.stringify(CANDS)) as any,
  );
  assert.equal(got.length, 2);
  assert.equal(got[0].key, "idx_customer");
});
test("survives code fences and sends extra params", async () => {
  let sent: any;
  const fetchImpl = async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return ok("```json\n" + JSON.stringify(CANDS) + "\n```") as any;
  };
  const got = await proposeCandidates(
    { ...cfg, extra: { temperature: 0.1 } },
    digest,
    "index exists already",
    fetchImpl as any,
  );
  assert.equal(got.length, 2);
  assert.equal(sent.temperature, 0.1);
  assert.match(sent.messages[0].content, /candidates/);
  assert.match(sent.messages[1].content, /index exists already/);
});
test("names the stage on auth, prose, and shape failures", async () => {
  await assert.rejects(
    () =>
      proposeCandidates(
        cfg,
        digest,
        "",
        async () =>
          ({ ok: false, status: 401, text: async () => "bad key" }) as any,
      ),
    (e: any) => e instanceof AnalystError && /401/.test(e.message),
  );
  await assert.rejects(
    () =>
      proposeCandidates(cfg, digest, "", async () => ok("no json here") as any),
    AnalystError,
  );
  await assert.rejects(
    () =>
      proposeCandidates(
        cfg,
        digest,
        "",
        async () =>
          ok(JSON.stringify({ candidates: [CANDS.candidates[0]] })) as any,
      ),
    (e: any) => /at least 2/i.test(e.message),
  );
});
test("extractJson copes with fences and chatter", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('noise {"a":1} noise'), { a: 1 });
});

test("a response cut off mid-JSON says it was cut off", async () => {
  // With every option required to carry runnable T-SQL, the candidates payload outgrew the old 2048-token
  // budget and the user was told "malformed JSON" after 38 seconds of nothing useful.
  const { extractJson, AnalystError } = await import("../lib/analyst.ts");
  const truncated =
    '{"candidates":[{"key":"a","title":"x","diagnosis":"y","actions":[{"title":"t","detail":"d","effort":"low","requires_change_control":false}],"option_type":"index","sql_to_run":"CREATE INDEX [IX_a] ON [dbo].[a] ([b]);","expected":"see';
  let err: unknown = null;
  try {
    extractJson(truncated);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AnalystError, String(err));
  assert.match((err as Error).message, /stopped after \d+ characters/);
  assert.doesNotThrow(() => extractJson('{"a":1}'));
});

test("the candidate call leaves the model room to finish the JSON", async () => {
  const { proposeCandidates } = await import("../lib/analyst.ts");
  const calls: any[] = [];
  const fetchImpl = async (_u: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const two = {
      candidates: [0, 1].map((i) => ({
        key: "k" + i,
        title: "Covering index " + i,
        diagnosis: "full scan of dbo.Orders",
        actions: [
          {
            title: "Create the index",
            detail: "in the reporting DB off-peak",
            effort: "low",
            requires_change_control: false,
          },
        ],
        option_type: "index",
        sql_to_run: "CREATE INDEX [IX_a] ON [dbo].[a] ([b]);",
        expected: "fewer reads",
      })),
    };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(two) } }],
      }),
    } as any;
  };
  const digest = {
    sql: "SELECT 1",
    bytes: 100,
    subtreeCost: 1,
    parallel: false,
    nonParallelReason: null,
    earlyAbort: null,
    tables: ["dbo.Orders"],
    topOperators: [],
    rowGuessErrors: [],
    missingIndexes: [],
    warnings: [],
    waits: [],
  };
  const cfg = { baseUrl: "http://x/v1", apiKey: "k", model: "m", extra: {} };
  await proposeCandidates(cfg as any, digest as any, "", fetchImpl as any);
  assert.ok(
    calls[0].max_tokens >= 4096,
    `max_tokens was ${calls[0].max_tokens}`,
  );
  // extra params still win: that is how a user raises the ceiling without a rebuild.
  await proposeCandidates(
    { ...cfg, extra: { max_tokens: 8192 } } as any,
    digest as any,
    "",
    fetchImpl as any,
  );
  assert.equal(calls[1].max_tokens, 8192);
});

test("placeholder SQL never reaches the report as if it were runnable", async () => {
  // On a plan whose query text is 100 KB the model cannot reproduce the statement, and it offered
  // "SELECT ... FROM ... OPTION (MAXDOP 1);" as a rewrite. A block that cannot be pasted is worse than no block.
  const { dropPlaceholderSql } = await import("../lib/analyst.ts");
  const cands = [
    {
      key: "hint_maxdop",
      option_type: "rewrite",
      sql_to_run: "SELECT ... FROM dbo.T OPTION (MAXDOP 1);",
    },
    {
      key: "idx",
      option_type: "index",
      sql_to_run: "CREATE INDEX [IX_T_A] ON [dbo].[T] ([A]);",
    },
    { key: "ops", option_type: "ops", sql_to_run: null },
  ];
  const out = dropPlaceholderSql(cands as any);
  assert.equal(
    out[0].sql_to_run,
    null,
    "the ellipsis rewrite should not survive",
  );
  assert.equal(out[1].sql_to_run, "CREATE INDEX [IX_T_A] ON [dbo].[T] ([A]);");
  assert.equal(out[2].sql_to_run, null);
});

test("the digest tells the model when the query text was cut", async () => {
  const { digestForModel } = await import("../lib/digest.ts");
  const base = {
    bytes: 1,
    subtreeCost: null,
    parallel: false,
    nonParallelReason: null,
    earlyAbort: null,
    tables: [],
    topOperators: [],
    rowGuessErrors: [],
    missingIndexes: [],
    warnings: [],
    waits: [],
  };
  assert.equal(
    digestForModel({ ...base, sql: "SELECT 1" } as any).sql_truncated,
    false,
  );
  assert.equal(
    digestForModel({ ...base, sql: "SELECT 1" + " ".repeat(5000) } as any)
      .sql_truncated,
    true,
  );
});

test("invalid evidence, incomplete rewrites and missing verification remain rejected", async () => {
  const modern = {
    ...digest,
    version: 2,
    sql: "SELECT " + "x".repeat(5000),
    evidence: [{ id: "s1:statement", kind: "statement", value: {} }],
  };
  const got = await proposeCandidates(
    cfg,
    modern,
    "",
    async () => ok(JSON.stringify(CANDS)) as any,
  );
  assert.ok(got[0].rejected_reasons.length);
  assert.ok(got[1].rejected_reasons.some((r) => r.includes("Complete SQL")));
  assert.equal(got[1].sql_to_run, null);
});
test("duplicate candidate keys cannot reach Jev", async () => {
  await assert.rejects(
    () =>
      proposeCandidates(
        cfg,
        digest,
        "",
        async () =>
          ok(
            JSON.stringify({
              candidates: [CANDS.candidates[0], CANDS.candidates[0]],
            }),
          ) as any,
      ),
    /duplicate/,
  );
});

test("single-paragraph guidance is normalized without losing content", async () => {
  const options = CANDS.candidates.map((c) => ({
    ...c,
    prerequisites: "Confirm the target database.",
    validation: "Compare results and logical reads.",
    rollback: "Restore the original reviewed configuration.",
  }));
  const got = await proposeCandidates(
    cfg,
    digest,
    "",
    async () => ok(JSON.stringify({ candidates: options })) as any,
  );
  assert.deepEqual(got[0].rollback, [
    "Restore the original reviewed configuration.",
  ]);
  assert.deepEqual(got[0].validation, ["Compare results and logical reads."]);
});

test("a cut-off JSON answer is reported as cut off, not as prose", async () => {
  const { extractJson, AnalystError } = await import("../lib/analyst.ts");
  assert.throws(
    () => extractJson('{"candidates":[{"key":"idx","title":"Cov'),
    (e: unknown) =>
      e instanceof AnalystError &&
      /stopped after \d+ characters/.test((e as Error).message),
  );
  assert.throws(
    () => extractJson("I would add an index."),
    /prose instead of JSON/,
  );
});

test("a cut-off answer is retried once with a larger response limit", async () => {
  const { proposeCandidates } = await import("../lib/analyst.ts");
  const limits: number[] = [];
  const good = JSON.stringify({ candidates: CANDS.candidates });
  const fake = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    limits.push(body.max_tokens);
    const cut = limits.length === 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: cut ? "" : good },
            finish_reason: cut ? "length" : "stop",
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const out = await proposeCandidates(
    { ...cfg, extra: { max_tokens: 16000 } },
    digest,
    "",
    fake,
  );
  assert.deepEqual(limits, [16000, 32000]);
  assert.ok(out.length >= 2);
  const always = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      }),
    )) as unknown as typeof fetch;
  await assert.rejects(
    () => proposeCandidates(cfg, digest, "", always),
    /spent its whole response budget \(32,000 tokens\) reasoning/,
  );
});

test("the default limit retries at 32,000; a model that rejects it still gets the cut-off message", async () => {
  const { proposeCandidates } = await import("../lib/analyst.ts");
  const limits: number[] = [];
  const fake = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    limits.push(body.max_tokens);
    if (body.max_tokens > 16384)
      return new Response(
        JSON.stringify({ error: { message: "max_tokens is too large" } }),
        { status: 400 },
      );
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: '{"candidates": [' }, finish_reason: "length" },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => proposeCandidates({ ...cfg, extra: {} }, digest, "", fake),
    /cut off at the response-length limit \(4,096 tokens\)/,
  );
  assert.deepEqual(limits, [4096, 32000]);
});
