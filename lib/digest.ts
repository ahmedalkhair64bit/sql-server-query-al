import { parsePlanText, planEvidence } from "./plan-parser.mjs";
export { PlanError, MAX_XML_BYTES } from "./plan-parser.mjs";
// Optional fields are omitted when the plan does not carry them.
export type Operator = {
  id: string;
  op: string;
  logicalOp?: string;
  /** The operator's own estimated cost (subtree minus children); legacy digests hold the subtree cost. */
  cost: number;
  subtreeCost?: number;
  /** Estimated rows per execution. */
  estRows: number;
  estExecs?: number;
  estRowsRead?: number;
  /** Actual rows summed over every execution and thread. */
  actualRows: number | null;
  execs: number | null;
  rowsRead?: number;
  logicalReads?: number;
  physicalReads?: number;
  io?: number | null;
  cpu?: number | null;
  spillLevels?: number | null;
  parallel: boolean;
  executionMode?: string;
  /** The operator's own time, children excluded. */
  actualCpuMs?: number | null;
  actualElapsedMs?: number | null;
  object?: string;
  lookup?: boolean;
  seekColumns?: string[];
  predicate?: string;
};
export type RowGuess = {
  id: string;
  op: string;
  /** Estimated rows per execution. */
  est: number;
  /** Actual rows per execution. */
  actual: number;
  actualTotal?: number;
  execs?: number;
  ratio: number | null;
};
export type Parameter = {
  name: string;
  type?: string;
  compiled?: string;
  runtime?: string;
  differs?: boolean;
};
export type MissingIndex = {
  table: string;
  equality: string[];
  inequality: string[];
  included: string[];
  impact: number;
};
export type Wait = { type: string; ms: number };
export type Digest = {
  version?: number;
  statementId?: string;
  sql: string;
  bytes: number;
  subtreeCost: number | null;
  parallel: boolean;
  nonParallelReason: string | null;
  earlyAbort: string | null;
  tables: string[];
  topOperators: Operator[];
  rowGuessErrors: RowGuess[];
  missingIndexes: MissingIndex[];
  warnings: string[];
  waits: Wait[];
  coverage?: string[];
  actual?: boolean;
  sqlTruncated?: boolean;
  costBasis?: "operator";
  optimizationLevel?: string | null;
  ceVersion?: number | null;
  dop?: number | null;
  compileMs?: number | null;
  queryHash?: string;
  planHash?: string;
  queryTime?: {
    cpuMs?: number;
    elapsedMs?: number;
    udfCpuMs?: number;
    udfElapsedMs?: number;
  } | null;
  memoryGrant?: {
    requestedKb?: number;
    grantedKb?: number;
    maxUsedKb?: number;
    desiredKb?: number;
    requiredKb?: number;
    grantWaitMs?: number;
    feedbackAdjusted?: string;
  } | null;
  parameters?: Parameter[];
  indexes?: { table: string; index: string; kind?: string }[];
  statistics?: {
    table: string;
    name: string;
    modifications?: number;
    samplingPercent?: number;
    lastUpdate?: string;
  }[];
  /** Stored by older versions only; evidence is now derived by digestForModel. */
  evidence?: unknown;
};
export type Evidence = {
  id: string;
  kind: string;
  value: import("@typesafe-ai/sdk").JsonValue;
};
export function digestPlan(raw: string): Digest {
  return parsePlanText(raw)[0] as Digest;
}
export const digestForModel = (d: Digest) => {
  // Each fact is sent once, inside evidence with its ID: the operator, row-error, index and warning
  // arrays used to travel twice (as lists and as evidence), which halved the usable context budget.
  const model = {
    version: 2,
    statementId: d.statementId ?? "legacy",
    sql: d.sql.slice(0, 4000),
    sql_truncated: !!d.sqlTruncated || d.sql.length > 4000,
    subtreeCost: d.subtreeCost,
    costMeaning:
      "SQL Server optimizer estimate; not measured runtime or a percentage",
    fieldMeaning:
      d.costBasis === "operator"
        ? "operator.cost is the operator's own estimated cost (its subtree minus its children). estRows is per execution; actualRows is the total over all executions. actualElapsedMs and actualCpuMs are the operator's own time, children excluded (approximate in parallel plans). Memory values are KB. A parameter with differs=true was compiled for a different value than it ran with."
        : "operator.cost is the estimated subtree cost, including children.",
    actual: d.actual ?? d.topOperators.some((o) => o.actualRows !== null),
    parallel: d.parallel,
    nonParallelReason: d.nonParallelReason,
    earlyAbort: d.earlyAbort,
    tables: d.tables.slice(0, 20),
    waits: d.waits,
    evidence: structuredClone(planEvidence(d).slice(0, 60)) as Evidence[],
    coverage: [
      ...(d.coverage ?? []),
      ...(d.tables.length > 20
        ? ["Only 20 tables included in model context."]
        : []),
      ...(d.sql.length > 4000 || d.sqlTruncated
        ? ["SQL is incomplete; query rewrites and query hints are prohibited."]
        : []),
    ],
  };
  const total = planEvidence(d).length;
  while (JSON.stringify(model).length > 48000 && model.evidence.length)
    model.evidence.pop();
  if (model.evidence.length < total)
    model.coverage.push(
      "Evidence list reduced to fit the model context budget.",
    );
  return model;
};
