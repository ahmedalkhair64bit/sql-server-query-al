// A ready-to-run T-SQL script per option that proves (or disproves) it on the DBA's own server:
// baseline and after measurements, the existing indexes and statistics to check first, a result
// comparison for rewrites, Query Store history, and the rollback. Generated from the digest and the
// option, never by a model, so it cannot invent anything. Pure module: no Node or React imports.
import { parseDdl } from "./sql-check.mjs";

const q = (s) => `N'${String(s).replace(/'/g, "''")}'`;
const bracket = (parts) =>
  parts.map((p) => `[${p.replace(/]/g, "]]")}]`).join(".");

/** DECLARE the statement's parameters with the runtime values the plan recorded. */
export function parameterDeclarations(d) {
  return (d.parameters ?? [])
    .filter((p) => /^@\w+$/.test(p.name ?? ""))
    .map((p) => {
      const raw = p.runtime ?? p.compiled;
      const value = raw == null ? "NULL" : raw.replace(/^\((.*)\)$/s, "$1");
      return p.type
        ? `DECLARE ${p.name} ${p.type} = ${value};`
        : `-- DECLARE ${p.name} <data type> = ${value};  (the plan did not record the type)`;
    });
}

/** Drop a trailing top-level ORDER BY so the query can sit inside a derived table (unless TOP/OFFSET needs it). */
function withoutOrderBy(sql) {
  const s = sql.trim().replace(/;\s*$/, "");
  if (/\bTOP\b|\bOFFSET\b/i.test(s)) return s;
  let depth = 0,
    cut = -1;
  const upper = s.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (
      depth === 0 &&
      upper.startsWith("ORDER BY", i) &&
      /\s/.test(s[i - 1] ?? " ")
    )
      cut = i;
  }
  return cut === -1 ? s : s.slice(0, cut).trim();
}

