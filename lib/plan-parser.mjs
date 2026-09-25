import { detectFindings } from "./findings.mjs";
import { SaxesParser } from "saxes";
export const MAX_XML_BYTES = 100_000_000;
export class PlanError extends Error {}
const n = (v) =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const unbrack = (v) =>
  String(v ?? "")
    .slice(0, 512)
    .replace(/[[\]]/g, "");
const fullName = (a) =>
  [a.Database, a.Schema, a.Table].map(unbrack).filter(Boolean).join(".");
const blank = (id) => ({
  version: 2,
  statementId: id,
  sql: "",
  bytes: 0,
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
  coverage: [],
  operatorCount: 0,
  actual: false,
  costBasis: "operator",
  parameters: [],
  statistics: [],
  indexes: [],
  columns: {},
  queryTime: null,
  memoryGrant: null,
  // Candidate pools for topOperators, merged in finish(): cost alone misses where an actual plan spent its time.
  byCost: [],
  byTime: [],
  byReads: [],
});
const local = (qname) => {
  const i = qname.indexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
};
const round = (v) => (v == null ? v : Number(v.toFixed(6)));
// Drop null and empty fields: stored once per statement and sent to the model, so absent beats null.
const compact = (o) =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => v != null && !(Array.isArray(v) && !v.length),
    ),
  );
// Operators keep the fields readers index directly; the optional runtime detail is compacted away when absent.
const CORE = new Set([
  "id",
  "op",
  "cost",
  "estRows",
  "actualRows",
  "execs",
  "parallel",
]);
const compactOperator = (o) =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([k, v]) =>
        CORE.has(k) ||
        (v != null && v !== false && !(Array.isArray(v) && !v.length)),
    ),
  );
