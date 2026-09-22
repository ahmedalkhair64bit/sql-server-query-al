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
});
const keep = (list, item, limit, key) => {
  list.push(item);
  list.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
  if (list.length > limit) list.length = limit;
};
// SAX events retain only bounded summaries and the active ancestor stack, never the XML tree.
export function createPlanParser(onStatement) {
  const parser = new SaxesParser({ xmlns: true });
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
    if (d.operatorCount > 12)
      d.coverage.push(
        `${d.operatorCount - 12} operators omitted from top-cost list; row errors are ranked independently.`,
      );
    d.evidence = [
      {
        id: `${d.statementId}:statement`,
        kind: "statement",
        value: {
          estimatedCost: d.subtreeCost,
          earlyAbort: d.earlyAbort,
          actual: d.actual,
        },
      },
      ...d.topOperators.map((o) => ({
        id: `${d.statementId}:operator:${o.id}`,
        kind: "operator",
        value: o,
      })),
      ...d.missingIndexes.map((m, i) => ({
        id: `${d.statementId}:index:${i}`,
        kind: "missing_index",
        value: m,
      })),
      ...d.warnings.map((w, i) => ({
        id: `${d.statementId}:warning:${i}`,
        kind: "warning",
        value: w,
      })),
      ...d.rowGuessErrors
        .filter((r) => !d.topOperators.some((o) => o.id === r.id))
        .map((r) => ({
          id: `${d.statementId}:rows:${r.id}`,
          kind: "row_error",
          value: r,
        })),
    ];
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
    const name = tag.local;
    const a = Object.fromEntries(
      Object.values(tag.attributes).map((v) => [v.local, v.value]),
    );
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
    if (name === "RelOp") {
      const o = {
        id: String(a.NodeId ?? a.Node_id ?? d.operatorCount),
        op: (a.PhysicalOp ?? a.LogicalOp ?? "Unknown").slice(0, 160),
        cost:
          n(a.EstimatedOperatorCost) ??
          n(a.EstimatedTotalSubtreeCost) ??
          n(a.EstimateIO) ??
          0,
        costKind:
          a.EstimatedOperatorCost != null
            ? "operator_estimate"
            : "subtree_estimate",
        estRows: n(a.EstimateRows) ?? 0,
        actualRows: null,
        execs: null,
        io: n(a.EstimateIO ?? a.EstimatedIO),
        cpu: n(a.EstimateCPU ?? a.EstimatedCPU),
        spillLevels: null,
        parallel: a.Parallel === "true" || a.Parallel === "1",
        actualCpuMs: null,
        actualElapsedMs: null,
      };
      ops.push({ depth, d, o });
      d.operatorCount++;
      d.parallel ||= o.parallel;
    }
    const active = ops.at(-1);
    const o = active?.d === d ? active.o : null;
    if (name === "RunTimeCountersPerThread" && o) {
      d.actual = true;
      for (const [field, attr] of [
        ["actualRows", "ActualRows"],
        ["execs", "ActualExecutions"],
        ["actualCpuMs", "ActualCPUms"],
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
    if (stack.at(-2)?.name === "Warnings")
      addWarning(
        d,
        `${name}${
          Object.keys(a).length
            ? " " +
              Object.entries(a)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")
            : ""
        }`,
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
      const { o, d: owner } = ops.pop();
      keep(owner.topOperators, o, 12, "cost");
      if (o.actualRows !== null) {
        const min = Math.min(o.estRows, o.actualRows),
          max = Math.max(o.estRows, o.actualRows);
        const ratio = min === 0 ? (max === 0 ? 1 : null) : max / min;
        if (ratio === null || ratio >= 10)
          keep(
            owner.rowGuessErrors,
            {
              id: o.id,
              op: o.op,
              est: o.estRows,
              actual: o.actualRows,
              ratio,
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
