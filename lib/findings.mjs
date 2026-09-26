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
        `Last updated ${s.lastUpdate ?? "unknown"}. ` +
          (actual && !errors.length
            ? "Every row estimate in this actual plan is within 10x, so these statistics are not what makes it slow: refreshing them will not change this plan."
            : "UPDATE STATISTICS ... WITH FULLSCAN (or a higher sample) is a cheap first test when estimates are wrong."),
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

  // Parallel threads doing very different amounts of work.
  for (const o of ops.filter((o) => o.threadSkew))
    add(
      "parallel_skew",
      "warning",
      `Parallel work is uneven (${o.threadSkew}x the average on one thread)`,
      `${op(o)}: one thread processed most rows while the others waited. Usually skewed data in the ` +
        "partitioning column or a bad estimate on the parallel branch; CXPACKET/CXCONSUMER waits often follow.",
      o.id,
    );

  // The optimizer builds a temporary index on every execution.
  for (const o of ops.filter(
    (o) =>
      /Index Spool/i.test(o.op) ||
      (/Spool/i.test(o.op) && /Eager/i.test(o.logicalOp ?? "")),
  ))
    add(
      "index_spool",
      /Index Spool/i.test(o.op) ? "warning" : "info",
      `${o.op} (${o.logicalOp ?? "spool"}) in the plan`,
      `${op(o)}: ${/Index Spool/i.test(o.op) ? "the optimizer builds a temporary index at run time because no suitable permanent index exists. A permanent index on the spooled columns usually removes it." : "an eager spool buffers rows, often for Halloween protection or a repeated subtree."}`,
      o.id,
    );

  // Sort doing a large share of the work.
  for (const o of ops.filter((o) => /Sort/i.test(o.op))) {
    const share =
      actual && d.queryTime?.elapsedMs
        ? (o.actualElapsedMs ?? 0) / d.queryTime.elapsedMs
        : d.subtreeCost
          ? o.cost / d.subtreeCost
          : 0;
    if (share >= 0.3 && (o.actualRows ?? o.estRows) >= 100000)
      add(
        "expensive_sort",
        "warning",
        `Sort takes ${Math.round(share * 100)}% of the ${actual ? "measured time" : "estimated cost"}`,
        `${op(o)} sorts ${fmt(o.actualRows ?? o.estRows)} rows. An index that already delivers the ORDER BY / GROUP BY order, or fewer rows reaching the sort, avoids it.`,
        o.id,
      );
  }

  // The inner side of a nested loop runs a huge number of times (lookups are reported above).
  for (const o of ops)
    if (!o.lookup && actual && (o.execs ?? 0) >= 100000)
      add(
        "many_executions",
        "warning",
        `Operator executed ${fmt(o.execs)} times`,
        `${op(o)} runs once per outer row. Check whether the outer input is far larger than estimated; a hash or merge join, or fewer outer rows, may be cheaper.`,
        o.id,
      );

  // Predicates the optimizer cannot seek on.
  const NON_SARGABLE =
    /\b(YEAR|MONTH|DAY|DATEPART|DATEDIFF|DATEADD|CONVERT|CAST|ISNULL|COALESCE|UPPER|LOWER|LTRIM|RTRIM|TRIM|SUBSTRING|LEFT|RIGHT|REPLACE|ABS)\s*\([^)]*\[[^\]]+\]\.\[[^\]]+\]/i;
  for (const o of ops.filter((o) => /Scan/i.test(o.op) && o.predicate)) {
    const fn =
      NON_SARGABLE.test(o.predicate) && !/CONVERT_IMPLICIT/i.test(o.predicate);
    const like = /like\s+N?'%/i.test(o.predicate);
    if (fn || like)
      add(
        "non_sargable",
        "warning",
        like
          ? "Leading-wildcard LIKE forces a scan"
          : "A function wraps a column in the predicate",
        `${op(o)}: ${o.predicate.slice(0, 200)}. ${
          like
            ? "LIKE '%...' cannot use an index seek; consider full-text search or a different match."
            : "Rewrite so the column stands alone (for example a date range instead of YEAR(col) = 2024) to allow a seek."
        }`,
        o.id,
      );
  }

  // A row goal made the optimizer plan for a few rows.
  for (const o of ops.filter((o) => o.rowGoal))
    if (
      !actual ||
      (o.actualRows ?? 0) >= 10 * Math.max(o.estRows * (o.estExecs ?? 1), 1)
    )
      add(
        "row_goal",
        actual ? "warning" : "info",
        "A row goal (TOP, EXISTS, FAST n) shaped the plan",
        `${op(o)} was costed for ${fmt(o.estRows)} rows because the optimizer expected to stop early${
          actual ? `, but ${fmt(o.actualRows ?? 0)} rows flowed` : ""
        }. When the early stop does not happen, the chosen nested loops are costly; USE HINT('DISABLE_OPTIMIZER_ROWGOAL') is a test.`,
        o.id,
      );

  // Where the time went, according to the plan's own wait statistics.
  const elapsed = d.queryTime?.elapsedMs ?? 0;
  const top = [...(d.waits ?? [])].sort((a, b) => b.ms - a.ms)[0];
  if (top && elapsed > 0 && top.ms >= 0.25 * elapsed) {
    // Waits are summed over every thread, so in a parallel plan they can exceed the wall-clock time.
    const share =
      top.ms > elapsed
        ? `${fmt(top.ms)} ms, summed across parallel threads (more than the ${fmt(elapsed)} ms elapsed)`
        : `${Math.round((100 * top.ms) / elapsed)}% of elapsed time`;
    const kind = [
      [
        /^LCK_M_/,
        "blocking",
        "critical",
        "Waiting on locks held by other sessions: the plan is not the main problem. Find the blocker (sys.dm_exec_requests, blocked process report) before tuning this query.",
      ],
      [
        /^PAGEIOLATCH_/,
        "io",
        "warning",
        "Reading pages from disk. Fewer reads (a better index) or more buffer pool memory helps; check storage latency.",
      ],
      [
        /^(CXPACKET|CXCONSUMER|CXSYNC_PORT)/,
        "parallelism",
        "warning",
        "Threads waiting on each other in a parallel plan: often skew or an oversized degree of parallelism.",
      ],
      [
        /^RESOURCE_SEMAPHORE/,
        "memory",
        "critical",
        "Queued for a memory grant. Oversized grants on this or other queries are the usual cause.",
      ],
      [
        /^ASYNC_NETWORK_IO/,
        "client",
        "warning",
        "The client consumed results slowly: the server was waiting on the application, not on the plan.",
      ],
      [
        /^SOS_SCHEDULER_YIELD/,
        "cpu",
        "warning",
        "CPU pressure: the query was runnable but waiting for a scheduler.",
      ],
      [
        /^WRITELOG/,
        "log",
        "warning",
        "Waiting on transaction log writes: check log storage latency and commit frequency.",
      ],
    ].find(([re]) => re.test(top.type));
    add(
      kind ? `wait_${kind[1]}` : "wait_other",
      kind ? kind[2] : "info",
      `${top.type} waits took ${share}`,
      kind ? kind[3] : "The plan's wait statistics show where the time went.",
    );
  }

  if (d.incompleteExecution)
    add(
      "incomplete_execution",
      "critical",
      "This execution did not finish",
      "The query was cancelled, timed out or failed before the top operator completed. Row counts, reads and " +
        "times are partial: they show where the query was when it stopped, not its full cost. The operator " +
        "with the most time is where it was stuck. If it failed with an error, fix the error first.",
    );
  if (!actual)
    add(
      "estimated_plan",
      "info",
      "Estimated plan: no runtime evidence",
      "Row counts and costs are the optimizer's guesses. Capture the actual execution plan to confirm the bottleneck before changing anything.",
    );
  if ((d.compileMs ?? 0) >= 1000)
    add(
      "high_compile_time",
      (d.compileMs ?? 0) >= 5000 ? "warning" : "info",
      `Compilation took ${fmt(d.compileMs)} ms`,
      "A complex statement or frequent recompiles. If it recompiles often, check OPTION (RECOMPILE), temp table schema changes and statistics updates.",
    );
  if (
    (d.coverage ?? []).some((c) =>
      /Contains RemoteQuery|Contains ExternalSelect/.test(c),
    )
  )
    add(
      "remote_query",
      "warning",
      "Linked server or external query in the plan",
      "Remote data is estimated poorly and filtered late. Push the filter to the remote side (OPENQUERY) or stage the rows locally.",
    );
  if ((d.coverage ?? []).some((c) => /StmtCursor/.test(c)))
    add(
      "cursor",
      "warning",
      "Cursor statement",
      "Row-by-row processing. A set-based rewrite is usually much faster; at least use LOCAL FAST_FORWARD.",
    );
  if (warnings.some((w) => /UnmatchedIndexes/.test(w)))
    add(
      "unmatched_indexes",
      "warning",
      "A filtered index could not be used",
      "The statement is parameterized, so the optimizer cannot prove the filter matches. OPTION (RECOMPILE) or literal values let it use the index.",
    );

  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
