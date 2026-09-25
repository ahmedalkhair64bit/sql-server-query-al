// Deterministic plan checks. Each rule reads only the stored digest, so it runs the same on the server
// (model evidence), in the browser (the report), and in the evaluation set. The LLM is asked to explain
// these findings, not to rediscover them; Jev's evidence check can lean on them.
// Pure module: no Node or React imports.

const KB_PER_MB = 1024;
const fmt = (v) => Number(v).toLocaleString("en-US");
const op = (o) => `Node ${o.id} ${o.op}${o.object ? ` on ${o.object}` : ""}`;

/** @returns {{ rule: string, severity: "critical" | "warning" | "info", node?: string, title: string, detail: string }[]} */
export function detectFindings(d) {
  const out = [];
  const add = (rule, severity, title, detail, node) =>
    out.push({
      rule,
      severity,
      title,
      detail,
      ...(node != null ? { node } : {}),
    });
  const ops = d.topOperators ?? [];
  const warnings = d.warnings ?? [];
  const errors = d.rowGuessErrors ?? [];
  const actual = !!d.actual;

  // Key lookup repeated many times: a covering index usually removes it.
  for (const o of ops) {
    const execs = actual ? (o.execs ?? 0) : (o.estExecs ?? 1);
    if (o.lookup && execs >= 1000)
      add(
        "key_lookup",
        execs >= 10000 || (o.logicalReads ?? 0) >= 100000
          ? "critical"
          : "warning",
        `Key lookup executed ${fmt(execs)} times`,
        `${op(o)} runs once per outer row${o.logicalReads ? ` (${fmt(o.logicalReads)} logical reads)` : ""}. ` +
          `A covering index that includes the looked-up columns removes it.`,
        o.id,
      );
  }

  // Parameter sensitivity: compiled for one value, ran with another, and estimates are badly off.
  const differs = (d.parameters ?? []).filter((p) => p.differs);
  if (differs.length) {
    const bigMiss = errors.some((r) => r.ratio === null || r.ratio >= 10);
    add(
      "parameter_sniffing",
      bigMiss ? "critical" : "info",
      bigMiss
        ? "Plan compiled for different parameter values, and row estimates are far off"
        : "Plan compiled for different parameter values than it ran with",
      differs
        .slice(0, 5)
        .map((p) => `${p.name} compiled ${p.compiled}, ran ${p.runtime}`)
        .join("; ") +
        (bigMiss
          ? ". The cached plan fits the compiled value, not this one: consider OPTIMIZE FOR, OPTION (RECOMPILE) or PSP optimization."
          : "."),
    );
  }

  // Memory grant far larger than what was used starves concurrent queries.
  const g = d.memoryGrant;
  if (g?.grantedKb != null && g.maxUsedKb != null) {
    if (
      g.grantedKb >= 100 * KB_PER_MB &&
      g.grantedKb >= 10 * Math.max(g.maxUsedKb, 1)
    )
      add(
        "excessive_memory_grant",
        g.grantedKb >= 1024 * KB_PER_MB ? "critical" : "warning",
        `Memory grant ${fmt(Math.round(g.grantedKb / KB_PER_MB))} MB, used ${fmt(Math.round(g.maxUsedKb / KB_PER_MB))} MB`,
        "The optimizer over-estimated rows feeding a sort or hash. Fix the estimate (statistics, predicates) or let memory grant feedback adjust.",
      );
    if (g.grantWaitMs > 0)
      add(
        "memory_grant_wait",
        "warning",
        `Waited ${fmt(g.grantWaitMs)} ms for a memory grant`,
        "The query queued on RESOURCE_SEMAPHORE before it could start.",
      );
  }

  // Spills to tempdb.
  const spills = warnings.filter((w) =>
    /SpillToTempDb|SortSpillDetails|HashSpillDetails|ExchangeSpillDetails/.test(
      w,
    ),
  );
  const spillOps = ops.filter((o) => o.spillLevels != null);
  if (spills.length || spillOps.length)
    add(
      "tempdb_spill",
      "warning",
      "An operator spilled to tempdb",
      (spills.length
        ? spills.slice(0, 3).join("; ")
        : spillOps.map(op).join("; ")) +
        ". The memory grant was too small for the actual rows, usually from an under-estimate.",
      spillOps[0]?.id,
    );

  // Implicit conversions that prevent a seek.
  for (const w of warnings
    .filter((w) => /PlanAffectingConvert/.test(w))
    .slice(0, 3)) {
    const seek = /ConvertIssue=Seek Plan/.test(w);
    add(
      "implicit_conversion",
      seek ? "critical" : "info",
      seek
        ? "Implicit conversion prevents an index seek"
        : "Implicit conversion may affect cardinality estimates",
      `${w}. Match the parameter or column data types so no CONVERT_IMPLICIT is needed.`,
    );
  }
  for (const o of ops)
    if (
      o.predicate &&
      /CONVERT_IMPLICIT/i.test(o.predicate) &&
      !warnings.some((w) => /PlanAffectingConvert/.test(w))
    )
      add(
        "implicit_conversion",
        "info",
        "Implicit conversion inside a predicate",
        `${op(o)} predicate: ${o.predicate.slice(0, 200)}`,
        o.id,
      );

  // Residual predicate: reads far more rows than it returns.
  for (const o of ops) {
    const read = actual ? o.rowsRead : o.estRowsRead;
    const returned = actual
      ? (o.actualRows ?? 0)
      : o.estRows * (o.estExecs ?? 1);
    if (read != null && read >= 10000 && read >= 10 * Math.max(returned, 1))
      add(
        "residual_predicate",
        read >= 100 * Math.max(returned, 1) ? "critical" : "warning",
        `Reads ${fmt(read)} rows to return ${fmt(Math.round(returned))}`,
        `${op(o)} filters after reading${o.predicate ? `: ${o.predicate.slice(0, 200)}` : ""}. ` +
          "An index whose keys match the predicate, or a sargable rewrite, turns this into a seek.",
        o.id,
      );
  }

  // Large scans in an actual plan.
  for (const o of ops)
    if (/Scan/.test(o.op) && !o.lookup && (o.logicalReads ?? 0) >= 100000)
      add(
        "large_scan",
        "warning",
        `${o.op} with ${fmt(o.logicalReads)} logical reads`,
        `${op(o)} reads a large share of the object.`,
        o.id,
      );

  // Cardinality estimate errors.
  // One finding: a bad estimate propagates to every parent, so the same miss repeats up the tree.
  const bad = errors.filter((r) => r.ratio === null || r.ratio >= 100);
  if (bad.length) {
    const r = bad[0];
    add(
      "row_estimate_error",
      r.ratio === null || r.ratio >= 1000 ? "critical" : "warning",
      `Row estimate off by ${r.ratio === null ? "a zero-row guess" : `${fmt(Math.round(r.ratio))}x`}`,
      `Node ${r.id} ${r.op}: estimated ${fmt(r.est)} rows per execution, got ${fmt(r.actual)}.` +
        (bad.length > 1
          ? ` Also off by 100x or more: ${bad
              .slice(1)
              .map((x) => `node ${x.id} ${x.op}`)
              .join(", ")}.`
          : ""),
      r.id,
    );
  }

  // Statistics that are stale or thinly sampled.
  for (const s of (d.statistics ?? []).slice(0, 20)) {
    const stale = (s.modifications ?? 0) >= 50000;
    const thin = s.samplingPercent != null && s.samplingPercent < 5;
    if (stale || thin)
      add(
        "stale_statistics",
        stale && errors.length ? "warning" : "info",
        `Statistics ${s.name} on ${s.table}${stale ? ` have ${fmt(s.modifications)} modifications` : ""}${
          thin
            ? `${stale ? " and" : ""} were sampled at ${s.samplingPercent}%`
            : ""
        }`,
        `Last updated ${s.lastUpdate ?? "unknown"}. UPDATE STATISTICS ... WITH FULLSCAN (or a higher sample) is a cheap first test when estimates are wrong.`,
      );
  }
  if (warnings.some((w) => /ColumnsWithNoStatistics/.test(w)))
    add(
      "missing_statistics",
      "info",
      "Columns have no statistics",
      warnings
        .filter((w) => /ColumnsWithNoStatistics column=/.test(w))
        .slice(0, 5)
        .join("; ") || "The optimizer guessed selectivity for some columns.",
    );

  // Scalar UDFs force serial, row-by-row execution.
  const udf =
    /UserDefinedFunction|UDF/i.test(d.nonParallelReason ?? "") ||
    (d.coverage ?? []).some((c) => /Contains UDF/.test(c)) ||
    (d.queryTime?.udfCpuMs ?? 0) > 0;
  if (udf)
    add(
      "scalar_udf",
      "warning",
      "Scalar user-defined function in the plan",
      `${d.nonParallelReason ? `Non-parallel reason: ${d.nonParallelReason}. ` : ""}${
        d.queryTime?.udfCpuMs ? `UDF CPU ${fmt(d.queryTime.udfCpuMs)} ms. ` : ""
      }Scalar UDFs run once per row and block parallelism; inline them or check UDF inlining (compatibility level 150+).`,
    );

  // Table variables estimate one row (before SQL Server 2019 deferred compilation).
  for (const o of ops)
    if (
      (o.object ?? "").includes("@") &&
      o.estRows <= 1 &&
      (o.actualRows ?? 0) >= 1000
    )
      add(
        "table_variable",
        "warning",
        "Table variable estimated at 1 row",
        `${op(o)} returned ${fmt(o.actualRows)} rows. Use a temp table, or enable deferred compilation (compatibility level 150+).`,
        o.id,
      );

  if (warnings.some((w) => /NoJoinPredicate/.test(w)))
    add(
      "no_join_predicate",
      "critical",
      "Join without a join predicate",
      "A cross join may be accidental. Check the JOIN ... ON conditions.",
    );

  if (d.earlyAbort === "TimeOut")
    add(
      "optimizer_timeout",
      "info",
      "Optimizer timed out",
      "The plan is the best found before the optimizer stopped searching, not necessarily a good one. Simplifying the query often helps.",
    );

  for (const m of d.missingIndexes ?? [])
    if (m.impact >= 50)
      add(
        "missing_index",
        m.impact >= 80 ? "warning" : "info",
        `Missing index suggested on ${m.table} (impact ${m.impact}%)`,
        `Keys: ${[...m.equality, ...m.inequality].join(", ") || "none"}${
          m.included.length ? `; include: ${m.included.join(", ")}` : ""
        }. The optimizer's impact is an estimate; check existing indexes before creating one.`,
      );

  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
