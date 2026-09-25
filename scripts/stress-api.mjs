// End-to-end stress test of the analysis pipeline against the built app and the controlled providers:
// concurrent analyses, concurrent large uploads, provider faults (HTTP 500, prose, truncated JSON, too few
// options, Jev down, Jev hanging), client disconnects and double-clicked "Retry Jev".
//
//   npm run build && npm run stress:api [-- --concurrency 20]
//
// It starts its own mock providers and app on port 3300 with a throwaway database; nothing is shared with
// a real installation.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const CONCURRENCY = arg("--concurrency", 20);
const PORT = 3300;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "qai-stress-api-"));
const SECRET = "stress-test-secret-value";
const env = {
  ...process.env,
  DATA_DIR: DATA,
  APP_SECRET: SECRET,
  TYPESAFE_BASE_URL: "http://127.0.0.1:18889",
};

const procs = [];
const start = (cmd, args) => {
  const p = spawn(cmd, args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  procs.push(p);
  return p;
};
const stopAll = () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", stopAll);
const waitFor = async (url) => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
};
start("node", ["scripts/qa-providers.mjs"]);
const app = start("npx", ["next", "start", "-p", String(PORT)]);
await waitFor("http://127.0.0.1:18889/health");
await waitFor(`${BASE}/api/healthz`);

// A user, configured models and a session, written straight into the app's database.
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = SECRET;
const db = await import("../lib/db.ts");
const { saveModelSettings } = await import("../lib/settings.ts");
const user = db.createUser(`stress${Date.now()}@qai.test`, "x");
const fd = new FormData();
for (const [k, v] of Object.entries({
  analyst_base_url: "http://127.0.0.1:18889/v1",
  analyst_key: "qa-controlled-key",
  analyst_model: "qa-controlled-model",
  analyst_extra: "{}",
  jev_key: "qa-controlled-key",
  jev_model: "jev-latest",
}))
  fd.set(k, v);
saveModelSettings(user, fd);
const token = randomBytes(32).toString("hex");
db.putSession(
  createHash("sha256").update(token).digest("hex"),
  user,
  Date.now() + 864e5,
);
const cookie = `qai_s=${token}`;

const upload = async (body, name = "stress.sqlplan") => {
  const r = await fetch(`${BASE}/api/plans`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/octet-stream",
      "x-plan-name": name,
    },
    body,
    duplex: "half",
  });
  return { status: r.status, data: await r.json() };
};
// Runs one analysis and reads the event stream to the end.
async function analyze(plan, note = "", { abortAfterMs } = {}) {
  const started = performance.now();
  const ac = new AbortController();
  if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs);
  const events = {};
  try {
    const r = await fetch(`${BASE}/api/analyze`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        planId: plan.id,
        statementId: plan.recommended,
        note,
      }),
      signal: ac.signal,
    });
    if (!r.ok)
      return {
        http: r.status,
        ms: performance.now() - started,
        error: (await r.json()).error,
      };
    const text = await r.text();
    for (const block of text.split("\n\n")) {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events[ev] = JSON.parse(data);
    }
  } catch (e) {
    return {
      aborted: e.name === "AbortError",
      ms: performance.now() - started,
      id: events.created?.id,
    };
  }
  return {
    ms: performance.now() - started,
    id: events.created?.id,
    verdict: events.verdict?.status,
    error: events.error?.message,
  };
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(
    s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))],
  );
};
const rss = () => {
  try {
    const kids = readFileSync(
      `/proc/${app.pid}/task/${app.pid}/children`,
      "utf8",
    )
      .trim()
      .split(/\s+/);
    return Math.max(
      ...[app.pid, ...kids].map((pid) => {
        try {
          return (
            Number(
              /VmRSS:\s+(\d+)/.exec(
                readFileSync(`/proc/${pid}/status`, "utf8"),
              )?.[1] ?? 0,
            ) / 1024
          );
        } catch {
          return 0;
        }
      }),
    );
  } catch {
    return NaN;
  }
};

const report = [];
const check = (name, pass, detail) => {
  report.push({ scenario: name, result: pass ? "pass" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};

const sample = readFileSync("fixtures/eval/key-lookup.sqlplan");
const plan = (await upload(sample)).data;

// 1. Concurrent analyses.
{
  const runs = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => analyze(plan, "stress run")),
  );
  const ok = runs.filter((r) => r.verdict);
  const ms = runs.map((r) => r.ms);
  check(
    `${CONCURRENCY} concurrent analyses`,
    ok.length === CONCURRENCY,
    `${ok.length}/${CONCURRENCY} reached a verdict; p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${pct(ms, 100)} ms; app RSS ${Math.round(rss())} MB`,
  );
}

