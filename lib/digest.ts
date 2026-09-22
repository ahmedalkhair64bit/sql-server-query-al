import { parsePlanText } from "./plan-parser.mjs";
export { PlanError, MAX_XML_BYTES } from "./plan-parser.mjs";
export type Operator = {
  id: string;
  op: string;
  cost: number;
  estRows: number;
  actualRows: number | null;
  execs: number | null;
  io: number | null;
  cpu: number | null;
  spillLevels: number | null;
  parallel: boolean;
};
export type RowGuess = {
  id: string;
  op: string;
  est: number;
  actual: number;
  ratio: number | null;
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
  evidence?: {
    id: string;
    kind: string;
    value: import("@typesafe-ai/sdk").JsonValue;
  }[];
};
export function digestPlan(raw: string): Digest {
  return parsePlanText(raw)[0] as Digest;
}
export const digestForModel = (d: Digest) => {
  const model = {
    version: 2,
    statementId: d.statementId ?? "legacy",
    sql: d.sql.slice(0, 4000),
    sql_truncated: !!d.sqlTruncated || d.sql.length > 4000,
    subtreeCost: d.subtreeCost,
    costMeaning:
      "SQL Server optimizer estimate; not measured runtime or a percentage",
    actual: d.actual ?? d.topOperators.some((o) => o.actualRows !== null),
    parallel: d.parallel,
    nonParallelReason: d.nonParallelReason,
    earlyAbort: d.earlyAbort,
    tables: d.tables.slice(0, 20),
    topOperators: d.topOperators,
    rowGuessErrors: d.rowGuessErrors,
    missingIndexes: d.missingIndexes.slice(0, 5),
    warnings: d.warnings.slice(0, 20),
    waits: d.waits,
    evidence: structuredClone(d.evidence?.slice(0, 45) ?? []),
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
  while (JSON.stringify(model).length > 48000 && model.evidence.length)
    model.evidence.pop();
  while (JSON.stringify(model).length > 48000 && model.warnings.length)
    model.warnings.pop();
  if (model.evidence.length < (d.evidence?.length ?? 0))
    model.coverage.push(
      "Evidence list reduced to fit the model context budget.",
    );
  return model;
};
