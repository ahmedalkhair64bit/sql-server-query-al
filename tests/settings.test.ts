import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.APP_SECRET ??= "settings-test-secret-value";
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/qai-settings-`);
const db = await import("../lib/db.ts");
const s = await import("../lib/settings.ts");
const { testAnalyst, testJev, analystFingerprint } =
  await import("../lib/connection.ts");
const { providerFor } = await import("../lib/providers.ts");
const { TypeSafeClient } = await import("@typesafe-ai/sdk");

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const full = {
  analyst_base_url: "https://api.example.com/v1/",
  analyst_key: "sk-test-1234",
  analyst_model: "gpt-x",
  analyst_extra: "{}",
  jev_key: "ts-5678",
  jev_model: "jev-latest",
};

test("onboarding refuses an incomplete configuration and names what is missing", () => {
  const u = db.createUser("onb@x.y", "h");
  const r = s.saveModelSettings(
    u,
    form({ ...full, analyst_key: "", jev_key: "" }),
    { require: true },
  );
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /analyst API key.*TypeSafe/);
  assert.equal(db.getSettings(u), null, "nothing saved");
  assert.equal(s.saveModelSettings(u, form(full), { require: true }).ok, true);
  assert.equal(
    s.settingsView(u).has_analyst && s.settingsView(u).has_jev,
    true,
  );
});

test("bad URLs and placeholder Azure URLs are refused", () => {
  const u = db.createUser("url@x.y", "h");
  assert.equal(
    s.saveModelSettings(
      u,
      form({ ...full, analyst_base_url: "api.example.com" }),
    ).ok,
    false,
  );
  assert.equal(
    s.saveModelSettings(
      u,
      form({
        ...full,
        analyst_base_url: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
      }),
    ).ok,
    false,
  );
});

test("the reasoning switch and response length round-trip through the stored JSON", () => {
  const f = form({
    analyst_extra: '{"temperature":0.2,"chat_template_kwargs":{"foo":1}}',
    max_tokens: "8192",
  });
  f.set("thinking_off", "on");
  const extra = s.extraFromForm(f);
  assert.deepEqual(extra, {
    temperature: 0.2,
    chat_template_kwargs: { foo: 1, enable_thinking: false },
    max_tokens: 8192,
  });
  const back = s.extraForForm(JSON.stringify(extra));
  assert.equal(back.thinkingOff, true);
  assert.equal(back.maxTokens, 8192);
  assert.deepEqual(JSON.parse(back.raw), {
    temperature: 0.2,
    chat_template_kwargs: { foo: 1 },
  });
  // Unticking removes only what the switch added.
  const off = s.extraFromForm(form({ analyst_extra: back.raw }));
  assert.deepEqual(off, { temperature: 0.2, chat_template_kwargs: { foo: 1 } });
  assert.throws(
    () => s.extraFromForm(form({ analyst_extra: "[1]" })),
    /JSON object/,
  );
  assert.throws(
    () => s.extraFromForm(form({ max_tokens: "12" })),
    /between 256/,
  );
});

test("a connection status only counts for the settings it tested", () => {
  const u = db.createUser("status@x.y", "h");
  s.saveModelSettings(u, form(full));
  const cfg = s.analystConfig(u)!;
  db.setModelStatus(
    u,
    "analyst",
    JSON.stringify({
      ok: true,
      ms: 5,
      message: "",
      fingerprint: analystFingerprint(cfg),
      at: 1,
    }),
  );
  assert.equal(s.settingsView(u).analyst_status?.ok, true);
  assert.equal(s.modelHealth(u), "untested", "Jev not tested yet");
  s.saveModelSettings(
    u,
    form({ ...full, analyst_model: "another-model", analyst_key: "" }),
  );
  assert.equal(
    s.settingsView(u).analyst_status,
    null,
    "changing the model makes the old test stale",
  );
  db.setModelStatus(
    u,
    "jev",
    JSON.stringify({
      ok: false,
      ms: 5,
      message: "no",
      fingerprint: "jev-latest|5678",
      at: 1,
    }),
  );
  assert.equal(s.modelHealth(u), "failed");
});

test("with query text withheld, models get plan evidence but no SQL, and rewrites are off", async () => {
  const u = db.createUser("priv@x.y", "h");
  s.saveModelSettings(u, form(full));
  const { parsePlanText } = await import("../lib/plan-parser.mjs");
  const { readFileSync } = await import("node:fs");
  const d = parsePlanText(
    readFileSync("fixtures/eval/key-lookup.sqlplan", "utf8"),
  )[0];
  assert.equal(s.digestForModels(u, d), d, "sent by default");
  const f = form(full);
  f.set("send_sql_present", "1"); // checkbox absent = off
  s.saveModelSettings(u, f);
  const m = s.digestForModels(u, d);
  assert.equal(m.sql, "");
  const { digestForModel } = await import("../lib/digest.ts");
  const view = digestForModel(m);
  assert.equal(view.sql_truncated, true);
  assert.ok(view.coverage.some((c) => /withheld/.test(c)));
  assert.ok(
    view.evidence.some((e) => e.kind === "operator"),
    "operators still sent",
  );
  assert.equal(d.sql.length > 0, true, "the stored digest keeps its SQL");
});

// ---- connection tests with a fake provider ----
const cfg = {
  baseUrl: "https://p.example/v1",
  apiKey: "sk-abcd",
  model: "m1",
  extra: { max_tokens: 50 },
};
const fake = (
  status: number,
  body: unknown,
  models: unknown = { data: [{ id: "m1" }, { id: "m2" }] },
) =>
  (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/models"))
      return new Response(JSON.stringify(models), { status: 200 });
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.model, "m1");
    assert.equal(
      sent.max_tokens,
      50,
      "the user's extra params are part of the test",
    );
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  }) as typeof fetch;

test("a working analyst reports its latency and the models the key can use", async () => {
  const r = await testAnalyst(
    cfg,
    fake(200, { choices: [{ message: { content: "OK" } }] }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["m1", "m2"]);
  assert.equal(r.fingerprint, "https://p.example/v1|m1|abcd");
});
test("analyst failures say what to fix", async () => {
  const bad = await testAnalyst(
    cfg,
    fake(401, { error: { message: "Incorrect API key provided" } }),
  );
  assert.match(
    bad.message,
    /API key was rejected \(HTTP 401\).*Incorrect API key/,
  );
  assert.match(
    (await testAnalyst(cfg, fake(404, "{}"))).message,
    /base URL.*model name/,
  );
  assert.match(
    (await testAnalyst(cfg, fake(429, "{}"))).message,
    /Rate limited/,
  );
  assert.match(
    (await testAnalyst(cfg, fake(200, "<html>login</html>"))).message,
    /not with an OpenAI-compatible/,
  );
  const down = await testAnalyst(cfg, (async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: new Error("getaddrinfo ENOTFOUND p.example"),
    });
  }) as typeof fetch);
  assert.match(
    down.message,
    /Could not reach https:\/\/p\.example\/v1: getaddrinfo ENOTFOUND/,
  );
});
test("Jev test passes on a judgment and explains a rejected key", async () => {
  const client = (status: number) =>
    new TypeSafeClient({
      apiKey: "k",
      retry: { maxRetries: 0 },
      fetch: (async () =>
        status === 200
          ? new Response(
              JSON.stringify({
                model: "jev",
                usage: {},
                answers: { alive: { type: "noul", noul: 0.99 } },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response(JSON.stringify({ error: { message: "bad key" } }), {
              status,
              headers: { "content-type": "application/json" },
            })) as typeof fetch,
    });
  assert.equal((await testJev("ts-1234", "jev-latest", client(200))).ok, true);
  const r = await testJev("ts-1234", "jev-latest", client(401));
  assert.equal(r.ok, false);
  assert.match(r.message, /TypeSafe API key was rejected/);
});

test("provider presets are recognised from a saved URL", () => {
  assert.equal(providerFor("https://api.openai.com/v1").id, "openai");
  assert.equal(
    providerFor("https://generativelanguage.googleapis.com/v1beta/openai").id,
    "gemini",
  );
  assert.equal(
    providerFor("https://acme.openai.azure.com/openai/v1").id,
    "azure",
  );
  assert.equal(
    providerFor("http://host.docker.internal:11434/v1").id,
    "ollama",
  );
  assert.equal(providerFor("https://llm.internal.corp/v1").id, "custom");
});

test("a password change keeps this session and drops the others", () => {
  const u = db.createUser("pw@x.y", "h");
  db.putSession("mine", u, Date.now() + 1e6);
  db.putSession("laptop", u, Date.now() + 1e6);
  db.dropOtherSessions(u, "mine");
  assert.equal(db.sessionUserId("mine"), u);
  assert.equal(db.sessionUserId("laptop"), null);
});
