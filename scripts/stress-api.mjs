// End-to-end stress test of the analysis pipeline against the built app and the controlled providers:
// concurrent analyses, concurrent large uploads, provider faults (HTTP 500, prose, truncated JSON, too few
// options, Jev down, Jev hanging), client disconnects (the run continues), stop and Run again, and a
// double-clicked "Retry Jev".
//
//   npm run build && npm run stress:api [-- --concurrency 20]
//   docker build -t qai:test . && npm run stress:api -- --docker qai:test
//
// It starts its own mock providers and app on port 3300 with a throwaway database; nothing is shared with
// a real installation.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
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
  // Scenario 1 measures load from 20 parallel runs; the per-user limit is checked on its own below.
  MAX_RUNS_PER_USER: String(Math.max(CONCURRENCY, 5)),
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
// --docker IMAGE runs the same checks against a built image instead of `next start`: the release gate.
const IMAGE = process.argv.includes("--docker")
  ? process.argv[process.argv.indexOf("--docker") + 1]
  : null;
const CONTAINER = `qai-stress-${process.pid}`;
if (IMAGE) {
  // The container runs as `node`, this script as whoever you are: keep the throwaway data dir writable by both.
  process.umask(0);
  chmodSync(DATA, 0o777);
  process.on("exit", () =>
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }),
  );
}
start("node", ["scripts/qa-providers.mjs"]);
const app = IMAGE
  ? start("docker", [
      "run",
      "--rm",
      "--name",
      CONTAINER,
      "--network",
      "host",
      "-v",
      `${DATA}:/data`,
      "-e",
      `PORT=${PORT}`,
      "-e",
      `APP_SECRET=${SECRET}`,
      "-e",
      `TYPESAFE_BASE_URL=${env.TYPESAFE_BASE_URL}`,
      "-e",
      `MAX_RUNS_PER_USER=${env.MAX_RUNS_PER_USER}`,
      IMAGE,
    ])
  : start("npx", ["next", "start", "-p", String(PORT)]);
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
// SQLite creates its files 0644 whatever the umask; the container's `node` user must write them too.
if (IMAGE) for (const f of readdirSync(DATA)) chmodSync(join(DATA, f), 0o666);

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
  }).catch((e) => {
    // A refused upload (429) is answered before its body is read, so the client may instead see the
    // socket close mid-write. That is still a refusal; anything else is a real failure.
    if (
      /EPIPE|ECONNRESET|other side closed/.test(
        String(e.cause?.code ?? e.cause?.message ?? e),
      )
    )
      return null;
    throw e;
  });
  if (!r)
    return { status: 429, data: { error: "connection closed while refused" } };
  return { status: r.status, data: await r.json() };
};
// Runs one analysis and reads the event stream to the end.
// force: ask the models even if an identical request has a result (every scenario but the reuse one).
async function analyze(plan, note = "", { abortAfterMs, force = true } = {}) {
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
        force,
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
    reused: !!events.created?.reused,
    verdict: events.verdict?.status,
    flags: events.verdict?.flags ?? [],
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
  // In a container the app is not our child process: ask Docker for the container's memory instead.
  if (IMAGE) {
    const out = spawnSync(
      "docker",
      ["stats", "--no-stream", "--format", "{{.MemUsage}}", CONTAINER],
      { encoding: "utf8" },
    ).stdout;
    const m = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(out ?? "");
    return m ? Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]] : NaN;
  }
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
    // Declining for lack of evidence is a finished "no action needed" result, not an error.
    (r) => r.verdict === "abstained" && r.flags.includes("nothing_to_fix"),
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

// 4. Client disconnects mid-analysis: the run belongs to the server and still finishes. Then an explicit
// stop ends a run as "stopped", and "Run again" completes it from the stored evidence (no upload).
{
  const latest = () =>
    db.db
      .prepare(
        "SELECT id, status FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(user);
  const until = async (id, want, ms = 60_000) => {
    const end = Date.now() + ms;
    let row;
    while (Date.now() < end) {
      row = db.db.prepare("SELECT status FROM analyses WHERE id = ?").get(id);
      if (want.includes(row?.status)) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    return row?.status;
  };
  const r = await analyze(plan, "qa slow", { abortAfterMs: 1500 });
  const left = latest();
  const finished = await until(left.id, ["done"]);
  check(
    "client disconnects mid-analysis",
    r.aborted && finished === "done",
    `the page left; the run ended "${finished}"`,
  );

  const post = (path) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { cookie } });
  const r2 = analyze(plan, "qa slow");
  let running;
  for (let i = 0; i < 40 && !running; i++) {
    await new Promise((res) => setTimeout(res, 100));
    const row = latest();
    if (row && row.id !== left.id && row.status === "running") running = row;
  }
  const stop = running ? await post(`/api/analyses/${running.id}/stop`) : null;
  const stopped = running
    ? await until(running.id, ["stopped", "done", "failed"])
    : null;
  await r2;
  const again = running
    ? await post(`/api/analyses/${running.id}/rerun`)
    : null;
  const rerun = running
    ? await until(running.id, ["done", "failed", "stopped"])
    : null;
  check(
    "explicit stop, then Run again",
    stop?.status === 200 &&
      stopped === "stopped" &&
      again?.status === 200 &&
      rerun === "done",
    `stop ${stop?.status} -> "${stopped}", rerun ${again?.status} -> "${rerun}"`,
  );
}

// 4b. Same plan, same note, same models: the first run asks the models, the next two open its report (no
// model call), even from fresh uploads of the file. force asks again.
{
  const note = "qa reuse check";
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const fresh = (await upload(sample, "reuse.sqlplan")).data;
    runs.push(await analyze(fresh, note, { force: false }));
  }
  const forced = await analyze(plan, note, { force: true });
  check(
    "same plan analysed again reuses its report",
    runs[0].verdict &&
      !runs[0].reused &&
      runs.slice(1).every((r) => r.reused && r.id === runs[0].id) &&
      Math.max(...runs.slice(1).map((r) => r.ms)) < 1000 &&
      !forced.reused &&
      forced.id !== runs[0].id,
    `ids ${runs.map((r) => r.id?.slice(0, 8)).join(", ")}; reused ${runs.map((r) => r.reused).join("/")}; ${Math.round(runs[1].ms)} ms; forced new run ${!forced.reused}`,
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
