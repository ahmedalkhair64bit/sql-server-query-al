// Stress test for the plan parser: extreme but legal plan shapes at up to the 100 MB limit, plus fuzzing
// every evaluation plan with truncations and byte corruption. Every shape must parse inside the worker's
// limits; every corrupt input must fail with a PlanError (a clear message), never a crash or a hang.
//
//   npm run stress:parser            full run (writes ~400 MB of temporary files, a minute or two)
//   npm run stress:parser -- --quick smaller shapes, for CI
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { parsePlanText, PlanError } from "../lib/plan-parser.mjs";

const quick = process.argv.includes("--quick");
const scale = quick ? 0.1 : 1;
const root = join(tmpdir(), `qai-stress-${process.pid}`);
mkdirSync(root, { recursive: true });

const OPEN =
  '<?xml version="1.0"?><ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements>';
const CLOSE = "</Statements></Batch></BatchSequence></ShowPlanXML>";
const relop = (id, extra = "", inner = "") =>
  `<RelOp NodeId="${id}" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="10" EstimatedTotalSubtreeCost="${(1000 - (id % 1000)) / 10}"${extra}>` +
  `<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="${id * 7}" ActualExecutions="1" ActualElapsedms="${id % 500}" ActualLogicalReads="${id * 3}"/></RunTimeInformation>` +
  `<NestedLoops>${inner}</NestedLoops></RelOp>`;

