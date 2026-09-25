// Measures whether the analyst + Jev pick the right fix on plans with known answers.
//
//   ANALYST_BASE_URL=https://api.example.com/v1 ANALYST_API_KEY=... ANALYST_MODEL=... \
//   JEV_API_KEY=... [JEV_MODEL=jev-latest] npm run eval:plans [-- --json]
//
// Cases come from fixtures/eval/cases.json plus fixtures/eval/private/cases.json (gitignored: put your own
// anonymized plans there). A case passes when Jev selects an option whose type is in correct_fix_types,
// or declines when correct_fix_types is empty. Run it after every prompt, model or threshold change.
//
//   npm run eval:plans -- --outcomes [path/to/qai.db]
//
// reports real outcomes instead: for every analysis where a user uploaded an after plan, whether the
// option they applied was Jev's pick and whether the measured result improved.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");

if (args.includes("--outcomes")) {
  const { DatabaseSync } = await import("node:sqlite");
  const path =
    args[args.indexOf("--outcomes") + 1] ??
    join(process.env.DATA_DIR ?? "data", "qai.db");
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT verdict, comparison FROM analyses WHERE comparison IS NOT NULL AND verdict IS NOT NULL",
    )
    .all()
    .map((r) => ({
      verdict: JSON.parse(r.verdict),
      comparison: JSON.parse(r.comparison),
    }));
  const groups = {
    "Applied Jev's pick": [],
    "Applied another option": [],
    "Jev declined, user applied something": [],
  };
  for (const r of rows) {
    const pick = r.verdict.source === "jev" ? r.verdict.headline : null;
    const applied = r.comparison.appliedKey;
    if (!pick) groups["Jev declined, user applied something"].push(r);
    else if (applied === pick) groups["Applied Jev's pick"].push(r);
    else groups["Applied another option"].push(r);
  }
  console.log(`Outcomes from ${rows.length} compared analyses (${path})\n`);
  for (const [name, list] of Object.entries(groups)) {
    const measured = list.filter((r) => r.comparison.basis === "measured");
    const improved = measured.filter(
      (r) => r.comparison.verdict === "improved",
    ).length;
    const regressed = measured.filter(
      (r) => r.comparison.verdict === "regressed",
    ).length;
    console.log(
      `${name.padEnd(40)} ${String(list.length).padStart(4)} runs, ${String(measured.length).padStart(4)} measured: ` +
        `improved ${pct(improved, measured.length)}, regressed ${pct(regressed, measured.length)}`,
    );
  }
  process.exit(0);
}

const env = (k) => {
  if (!process.env[k]) {
    console.error(`Set ${k}. See the header of scripts/eval-plans.mjs.`);
    process.exit(1);
  }
  return process.env[k];
};
const analyst = {
  baseUrl: env("ANALYST_BASE_URL").replace(/\/+$/, ""),
  apiKey: env("ANALYST_API_KEY"),
  model: env("ANALYST_MODEL"),
  extra: JSON.parse(process.env.ANALYST_EXTRA ?? "{}"),
};
const jevKey = env("JEV_API_KEY");

const { parsePlanText } = await import("../lib/plan-parser.mjs");
const { proposeCandidates } = await import("../lib/analyst.ts");
const { judgeCandidates, makeJevClient } = await import("../lib/jev.ts");

const suites = ["fixtures/eval", "fixtures/eval/private"].filter((dir) =>
  existsSync(join(dir, "cases.json")),
);
const results = [];
for (const dir of suites)
  for (const c of JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))
    .cases) {
    const started = Date.now();
    const row = { case: join(dir, c.file), expected: c.correct_fix_types };
    try {
      const digest = parsePlanText(readFileSync(join(dir, c.file), "utf8"))[0];
      const candidates = await proposeCandidates(analyst, digest, c.note ?? "");
      const verdict = await judgeCandidates(
        digest,
        candidates,
        makeJevClient(jevKey, process.env.JEV_MODEL),
      );
      const picked = candidates.find((x) => x.key === verdict.headline);
      row.proposed = candidates.map((x) => x.option_type);
      row.rejected = candidates.filter((x) => x.rejected_reasons.length).length;
      row.picked = picked?.option_type ?? null;
      row.confidence = verdict.jev_confidence;
      row.proposedCorrect = candidates.some(
        (x) =>
          c.correct_fix_types.includes(x.option_type) &&
          !x.rejected_reasons.length,
      );
      row.pass = c.correct_fix_types.length
        ? c.correct_fix_types.includes(row.picked)
        : row.picked === null;
    } catch (e) {
      // The analyst declining for lack of evidence is the right answer on a healthy plan.
      row.error = e.message.slice(0, 160);
      row.pass =
        !c.correct_fix_types.length &&
        /Insufficient evidence|at least 2/.test(e.message);
    }
    row.seconds = Math.round((Date.now() - started) / 1000);
    results.push(row);
    if (!args.includes("--json"))
      console.log(
        `${row.pass ? "PASS" : "FAIL"}  ${row.case.padEnd(48)} picked=${row.picked ?? "none"} ` +
          `expected=${c.correct_fix_types.join("|") || "decline"}${row.error ? `  (${row.error})` : ""}`,
      );
  }
const pass = results.filter((r) => r.pass).length;
const withFix = results.filter((r) => r.expected.length);
const summary = {
  cases: results.length,
  pass,
  accuracy: pct(pass, results.length),
  analystProposedACorrectOption: pct(
    withFix.filter((r) => r.proposedCorrect).length,
    withFix.length,
  ),
  jevAbstainedWhenAFixExisted: pct(
    withFix.filter((r) => !r.error && r.picked === null).length,
    withFix.length,
  ),
};
if (args.includes("--json"))
  console.log(JSON.stringify({ summary, results }, null, 2));
else console.log("\n", summary);
process.exit(pass === results.length ? 0 : 1);
