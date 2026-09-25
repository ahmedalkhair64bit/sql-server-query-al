// Before/after comparison of two statement digests: did the applied option actually help?
// Measured values (actual plans) decide the verdict; estimated cost only decides when neither side
// has runtime data, and the result says so. Pure module: no Node or React imports.
import { detectFindings } from "./findings.mjs";

const sum = (ops, k) => {
  const vals = (ops ?? [])
    .map((o) => o[k])
    .filter((v) => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};
const metric = (label, unit, before, after, lowerIsBetter = true) => {
  const change =
    before == null || after == null
      ? null
      : before === 0
        ? after === 0
          ? 0
          : null
        : (after - before) / before;
  return { label, unit, before, after, change, lowerIsBetter };
};

/**
 * @returns {{
 *   basis: "measured" | "estimated",
 *   verdict: "improved" | "regressed" | "unchanged" | "inconclusive",
 *   summary: string,
 *   sameQuery: boolean | null,
 *   metrics: ReturnType<typeof metric>[],
 *   resolved: { rule: string, title: string }[],
 *   remaining: { rule: string, title: string }[],
 *   introduced: { rule: string, title: string }[],
 * }}
 */
export function compareDigests(before, after) {
  const measured = !!(
    before.queryTime?.elapsedMs != null && after.queryTime?.elapsedMs != null
  );
  const metrics = [
    metric(
      "Elapsed time",
      "ms",
      before.queryTime?.elapsedMs ?? null,
      after.queryTime?.elapsedMs ?? null,
    ),
    metric(
      "CPU time",
      "ms",
      before.queryTime?.cpuMs ?? null,
      after.queryTime?.cpuMs ?? null,
    ),
    metric(
      "Logical reads (top operators)",
      "pages",
      sum(before.topOperators, "logicalReads"),
      sum(after.topOperators, "logicalReads"),
    ),
    metric(
      "Memory granted",
      "KB",
      before.memoryGrant?.grantedKb ?? null,
      after.memoryGrant?.grantedKb ?? null,
    ),
    metric(
      "Memory used",
      "KB",
      before.memoryGrant?.maxUsedKb ?? null,
      after.memoryGrant?.maxUsedKb ?? null,
    ),
    metric(
      "Estimated subtree cost",
      "units",
      before.subtreeCost ?? null,
      after.subtreeCost ?? null,
    ),
    metric(
      "Warnings",
      "",
      before.warnings?.length ?? 0,
      after.warnings?.length ?? 0,
    ),
  ].filter((m) => m.before != null || m.after != null);

  const fb = detectFindings(before).filter((f) => f.severity !== "info");
  const fa = detectFindings(after).filter((f) => f.severity !== "info");
  const rulesAfter = new Set(fa.map((f) => f.rule));
  const rulesBefore = new Set(fb.map((f) => f.rule));
  const pick = (f) => ({ rule: f.rule, title: f.title });
  const resolved = fb.filter((f) => !rulesAfter.has(f.rule)).map(pick);
  const remaining = fa.filter((f) => rulesBefore.has(f.rule)).map(pick);
  const introduced = fa.filter((f) => !rulesBefore.has(f.rule)).map(pick);

  const byLabel = Object.fromEntries(metrics.map((m) => [m.label, m]));
  let verdict = "inconclusive",
    summary;
  if (measured) {
    const elapsed = byLabel["Elapsed time"].change,
      cpu = byLabel["CPU time"]?.change ?? 0;
    if (elapsed === null) verdict = "inconclusive";
    else if (elapsed <= -0.2 && (cpu ?? 0) < 0.2) verdict = "improved";
    else if (elapsed >= 0.2 || (cpu ?? 0) >= 0.5) verdict = "regressed";
    else verdict = "unchanged";
    summary = {
      improved:
        "Measured elapsed time dropped by at least 20% without a CPU regression.",
      regressed:
        "Measured elapsed or CPU time went up. Roll back or review before keeping the change.",
      unchanged:
        "Measured time moved less than 20%: the change did not clearly help this execution.",
      inconclusive: "Elapsed time was zero or missing on one side.",
    }[verdict];
  } else {
    const cost = byLabel["Estimated subtree cost"]?.change;
    if (cost == null) verdict = "inconclusive";
    else if (cost <= -0.2) verdict = "improved";
    else if (cost >= 0.2) verdict = "regressed";
    else verdict = "unchanged";
    summary =
      verdict === "inconclusive"
        ? "Neither plan has runtime data or a comparable cost. Upload actual execution plans."
        : "Based on estimated cost only: upload actual execution plans (before and after) to measure the change.";
  }
  if (
    introduced.some((f) =>
      ["tempdb_spill", "row_estimate_error", "large_scan"].includes(f.rule),
    ) &&
    verdict === "improved"
  )
    summary += " New warnings appeared; check them before keeping the change.";
  const sameQuery =
    before.queryHash && after.queryHash
      ? before.queryHash === after.queryHash
      : null;
  return {
    basis: measured ? "measured" : "estimated",
    verdict,
    summary,
    sameQuery,
    metrics,
    resolved,
    remaining,
    introduced,
  };
}