const isSelect = (sql) => /^\s*(WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(sql ?? "");

function tablesTouched(c, d) {
  const ddl = c.sql_to_run ? parseDdl(c.sql_to_run) : null;
  const named = [...(ddl?.indexes ?? []), ...(ddl?.statistics ?? [])].map(
    (x) => x.table,
  );
  const fromPlan = (d.tables ?? []).map((t) => t.split("."));
  // Prefer the tables the option changes; fall back to the plan's tables for rewrites and ops changes.
  const list = named.length ? named : fromPlan;
  const seen = new Set();
  return list
    .map((parts) => parts.slice(-2))
    .filter((parts) => {
      const k = parts.join(".").toLowerCase();
      return !seen.has(k) && seen.add(k);
    })
    .slice(0, 5);
}

/** @returns {string} */
export function buildValidationScript(c, d) {
  const out = [];
  const line = (s = "") => out.push(s);
  const truncated = !!d.sqlTruncated || (d.sql ?? "").length > 64000;
  const params = parameterDeclarations(d);
  const original = (d.sql ?? "").trim();

  line(`/* Validation script for option "${c.key}": ${c.title}`);
  line(
    "   Generated from the plan evidence. Run on a test or restored copy first.",
  );
  line("   Compare the STATISTICS IO/TIME output of step 1 and step 4. */");
  line();
  if (params.length) {
    line(
      "/* Parameters, with the runtime values from the plan. Keep these lines with any step you run on its own. */",
    );
    params.forEach((p) => line(p));
    line();
  }

  line("/* 1. Baseline: measure the current statement. */");
  if (original && !truncated) {
    line("SET STATISTICS IO, TIME ON;");
    line(original.replace(/;?\s*$/, ";"));
    line("SET STATISTICS IO, TIME OFF;");
  } else
    line(
      "-- The plan did not include the complete statement text: run the original from the application or procedure.",
    );
  line();

  line("/* 2. Check what already exists before changing anything. */");
  for (const t of tablesTouched(c, d)) {
    const obj = q(bracket(t));
    line(
      `-- Indexes on ${t.join(".")}: look for one that already covers the option's keys.`,
    );
    line(
      `SELECT i.name, i.type_desc, i.is_unique, i.has_filter,
       STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c
              ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
              ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS key_columns,
       STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c
              ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
              FOR XML PATH('')), 1, 2, '') AS included_columns,
       us.user_seeks, us.user_scans, us.user_lookups, us.user_updates
FROM sys.indexes i
LEFT JOIN sys.dm_db_index_usage_stats us
  ON us.object_id = i.object_id AND us.index_id = i.index_id AND us.database_id = DB_ID()
WHERE i.object_id = OBJECT_ID(${obj});`,
    );
    line(`-- Statistics freshness on ${t.join(".")}.`);
    line(
      `SELECT s.name, sp.last_updated, sp.rows, sp.rows_sampled, sp.modification_counter
FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id = OBJECT_ID(${obj});`,
    );
  }
  line();

  line(
    "/* 3. Apply the change (review first; this is the option's SQL, unaltered). */",
  );
  if (c.sql_to_run && c.option_type !== "rewrite") line(c.sql_to_run.trim());
  else if (c.option_type === "rewrite")
    line(
      "-- The rewrite replaces the statement in the application; nothing to apply on the server.",
    );
  else line("-- This option has no SQL to run: follow its steps.");
  line();

  line("/* 4. Measure again with the same parameters. */");
  const after =
    c.option_type === "rewrite" && c.sql_to_run
      ? c.sql_to_run.trim()
      : original;
  if (after && !(truncated && c.option_type !== "rewrite")) {
    line("SET STATISTICS IO, TIME ON;");
    line(after.replace(/;?\s*$/, ";"));
    line("SET STATISTICS IO, TIME OFF;");
  } else
    line("-- Re-run the original statement from the application and compare.");
  line(
    '-- Capture the new actual plan and upload it with "Compare with an after plan".',
  );
  line();

  if (
    c.option_type === "rewrite" &&
    c.sql_to_run &&
    original &&
    !truncated &&
    isSelect(original) &&
    isSelect(c.sql_to_run)
  ) {
    line(
      "/* 5. Prove the rewrite returns the same rows: both counts must be 0, and the row counts equal. */",
    );
    const a = withoutOrderBy(original),
      b = withoutOrderBy(c.sql_to_run);
    line(
      `SELECT 'only in original' AS side, COUNT(*) AS row_count FROM (\n${a}\nEXCEPT\n${b}\n) AS diff`,
    );
    line(
      `UNION ALL SELECT 'only in rewrite', COUNT(*) FROM (\n${b}\nEXCEPT\n${a}\n) AS diff`,
    );
    line(`UNION ALL SELECT 'original rows', COUNT(*) FROM (\n${a}\n) AS o`);
    line(`UNION ALL SELECT 'rewrite rows', COUNT(*) FROM (\n${b}\n) AS r;`);
    line(
      "-- EXCEPT ignores duplicates: equal row counts plus zero differences is the check.",
    );
    line();
  }

  // The hash is a plan attribute: only a plain hex literal is ever written into the script.
  if (/^0x[0-9A-F]{1,32}$/i.test(d.queryHash ?? "")) {
    line(
      "/* Query Store: runtime history for this query shape, per plan (requires Query Store ON). */",
    );
    line(
      `SELECT p.plan_id, p.last_execution_time, SUM(rs.count_executions) AS executions,
       AVG(rs.avg_duration) / 1000.0 AS avg_duration_ms, AVG(rs.avg_cpu_time) / 1000.0 AS avg_cpu_ms,
       AVG(rs.avg_logical_io_reads) AS avg_logical_reads, MAX(rs.max_used_memory) * 8 AS max_memory_kb
FROM sys.query_store_query q
JOIN sys.query_store_plan p ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
WHERE q.query_hash = ${d.queryHash}
GROUP BY p.plan_id, p.last_execution_time
ORDER BY p.last_execution_time DESC;`,
    );
    line();
  }

  line("/* Rollback */");
  const ddl = c.sql_to_run ? parseDdl(c.sql_to_run) : null;
  for (const ix of ddl?.indexes ?? [])
    line(`-- DROP INDEX ${bracket([ix.name])} ON ${bracket(ix.table)};`);
  for (const s of (ddl?.statistics ?? []).filter((s) => s.create))
    line(`-- DROP STATISTICS ${bracket([...s.table.slice(-2), s.name])};`);
  for (const r of c.rollback ?? []) line(`-- ${String(r).replace(/\n/g, " ")}`);
  if (!ddl?.indexes.length && !c.rollback?.length)
    line("-- Record the current configuration before changing it.");
  return out.join("\n");
}
