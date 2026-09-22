// TYPESAFE_API_KEY=... node scripts/jev-gate.mjs [path-to-plan.md]
// One Jev call: does this plan actually build the goal? Prints YES or NO. No deps, no framework.
import { readFileSync } from "node:fs";

const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
if (!key) { console.error("set TYPESAFE_API_KEY"); process.exit(1); }

const file = process.argv[2] ?? "docs/superpowers/plans/2026-09-21-sql-server-qai.md";
const raw = readFileSync(file, "utf8");
// Judge the plan's structure, not its volume: code blocks are ~90% of the bytes and 60k of them
// would silently drop the last third of the plan. Keep headings, steps, prose, and checkbox lines.
const plan = process.argv.includes("--full")
  ? raw.slice(0, 90_000)
  // Judge structure, not volume: code blocks are ~2/3 of the bytes. Replace each one with a marker
  // but keep every prose line — filtering prose down to headings hid half the plan from the model.
  : raw.replace(/```[\s\S]*?```/gs, "[code]")
        .replace(/\n{2,}/g, "\n").slice(0, 90_000);

const goal = `A portal that takes the XML of a SQL Server query plan, uses generative AI to analyse it, provides
multiple action steps and multiple query rewrites where possible, and then has Jev rank the options and decide the
best one, returning the best query too. Output is rendered with OpenUI elements, with copy and export-to-PDF.`;

const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "jev-latest",
    state: { goal, plan },
    questions: {
      matches_goal: {
        type: "noul",
        instructions: "Would software built exactly as described in `plan` satisfy the goal in `goal`?",
        criteria: {
          true: "Every part of the goal is built by some task in the plan.",
          false: "A part of the goal is missing, or replaced by something else.",
        },
      },
      coverage: {
        type: "score",
        instructions: "How completely does `plan` cover each separate part of the goal in `goal`?",
        criteria: [
          "Most of the goal is absent from the plan.",
          "The happy path only; failures and edge cases missing.",
          "Most parts, with one thin area.",
          "Every part has a task with a test.",
          "Every part has a task, a test, and a named failure behaviour.",
        ],
      },
      biggest_gap: {
        type: "choice",
        instructions: "For the user to actually reach the goal in `goal`, which single option listed here does `plan` still fail to cover? Choose nothing only if every part of the goal is built and tested by some task.",
        criteria: {
          nothing: "Nothing is missing: every part of the goal is built and tested by some task.",
          get_plan: "Getting a real .sqlplan out of SQL Server and into the portal.",
          jev_key: "Obtaining and entering their own Jev (TypeSafe) API key in the settings panel.",
          analyst_endpoint: "Knowing which analyst model endpoint to point the app at.",
          openui_render: "Rendering the answer as OpenUI elements rather than text.",
          copy_pdf: "Copying the output or exporting it to PDF.",
          jev_decides: "Jev ranking the options and deciding which one runs first.",
          multiple_options: "Several genuinely different action plans and query rewrites.",
          trust: "Telling the user whether to believe the ranking on their own data.",
          failures: "What happens when the XML, the analyst model, or Jev is broken.",
          history: "History with rename and delete, and reopening a stored run.",
          container: "Running the whole thing in one container.",
          qa: "End-to-end browser QA of the finished app.",
        },
      },
    },
  }),
});

if (!res.ok) { console.error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const { answers: a, model } = await res.json();

const yes = a.matches_goal.noul >= 0.5 && a.coverage.score >= 3 && a.biggest_gap.choice === "nothing";
console.log(model, "→", yes ? "YES — this plan builds your goal" : "NO — a gap needs closing first");
console.table({
  "matches_goal (p yes)": a.matches_goal.noul,
  "coverage (0-4)": a.coverage.score,
  "coverage confidence": a.coverage.confidence,
  "biggest_gap": a.biggest_gap.choice,
  "gap confidence": a.biggest_gap.confidence,
});
console.log(Object.entries(a.biggest_gap.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 4));