// 2. Concurrent 30 MB uploads: two are processed at a time, the rest are told to retry.
{
  const big = Buffer.concat([
    Buffer.from("<ShowPlanXML><BatchSequence><Batch><Statements>"),
    Buffer.from(
      // 20,000 statements of ~1.5 KB: large, but inside the 100,000-statement cap.
      Array.from(
        { length: 20000 },
        (_, i) =>
          `<StmtSimple StatementText="SELECT ${i} /* ${"x".repeat(1300)} */" StatementSubTreeCost="${i % 50}"><QueryPlan><RelOp NodeId="0" PhysicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="1"/></QueryPlan></StmtSimple>`,
      ).join(""),
    ),
    Buffer.from("</Statements></Batch></BatchSequence></ShowPlanXML>"),
  ]);
  const started = performance.now();
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => upload(big, "big.sqlplan")),
  );
  const statuses = rs.map((r) => r.status);
  for (const r of rs)
    if (r.status !== 200 && r.status !== 429)
      console.log("  upload error:", r.data.error);
  const health = await fetch(`${BASE}/api/healthz`).then((r) => r.status);
  check(
    `5 concurrent ${Math.round(big.length / 1e6)} MB uploads`,
    statuses.filter((s) => s === 200).length >= 2 &&
      statuses.every((s) => s === 200 || s === 429) &&
      health === 200,
    `statuses ${statuses.join(", ")} in ${Math.round(performance.now() - started)} ms; health ${health}`,
  );
}

// 3. Provider faults: each must end in a clear error or an honest "no winner" verdict, never a hang.
const FAULTS = [
  ["analyst-500", (r) => /HTTP 500/.test(r.error ?? ""), "analyst HTTP 500"],
  [
    "analyst-garbage",
    (r) => /prose instead of JSON/.test(r.error ?? ""),
    "analyst answers in prose",
  ],
  [
    "analyst-truncated",
    (r) => /stopped after \d+ characters/.test(r.error ?? ""),
    "analyst JSON cut off",
  ],
  [
    "analyst-one-option",
    (r) => /Insufficient evidence/.test(r.error ?? ""),
    "analyst declines",
  ],
  [
    "jev-500",
    (r) => r.verdict === "unavailable" || r.verdict === "abstained",
    "Jev HTTP 500",
  ],
  [
    "jev-slow",
    (r) => r.verdict === "unavailable" || r.verdict === "abstained",
    "Jev hangs",
  ],
];
for (const [fault, ok, label] of FAULTS) {
  const r = await analyze(plan, `qa-fault:${fault}`);
  check(
    `fault: ${label}`,
    ok(r),
    `${r.error ?? `verdict ${r.verdict}`} after ${Math.round(r.ms)} ms`,
  );
}

// 4. Client disconnects mid-analysis: the run is marked abandoned, not left "running".
{
  const r = await analyze(plan, "qa slow", { abortAfterMs: 1500 });
  await new Promise((res) => setTimeout(res, 1500));
  const row = db.db
    .prepare(
      "SELECT status FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(user);
  check(
    "client disconnects mid-analysis",
    r.aborted && row?.status === "abandoned",
    `stored status "${row?.status}"`,
  );
}

// 5. Double-clicked "Retry Jev": the second request is refused while the first runs.
{
  const done = await analyze(plan, "retry target");
  const hit = () =>
    fetch(`${BASE}/api/analyses/${done.id}/jev`, {
      method: "POST",
      headers: { cookie },
    }).then((r) => r.status);
  const statuses = await Promise.all([hit(), hit()]);
  check(
    "double-clicked Retry Jev",
    statuses.includes(200) && statuses.includes(409),
    `statuses ${statuses.join(", ")}`,
  );
}

console.table(report);
stopAll();
rmSync(DATA, { recursive: true, force: true });
writeFileSync(
  join(tmpdir(), "qai-stress-api.json"),
  JSON.stringify(report, null, 2),
);
process.exit(report.some((r) => r.result === "FAIL") ? 1 : 0);