const PHYSICAL_PARENT = (stack) => stack.at(-3)?.name === "RelOp";
const keep = (list, item, limit, key) => {
  list.push(item);
  list.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
  if (list.length > limit) list.length = limit;
};
// SAX events retain only bounded summaries and the active ancestor stack, never the XML tree.
export function createPlanParser(onStatement) {
  // Namespace processing is off on purpose: saxes resolves namespaces by walking every ancestor, which made
  // deeply nested plans quadratic (4,000 levels: 1.4 s instead of 30 ms). ShowPlan uses one default
  // namespace, so dropping any prefix below gives the same local names.
  const parser = new SaxesParser({ xmlns: false });
  let root = false,
    seq = 0,
    depth = 0,
    bytes = 0,
    unknown = new Set();
  const stack = [],
    statements = [],
    ops = [],
    groups = [],
    indexes = [];
  const fallback = blank("s0");
  const current = () => statements.at(-1)?.digest ?? fallback;
  const addWarning = (d, value) => {
    if (d.warnings.length < 100 && !d.warnings.includes(value))
      d.warnings.push(value.slice(0, 500));
  };
  const finish = (d) => {
    d.bytes = bytes;
    const seen = new Set(),
      top = [];
    const add = (o) => {
      if (top.length < 12 && !seen.has(o)) {
        seen.add(o);
        top.push(o);
      }
    };
    // Actual plans rank by the operator's own measured time, then its reads; estimated cost fills the rest.
    if (d.actual) {
      d.byTime
        .filter((o) => o.actualElapsedMs > 0)
        .slice(0, 8)
        .forEach(add);
      d.byReads
        .filter((o) => o.logicalReads > 0)
        .slice(0, 3)
        .forEach(add);
    }
    d.byCost.forEach(add);
    d.byTime.forEach(add);
    d.topOperators = top.map(compactOperator);
    delete d.byCost;
    delete d.byTime;
    delete d.byReads;
    for (const r of d.rowGuessErrors) delete r.sortRatio;
    if (d.operatorCount > 12)
      d.coverage.push(
        `${d.operatorCount - 12} operators omitted from top-cost list; row errors are ranked independently.`,
      );
    if (!Object.keys(d.columns).length) delete d.columns;
    for (const k of ["queryTime", "memoryGrant"])
      if (d[k]) d[k] = compact(d[k]);
    onStatement(d);
  };
  parser.on("doctype", () => {
    throw new PlanError(
      "DTD and external entities are not supported. Export a SQL Server ShowPlan XML file.",
    );
  });
  parser.on("error", (e) => {
    throw new PlanError(`The XML stopped parsing: ${e.message.slice(0, 180)}`);
  });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth > 20000)
      throw new PlanError(
        "Plan nesting exceeds the supported depth of 20,000 tags.",
      );
    const name = local(tag.name);
    const a = {};
    for (const [k, v] of Object.entries(tag.attributes))
      if (k !== "xmlns" && !k.startsWith("xmlns:")) a[local(k)] = v;
    if (!root) {
      if (name !== "ShowPlanXML")
        throw new PlanError(
          "Not a SQL Server ShowPlan XML document. Upload a .sqlplan or ShowPlan XML file.",
        );
      root = true;
    }
    stack.push({ name, text: "" });
    if (/^Stmt/.test(name)) {
      const digest = blank(`s${++seq}`);
      digest.sql = (a.StatementText ?? "").slice(0, 64000);
      if ((a.StatementText?.length ?? 0) > 64000)
        digest.coverage.push(
          "Statement SQL exceeds the stored 64,000-character preview.",
        );
      digest.sqlTruncated = (a.StatementText?.length ?? 0) > 64000;
      digest.subtreeCost = n(a.StatementSubTreeCost ?? a.StatementSubtreeCost);
      digest.earlyAbort = a.StatementOptmEarlyAbortReason ?? null;
      digest.statementType = a.StatementType ?? name;
      digest.optimizationLevel = a.StatementOptmLevel ?? null;
      digest.ceVersion = n(a.CardinalityEstimationModelVersion);
      if (
        ![
          "StmtSimple",
          "StmtCond",
          "StmtCursor",
          "StmtUseDb",
          "StmtReceive",
        ].includes(name)
      )
        digest.coverage.push(
          `Unfamiliar statement element ${name}; only recognized evidence was extracted.`,
        );
      statements.push({ depth, digest });
    }
    const d = current();
    if (a.NonParallelPlanReason) d.nonParallelReason = a.NonParallelPlanReason;
    if (a.QueryHash && !d.queryHash) d.queryHash = a.QueryHash.slice(0, 40);
    if (a.QueryPlanHash && !d.planHash)
      d.planHash = a.QueryPlanHash.slice(0, 40);
    if (name === "QueryPlan") {
      d.dop = n(a.DegreeOfParallelism) ?? d.dop ?? null;
      d.compileMs = n(a.CompileTime) ?? d.compileMs ?? null;
    }
    if (name === "QueryTimeStats")
      d.queryTime = {
        cpuMs: n(a.CpuTime),
        elapsedMs: n(a.ElapsedTime),
        udfCpuMs: n(a.UdfCpuTime),
        udfElapsedMs: n(a.UdfElapsedTime),
      };
    if (name === "MemoryGrantInfo")
      d.memoryGrant = {
        requestedKb: n(a.RequestedMemory),
        grantedKb: n(a.GrantedMemory),
        maxUsedKb: n(a.MaxUsedMemory),
        desiredKb: n(a.SerialDesiredMemory),
        requiredKb: n(a.SerialRequiredMemory),
        grantWaitMs: n(a.GrantWaitTime),
        feedbackAdjusted: a.IsMemoryGrantFeedbackAdjusted ?? null,
      };
    if (
      name === "ColumnReference" &&
      stack.at(-2)?.name === "ParameterList" &&
      d.parameters.length < 50
    ) {
      const p = compact({
        name: String(a.Column ?? "").slice(0, 128),
        type: a.ParameterDataType?.slice(0, 64),
        compiled: a.ParameterCompiledValue?.slice(0, 200),
        runtime: a.ParameterRuntimeValue?.slice(0, 200),
      });
      if (p.compiled != null && p.runtime != null && p.compiled !== p.runtime)
        p.differs = true;
      d.parameters.push(p);
    }
    // Columns the plan references per table: the SQL checker rejects index DDL naming columns never seen here.
    if (
      name === "ColumnReference" &&
      a.Table &&
      a.Column &&
      stack.at(-2)?.name !== "ParameterList"
    ) {
      const table = fullName(a),
        column = unbrack(a.Column);
      const list =
        d.columns[table] ??
        (Object.keys(d.columns).length < 100 ? (d.columns[table] = []) : null);
      if (list && list.length < 300 && !list.includes(column))
        list.push(column);
    }
    if (name === "StatisticsInfo")
      keep(
        d.statistics,
        compact({
          table: fullName(a),
          name: unbrack(a.Statistics),
          modifications: n(a.ModificationCount),
          samplingPercent: n(a.SamplingPercent),
          lastUpdate: a.LastUpdate?.slice(0, 40),
        }),
        20,
        "modifications",
      );
    if (name === "RelOp") {
      // ShowPlan has no per-operator cost attribute: EstimatedTotalSubtreeCost includes every child, so
      // ranking by it always put the root first. The operator's own cost is computed when it closes.
      const o = {
        id: String(a.NodeId ?? a.Node_id ?? d.operatorCount),
        op: (a.PhysicalOp ?? a.LogicalOp ?? "Unknown").slice(0, 160),
        logicalOp: a.LogicalOp?.slice(0, 160) ?? null,
        cost: 0,
        subtreeCost: n(a.EstimatedTotalSubtreeCost),
        estRows: n(a.EstimateRows) ?? 0,
        estExecs: 1 + (n(a.EstimateRebinds) ?? 0) + (n(a.EstimateRewinds) ?? 0),
        estRowsRead: n(a.EstimatedRowsRead),
        // Set when a TOP, EXISTS or FAST n made the optimizer plan for fewer rows than the query produces.
        rowGoal:
          n(a.EstimateRowsWithoutRowGoal) !== null &&
          n(a.EstimateRowsWithoutRowGoal) > (n(a.EstimateRows) ?? 0),
        threadSkew: null,
        actualRows: null,
        execs: null,
        rowsRead: null,
        logicalReads: null,
        physicalReads: null,
        io: n(a.EstimateIO ?? a.EstimatedIO),
        cpu: n(a.EstimateCPU ?? a.EstimatedCPU),
        spillLevels: null,
        parallel: a.Parallel === "true" || a.Parallel === "1",
        executionMode: a.EstimatedExecutionMode ?? null,
        actualCpuMs: null,
        actualElapsedMs: null,
        object: null,
        lookup: false,
        seekColumns: [],
        predicate: null,
      };
      if (o.estExecs === 1) o.estExecs = null;
      ops.push({
        depth,
        d,
        o,
        childCost: 0,
        childCpu: 0,
        childElapsed: 0,
        batch: false,
        threadRows: [],
      });
      d.operatorCount++;
      d.parallel ||= o.parallel;
    }
    const active = ops.at(-1);
    const o = active?.d === d ? active.o : null;
    if (name === "RunTimeCountersPerThread" && o) {
      d.actual = true;
      if (a.ActualExecutionMode === "Batch") active.batch = true;
      // Thread 0 is the coordinator in a parallel plan; workers carry the rows.
      if (o.parallel && n(a.Thread) > 0 && active.threadRows.length < 256)
        active.threadRows.push(n(a.ActualRows) ?? 0);
      for (const [field, attr] of [
        ["actualRows", "ActualRows"],
        ["execs", "ActualExecutions"],
        ["actualCpuMs", "ActualCPUms"],
        ["rowsRead", "ActualRowsRead"],
        ["logicalReads", "ActualLogicalReads"],
        ["physicalReads", "ActualPhysicalReads"],
        ["physicalReads", "ActualReadAheads"],
      ]) {
        const value = n(
          a[attr] ?? (field === "execs" ? a.ActualExecs : undefined),
        );
        if (value !== null) o[field] = (o[field] ?? 0) + value;
      }
      if (n(a.ActualElapsedms) !== null)
        o.actualElapsedMs = Math.max(
          o.actualElapsedMs ?? 0,
          n(a.ActualElapsedms),
        );
    }
    if (o && name === "IndexScan" && (a.Lookup === "1" || a.Lookup === "true"))
      o.lookup = true;
    if (
      o &&
      name === "Object" &&
      PHYSICAL_PARENT(stack) &&
      !o.object &&
      a.Table
    ) {
      o.object = fullName(a) + (a.Index ? `.${unbrack(a.Index)}` : "");
      if (a.Index && d.indexes.length < 50) {
        const used = compact({
          table: fullName(a),
          index: unbrack(a.Index),
          kind: a.IndexKind?.slice(0, 40),
        });
        if (
          !d.indexes.some(
            (x) => x.table === used.table && x.index === used.index,
          )
        )
          d.indexes.push(used);
      }
    }
    if (
      o &&
      name === "ColumnReference" &&
      stack.at(-2)?.name === "RangeColumns" &&
      a.Column &&
      o.seekColumns.length < 16 &&
      !o.seekColumns.includes(unbrack(a.Column))
    )
      o.seekColumns.push(unbrack(a.Column));
    // Residual predicate: Predicate > ScalarOperator directly under this operator's physical element.
    if (
      o &&
      name === "ScalarOperator" &&
      stack.at(-2)?.name === "Predicate" &&
      stack.at(-4)?.name === "RelOp" &&
      !o.predicate &&
      a.ScalarString
    )
      o.predicate = a.ScalarString.slice(0, 500);
    if (name === "SpillToTempDb" && o) o.spillLevels = n(a.SpillLevel);
    if (
      ["Object", "Table", "IndexScan", "TableScan"].includes(name) &&
      a.Table
    ) {
      const table = fullName(a);
      if (d.tables.length < 200 && !d.tables.includes(table))
        d.tables.push(table);
      else if (
        d.tables.length >= 200 &&
        !d.coverage.includes("Table list capped at 200.")
      )
        d.coverage.push("Table list capped at 200.");
    }
    if (name === "MissingIndexGroup")
      groups.push({ depth, impact: n(a.Impact) ?? 0 });
    if (name === "MissingIndex")
      indexes.push({
        depth,
        d,
        mi: {
          table: fullName(a),
          equality: [],
          inequality: [],
          included: [],
          impact: groups.at(-1)?.impact ?? 0,
        },
        usage: null,
      });
    const idx = indexes.at(-1);
    if (idx && name === "ColumnGroup") idx.usage = a.Usage;
    if (idx && name === "IncludedColumns") idx.usage = "INCLUDE";
    if (idx && name === "Column") {
      const field = {
        EQUALITY: "equality",
        INEQUALITY: "inequality",
        INCLUDE: "included",
      }[idx.usage];
      if (field && idx.mi[field].length < 32)
        idx.mi[field].push(unbrack(a.Name));
    }
    if (stack.at(-2)?.name === "Warnings") {
      const detail = `${name}${
        Object.keys(a).length
          ? " " +
            Object.entries(a)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")
          : ""
      }`;
      // A warning under RelOp names its operator, so "SpillToTempDb" says which sort or hash spilled.
      addWarning(
        d,
        o && stack.at(-3)?.name === "RelOp"
          ? `Node ${o.id} ${o.op}: ${detail}`
          : detail,
      );
    }
    if (
      name === "ColumnReference" &&
      stack.at(-2)?.name === "ColumnsWithNoStatistics"
    )
      addWarning(
        d,
        `ColumnsWithNoStatistics column=${[fullName(a), unbrack(a.Column)].filter(Boolean).join(".")}`,
      );
    if (name === "Wait" || name === "WaitTime") {
      const ms = n(a.WaitTimeMs ?? a.WaitTime);
      if (ms > 0)
        keep(d.waits, { type: a.WaitType ?? "unknown", ms }, 10, "ms");
    }
    if (
      [
        "UDF",
        "ExternalSelect",
        "RemoteQuery",
        "StmtCursor",
        "StmtCond",
        "StmtUseDb",
        "Dispatcher",
        "ParameterSensitivePredicate",
      ].includes(name)
    ) {
      const msg = `Contains ${name}; only available ShowPlan evidence is summarized.`;
      if (!d.coverage.includes(msg)) d.coverage.push(msg);
    }
    if (
      name.startsWith("Stmt") &&
      ![
        "StmtSimple",
        "StmtCond",
        "StmtCursor",
        "StmtUseDb",
        "StmtReceive",
      ].includes(name)
    )
      unknown.add(name);
  });
  parser.on("text", (text) => {
    const top = stack.at(-1);
    if (
      top &&
      ["NonParallelPlanReason", "StatementOptmEarlyAbortReason"].includes(
        top.name,
      )
    )
      top.text += text.slice(0, 1000);
  });
  parser.on("closetag", () => {
    const top = stack.pop(),
      d = current();
    if (top.name === "NonParallelPlanReason") d.nonParallelReason = top.text;
    if (top.name === "StatementOptmEarlyAbortReason") d.earlyAbort = top.text;
    if (ops.at(-1)?.depth === depth) {
      const entry = ops.pop(),
        { o, d: owner } = entry;
      o.cost = round(
        o.subtreeCost !== null
          ? Math.max(0, o.subtreeCost - entry.childCost)
          : ((o.io ?? 0) + (o.cpu ?? 0)) * (o.estExecs ?? 1),
      );
      // Row mode reports time including children; batch mode reports the operator's own. Store own time,
      // pass cumulative time up so the parent can subtract it. Parallel plans make this an approximation.
      const cumulative = {};
      for (const [field, child] of [
        ["actualElapsedMs", "childElapsed"],
        ["actualCpuMs", "childCpu"],
      ]) {
        const reported = o[field];
        if (reported === null) continue;
        if (entry.batch) cumulative[field] = reported + entry[child];
        else {
          cumulative[field] = reported;
          o[field] = Math.max(0, reported - entry[child]);
        }
      }
      if (entry.batch) o.executionMode = "Batch";
      // Uneven work across parallel threads: one thread does most of it while the others wait.
      const rows = entry.threadRows;
      if (rows.length >= 2) {
        const total = rows.reduce((x, y) => x + y, 0);
        const max = Math.max(...rows);
        if (total >= 10000 && max > 3 * (total / rows.length))
          o.threadSkew = round(max / (total / rows.length));
      }
      const parent = ops.at(-1);
      if (parent && parent.d === owner) {
        parent.childCost += o.subtreeCost ?? o.cost;
        parent.childElapsed += cumulative.actualElapsedMs ?? 0;
        parent.childCpu += cumulative.actualCpuMs ?? 0;
      }
      keep(owner.byCost, o, 12, "cost");
      if (o.actualElapsedMs > 0) keep(owner.byTime, o, 12, "actualElapsedMs");
      if (o.logicalReads > 0) keep(owner.byReads, o, 3, "logicalReads");
      // EstimateRows is per execution; ActualRows is the total over every execution. Comparing them
      // flagged every nested-loop inner side as a huge miss, so compare per execution.
      if (o.actualRows !== null && o.execs !== 0) {
        const perExec = o.actualRows / Math.max(o.execs ?? 1, 1);
        const min = Math.min(o.estRows, perExec),
          max = Math.max(o.estRows, perExec);
        const ratio = min === 0 ? (max === 0 ? 1 : null) : max / min;
        if (ratio === null || ratio >= 10)
          keep(
            owner.rowGuessErrors,
            {
              id: o.id,
              op: o.op,
              est: o.estRows,
              actual: round(perExec),
              actualTotal: o.actualRows,
              execs: o.execs ?? 1,
              ratio: ratio === null ? null : round(ratio),
              zeroMismatch: ratio === null,
              sortRatio: ratio ?? Number.MAX_VALUE,
            },
            5,
            "sortRatio",
          );
      }
    }
    if (indexes.at(-1)?.depth === depth) {
      const { mi, d: owner } = indexes.pop();
      keep(owner.missingIndexes, mi, 10, "impact");
    }
    if (groups.at(-1)?.depth === depth) groups.pop();
    if (statements.at(-1)?.depth === depth) {
      const { digest } = statements.pop();
      finish(digest);
    }
    depth--;
  });
  return {
    write(text) {
      bytes += Buffer.byteLength(text);
      parser.write(text);
    },
    end() {
      parser.close();
      if (!root)
        throw new PlanError(
          "Empty input. Upload a SQL Server ShowPlan XML file.",
        );
      if (seq === 0) finish(fallback);
      return {
        statementCount: seq || 1,
        coverage: [...unknown].map((n) => `Unfamiliar statement element: ${n}`),
      };
    },
  };
}
export function parsePlanText(xml) {
  if (Buffer.byteLength(xml) > MAX_XML_BYTES)
    throw new PlanError("Plan exceeds the 100 MB limit.");
  const statements = [];
  const parser = createPlanParser((d) => statements.push(d));
  parser.write(xml.replace(/^\uFEFF/, ""));
  parser.end();
  for (const d of statements)
    d.bytes = Buffer.byteLength(xml.replace(/^\uFEFF/, ""));
  return statements;
}
// Evidence is derived from the stored digest on demand instead of being stored beside it: the stored copy
// duplicated every operator and doubled what the model was sent. IDs are stable, so analyses saved with the
// old stored evidence still resolve.
export function planEvidence(d) {
  const sid = d.statementId ?? "legacy";
  const errors = new Map((d.rowGuessErrors ?? []).map((r) => [r.id, r]));
  const top = new Set((d.topOperators ?? []).map((o) => o.id));
  return [
    {
      id: `${sid}:statement`,
      kind: "statement",
      value: compact({
        estimatedCost: d.subtreeCost,
        earlyAbort: d.earlyAbort,
        actual: d.actual ?? false,
        optimizationLevel: d.optimizationLevel,
        ceVersion: d.ceVersion,
        dop: d.dop,
        compileMs: d.compileMs,
        queryHash: d.queryHash,
        planHash: d.planHash,
      }),
    },
    d.queryTime && {
      id: `${sid}:query_time`,
      kind: "query_time",
      value: d.queryTime,
    },
    d.memoryGrant && {
      id: `${sid}:memory_grant`,
      kind: "memory_grant",
      value: d.memoryGrant,
    },
    // Rule findings go early so the context budget never trims them before raw operators.
    ...detectFindings(d).map((f, i) => ({
      id: `${sid}:finding:${i}`,
      kind: "finding",
      value: f,
    })),
    ...(d.topOperators ?? []).map((o) => {
      const e = errors.get(o.id);
      return {
        id: `${sid}:operator:${o.id}`,
        kind: "operator",
        value: e
          ? {
              ...o,
              rowEstimateError: { perExecActual: e.actual, ratio: e.ratio },
            }
          : o,
      };
    }),
    ...(d.rowGuessErrors ?? [])
      .filter((r) => !top.has(r.id))
      .map((r) => ({ id: `${sid}:rows:${r.id}`, kind: "row_error", value: r })),
    ...(d.parameters ?? []).map((p, i) => ({
      id: `${sid}:parameter:${i}`,
      kind: "parameter",
      value: p,
    })),
    ...(d.missingIndexes ?? []).map((m, i) => ({
      id: `${sid}:index:${i}`,
      kind: "missing_index",
      value: m,
    })),
    ...(d.warnings ?? []).map((w, i) => ({
      id: `${sid}:warning:${i}`,
      kind: "warning",
      value: w,
    })),
    d.indexes?.length && {
      id: `${sid}:indexes_used`,
      kind: "indexes_used",
      value: d.indexes,
    },
    ...(d.statistics ?? []).map((s, i) => ({
      id: `${sid}:stats:${i}`,
      kind: "statistics",
      value: s,
    })),
  ].filter(Boolean);
}