// Each shape streams to disk so the generator itself stays small.
async function write(name, parts) {
  const file = join(root, `${name}.xml`);
  const out = createWriteStream(file);
  let bytes = 0;
  for (const p of parts()) {
    bytes += Buffer.byteLength(p);
    if (!out.write(p)) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
  return { file, bytes };
}
const SHAPES = {
  // 100 MB of statements, each a small nested plan: a huge batch.
  *"many statements"() {
    yield OPEN;
    const n = Math.round(46000 * scale); // ~95 MB: just under the upload limit
    for (let s = 0; s < n; s++) {
      let x = "";
      for (let d = 0; d < 6; d++)
        x += relop(d).replace("</NestedLoops></RelOp>", "");
      x += "</NestedLoops></RelOp>".repeat(6);
      yield `<StmtSimple StatementId="${s}" StatementText="UPDATE dbo.T SET a = ${s} WHERE id = ${s}" StatementSubTreeCost="${s % 97}"><QueryPlan>${x}</QueryPlan></StmtSimple>`;
    }
    yield CLOSE;
  },
  // One statement with 150,000 sibling operators: a very wide plan.
  *"wide statement"() {
    yield OPEN +
      '<StmtSimple StatementText="SELECT wide"><QueryPlan><RelOp NodeId="-1" PhysicalOp="Concatenation" EstimateRows="1" EstimatedTotalSubtreeCost="99999"><Concat>';
    const n = Math.round(150000 * scale);
    for (let i = 0; i < n; i++) yield relop(i);
    yield "</Concat></RelOp></QueryPlan></StmtSimple>" + CLOSE;
  },
  // 9,500 operators deep = 19,000 tags, just inside the parser's 20,000-tag limit.
  *"deep nesting"() {
    const depth = Math.round(9500 * Math.max(scale, 0.5));
    yield OPEN + '<StmtSimple StatementText="SELECT deep"><QueryPlan>';
    for (let i = 0; i < depth; i++)
      yield relop(i).replace("</NestedLoops></RelOp>", "");
    yield "</NestedLoops></RelOp>".repeat(depth);
    yield "</QueryPlan></StmtSimple>" + CLOSE;
  },
  // Enormous attribute values: 20 MB of statement text and 20 MB predicates.
  *"huge attributes"() {
    const big = "x".repeat(Math.round(20_000_000 * scale));
    yield OPEN + `<StmtSimple StatementText="SELECT '${big}'"><QueryPlan>`;
    yield `<RelOp NodeId="0" PhysicalOp="Filter" EstimateRows="1" EstimatedTotalSubtreeCost="1"><Filter><Predicate><ScalarOperator ScalarString="${big}"/></Predicate></Filter></RelOp>`;
    yield "</QueryPlan></StmtSimple>" + CLOSE;
  },
  // Unicode-heavy identifiers and text in every attribute.
  *unicode() {
    yield OPEN;
    const n = Math.round(20000 * scale);
    for (let s = 0; s < n; s++)
      yield `<StmtSimple StatementText="SELECT [名前], [Ünïcødé] FROM [المبيعات].[طلبات] WHERE 😀 = ${s}"><QueryPlan>${relop(s, ' Parallel="1"')}<MissingIndexes><MissingIndexGroup Impact="90"><MissingIndex Schema="[المبيعات]" Table="[طلبات]"><ColumnGroup Usage="EQUALITY"><Column Name="[名前]"/></ColumnGroup></MissingIndex></MissingIndexGroup></MissingIndexes></QueryPlan></StmtSimple>`;
    yield CLOSE;
  },
};

function runWorker(file) {
  return new Promise((resolve) => {
    const started = performance.now();
    const w = new Worker(new URL("../lib/plan-worker.mjs", import.meta.url), {
      workerData: { file, directory: `${file}.out` },
      resourceLimits: { maxOldGenerationSizeMb: 512 }, // same limit as the app
    });
    const timer = setTimeout(() => {
      void w.terminate();
      resolve({ ok: false, error: "exceeded the app's 120 s limit" });
    }, 120_000);
    w.once("message", (r) => {
      clearTimeout(timer);
      resolve({ ...r, ms: Math.round(performance.now() - started) });
    });
    w.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}

const rows = [];
let failures = 0;
for (const [name, gen] of Object.entries(SHAPES)) {
  const { file, bytes } = await write(name.replace(/\s/g, "-"), gen);
  const r = await runWorker(file);
  const pass = !!r.ok;
  if (!pass) failures++;
  rows.push({
    shape: name,
    MB: (bytes / 1e6).toFixed(1),
    seconds: r.ms ? (r.ms / 1000).toFixed(1) : "—",
    "peak RSS MB": r.peakRSS ? Math.round(r.peakRSS / 1e6) : "—",
    statements: r.count ?? "—",
    result: pass ? "pass" : `FAIL: ${r.error ?? "unexpected success"}`,
  });
  rmSync(`${file}.out`, { recursive: true, force: true });
  rmSync(file, { force: true });
}
console.log(
  "\nPlan shapes (worker with the app's 512 MB heap and 120 s limits)",
);
console.table(rows);

// Fuzz: truncate and corrupt every evaluation plan. Anything but success or PlanError is a bug.
const dir = new URL("../fixtures/eval/", import.meta.url);
const plans = readdirSync(dir).filter((f) => f.endsWith(".sqlplan"));
let cases = 0,
  rejected = 0,
  parsed = 0;
const bugs = [];
let seed = 42;
const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
for (const f of plans) {
  const xml = readFileSync(new URL(f, dir), "utf8");
  const variants = [];
  for (let i = 0; i < (quick ? 30 : 200); i++)
    variants.push(xml.slice(0, rand(xml.length)));
  for (let i = 0; i < (quick ? 30 : 200); i++) {
    const chars = [...xml];
    for (let k = 0; k < 3; k++)
      chars[rand(chars.length)] = "<>&\"'\0x/="[rand(10)];
    variants.push(chars.join(""));
  }
  variants.push(
    xml.replace(/<RelOp/g, '<RelOp NodeId=""'),
    xml.replace(/ActualRows="\d+"/g, 'ActualRows="-5"'),
  );
  variants.push(
    xml.replace(/EstimateRows="[\d.]+"/g, 'EstimateRows="NaN"'),
    xml.replace(/StatementText="/, 'StatementText="&#0;'),
  );
  for (const v of variants) {
    cases++;
    try {
      parsePlanText(v);
      parsed++;
    } catch (e) {
      if (e instanceof PlanError) rejected++;
      else bugs.push(`${f}: ${e.constructor.name}: ${e.message.slice(0, 120)}`);
    }
  }
}
console.log(
  `\nFuzz: ${cases} corrupted or truncated plans → ${parsed} parsed, ${rejected} rejected with a clear PlanError, ${bugs.length} unexpected errors`,
);
for (const b of [...new Set(bugs)].slice(0, 10)) console.log("  BUG", b);
rmSync(root, { recursive: true, force: true });
process.exit(failures || bugs.length ? 1 : 0);
