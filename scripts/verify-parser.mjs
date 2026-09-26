// Checks lib/plan-parser.mjs against an independent reading of the same plans (scripts/verify-parser.py,
// Python's ElementTree), field by field. The analysis is only as good as the evidence the models receive, so
// every number the digest gives them must match the plan.
//
//   node scripts/verify-parser.mjs <folder or .sqlplan files...> [--verbose]
//
// Exit code 1 when any field disagrees.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePlanText } from "../lib/plan-parser.mjs";
import { decodeBytes } from "../lib/plan-decoder.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const verbose = process.argv.includes("--verbose");
const walk = (p) =>
  statSync(p).isDirectory()
    ? readdirSync(p).flatMap((f) => walk(join(p, f)))
    : /\.(sqlplan|xml)$/i.test(p)
      ? [p]
      : [];
const files = args.flatMap(walk);

// Relative tolerance for floats the plan itself rounds (costs are printed to ~6 significant digits).
const close = (a, b, rel = 1e-4) =>
  a == null || b == null
    ? a == b
    : Math.abs(a - b) <= Math.max(1e-6, rel * Math.max(Math.abs(a), Math.abs(b)));
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

const problems = [];
let statementsChecked = 0,
  operatorsChecked = 0,
  fieldsChecked = 0;
const bad = (file, where, field, ours, truth) =>
  problems.push({ file, where, field, ours, truth });

for (const file of files) {
  const short = file.split("/").slice(-2).join("/");
  const truth = execFileSync("python3", ["scripts/verify-parser.py", file], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  if (truth.some((t) => t.error)) {
    bad(short, "file", "xml", "parsed", truth[0].error);
    continue;
  }
  const ours = parsePlanText(decodeBytes(readFileSync(file)));
  // Match statements by their text (our ids are sequential, the plan's StatementId need not be), in order.
  const unused = [...ours];
  const take = (t) => {
    const key = norm(t.sql).slice(0, 120);
    const i = unused.findIndex(
      (d) =>
        norm(d.sql).slice(0, 120) === key ||
        (d.sqlTruncated && key.startsWith(norm(d.sql).slice(0, 60))),
    );
    return i === -1 ? null : unused.splice(i, 1)[0];
  };
  for (const t of truth) {
    const d = take(t);
    const where = `statement ${t.statementId}`;
    if (!d) {
      bad(short, where, "statement", "missing", t.type);
      continue;
    }
    statementsChecked++;
    const check = (field, a, b, ok) => {
      fieldsChecked++;
      if (!ok) bad(short, where, field, a, b);
    };
    // SQL text: the digest may truncate long statements and says so.
    const sql = norm(d.sql),
      tsql = norm(t.sql);
    check(
      "sql",
      sql.slice(0, 80),
      tsql.slice(0, 80),
      d.sqlTruncated ? tsql.startsWith(sql.replace(/…$/, "").trim().slice(0, 200)) : sql === tsql,
    );
    check("subtreeCost", d.subtreeCost, t.cost, close(d.subtreeCost, t.cost));
    check("operatorCount", d.operatorCount, t.operators.length, d.operatorCount === t.operators.length);
    check("cpuMs", d.queryTime?.cpuMs ?? null, t.cpuMs, (d.queryTime?.cpuMs ?? null) == t.cpuMs);
    check(
      "elapsedMs",
      d.queryTime?.elapsedMs ?? null,
      t.elapsedMs,
      (d.queryTime?.elapsedMs ?? null) == t.elapsedMs,
    );
    check(
      "grantedKb",
      d.memoryGrant?.grantedKb ?? null,
      t.grantedKb,
      (d.memoryGrant?.grantedKb ?? null) == t.grantedKb,
    );
    check(
      "missingIndexes",
      (d.missingIndexes ?? []).length,
      t.missingIndexes,
      (d.missingIndexes ?? []).length === t.missingIndexes,
    );

    // Every operator the digest reports must match the plan.
    // A cursor's plans reuse node ids, so match on id and operator name.
    const tops = t.operators;
    for (const o of d.topOperators) {
      const g =
        tops.find((x) => x.id === o.id && x.op === o.op) ??
        tops.find((x) => x.id === o.id);
      const w = `${where} node ${o.id} ${o.op}`;
      if (!g) {
        bad(short, w, "operator", "reported", "not in plan");
        continue;
      }
      operatorsChecked++;
      const f = (field, a, b, ok) => {
        fieldsChecked++;
        if (!ok) bad(short, w, field, a, b);
      };
      f("op", o.op, g.op, o.op === g.op);
      f("subtreeCost", o.subtreeCost, g.subtree, close(o.subtreeCost, g.subtree));
      f("ownCost", o.cost, g.own, close(o.cost, g.own, 1e-3) || Math.abs(o.cost - g.own) < 1e-5);
      f("estRows", o.estRows, g.estRows, close(o.estRows, g.estRows));
      if (g.threads) {
        f("actualRows", o.actualRows, g.actualRows, o.actualRows === g.actualRows);
        f("logicalReads", o.logicalReads ?? null, g.logicalReads, (o.logicalReads ?? null) == g.logicalReads);
        // A parallel operator runs once per thread: the digest counts it as executed once per logical
        // execution, so compare against executions per thread for those.
        const execs = g.parallel && g.threads > 1 ? Math.max(1, g.execs / (g.threads - 1)) : g.execs;
        f("execs", o.execs, g.execs, o.execs === g.execs || close(o.execs, execs, 0.01));
      }
      f("object", o.object ?? null, g.object, (o.object ?? null) === (g.object ?? null) || (o.object ?? "").startsWith(g.object ?? "\u0000"));
      f("lookup", !!o.lookup, !!g.lookup, !!o.lookup === !!g.lookup);
    }
    // The operators the models are told about must include the plan's costliest ones.
    const reported = new Set(d.topOperators.map((o) => o.id));
    const byOwn = [...t.operators].sort((a, b) => b.own - a.own)[0];
    if (byOwn && byOwn.own > 0)
      check("costliest operator reported", [...reported].join(","), byOwn.id, reported.has(byOwn.id));
    // Own elapsed time: row-mode operators report time including their children; batch mode reports its own.
    const ownMs = (o) =>
      o.elapsedMs == null
        ? 0
        : o.batch
          ? o.elapsedMs
          : o.elapsedMs -
            o.children
              .map((c) => t.operators.find((x) => x.id === c)?.elapsedMs ?? 0)
              .reduce((a, b) => a + b, 0);
    const slowest = [...t.operators].sort((a, b) => ownMs(b) - ownMs(a))[0];
    if (slowest && ownMs(slowest) >= 10)
      check("slowest operator reported", [...reported].join(","), slowest.id, reported.has(slowest.id));
    const byReads = [...t.operators].filter((o) => o.logicalReads).sort((a, b) => b.logicalReads - a.logicalReads)[0];
    if (byReads)
      check("most-read operator reported", [...reported].join(","), byReads.id, reported.has(byReads.id));
  }
}

console.log(
  `${files.length} plans, ${statementsChecked} statements, ${operatorsChecked} operators, ${fieldsChecked} fields checked: ${problems.length} disagreements`,
);
const byField = {};
for (const p of problems) byField[p.field] = (byField[p.field] ?? 0) + 1;
if (problems.length) console.log("by field:", byField);
for (const p of verbose ? problems : problems.slice(0, 40))
  console.log(`  ${p.file} | ${p.where} | ${p.field}: ours=${JSON.stringify(p.ours)} plan=${JSON.stringify(p.truth)}`);
process.exit(problems.length ? 1 : 0);
