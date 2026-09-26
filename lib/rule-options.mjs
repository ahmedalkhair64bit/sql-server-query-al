// Fix options built by rule from the plan itself, next to the analyst model's options.
//
// Why: Jev only chooses among the options it is given. Measured on real plans with a real model, the analyst
// sometimes split a fix into halves that do nothing alone (a SARGable rewrite with no index to seek; an index
// under YEAR() that cannot be sought) or missed the index a spool was begging for, and Jev's pick drifted
// between runs. For patterns whose fix is determined by the plan, a rule writes the complete option with the
// exact table, key, order and INCLUDE columns, every time the same. The model adds judgement and
// alternatives; Jev decides between all of them.
//
// Each builder stays silent unless every fact it needs is in the plan. A wrong rule option would be worse
// than none: the guards are deliberately strict.
//
// Pure module: no Node or React imports (the parse worker and the browser may load it).
import { detectFindings } from "./findings.mjs";
import { indexesOf } from "./schema-context.mjs";

const bracket = (s) => `[${String(s).replace(/]/g, "]]")}]`;
/** "Db.dbo.Table" -> "[dbo].[Table]": the plan names the database, the statement runs in it. */
const sqlTable = (full) => {
  const parts = String(full).split(".");
  return parts.slice(-2).map(bracket).join(".");
};
const shortTable = (full) => String(full).split(".").at(-1);
const indexName = (table, keys) =>
  `IX_${shortTable(table)}_${keys.join("_")}`
    .replace(/[^\w]/g, "_")
    .slice(0, 120);
const unique = (xs) => [...new Set(xs)];
const lc = (s) => String(s).toLowerCase();
const keyNamesOf = (keys) =>
  keys.map((k) => (typeof k === "string" ? k : k.column));
const createIndexNamed = (name, table, keys, include = []) => {
  const keySql = keys
    .map((k) =>
      typeof k === "string"
        ? bracket(k)
        : `${bracket(k.column)}${k.desc ? " DESC" : ""}`,
    )
    .join(", ");
  const keyNames = keys.map((k) => (typeof k === "string" ? k : k.column));
  const inc = unique(include.filter((c) => !keyNames.map(lc).includes(lc(c))));
  return (
    `CREATE NONCLUSTERED INDEX ${bracket(name)} ON ${sqlTable(table)} (${keySql})` +
    (inc.length ? ` INCLUDE (${inc.map(bracket).join(", ")})` : "") +
    ";"
  );
};
const option = (o) => ({
  version: 2,
  source: "rule",
  rejected_reasons: [],
  check_warnings: [],
  prerequisites: [],
  validation: [],
  rollback: [],
  ...o,
});
const INDEX_VALIDATION = (sid, opId) => [
  `Capture the actual plan before and after; node ${opId} should disappear or become an index seek on the new index.`,
  "Compare logical reads, CPU and elapsed time (SET STATISTICS IO, TIME ON) on the same parameter values.",
];
const INDEX_PREREQ = [
  "Check the index does not duplicate an existing one (sp_helpindex) and that write overhead on the table is acceptable.",
  "Create it in a maintenance window or WITH (ONLINE = ON) on editions that support it.",
];

/**
 * @param digest the statement digest (lib/digest.ts)
 * @returns Candidate-shaped options, most important first (at most 3)
 */
/**
 * What the operator costs, measured when the plan is actual: the fact that tells a reviewer (and Jev) how
 * much of the statement this fix can remove. Jev's confidence in the fit of rule options was 0.33 without
 * it, just under the gate, although the spool it targeted took half the elapsed time.
 */
function impactOf(d, o) {
  const total = d.queryTime?.elapsedMs;
  if (d.actual && o.actualElapsedMs > 0 && total > 0)
    return ` Measured: node ${o.id} spends ${Math.round(o.actualElapsedMs).toLocaleString("en-US")} ms of the statement's ${Math.round(total).toLocaleString("en-US")} ms on its own (${Math.round((100 * o.actualElapsedMs) / total)}%)${o.logicalReads ? ` and does ${o.logicalReads.toLocaleString("en-US")} logical reads` : ""}${o.execs > 1 ? ` over ${o.execs.toLocaleString("en-US")} executions` : ""}.`;
  if (o.cost > 0 && d.subtreeCost > 0)
    return ` Estimated: node ${o.id} is ${Math.round((100 * o.cost) / d.subtreeCost)}% of the statement's estimated cost${o.execs > 1 ? ` and ran ${o.execs.toLocaleString("en-US")} times` : ""}.`;
  return "";
}

export function ruleOptions(digest) {
  const d = digest;
  // Never reuse the name of an index the plan already shows on that table.
  const existingNames = new Set(
    (d.indexes ?? []).map((i) => `${lc(i.table)}|${lc(i.index)}`),
  );
  const nameFor = (table, keys) => {
    const base = indexName(table, keys);
    for (const name of [base, `${base}_Covering`, `${base}_2`, `${base}_3`])
      if (!existingNames.has(`${lc(table)}|${lc(name)}`)) return name;
    return `${base}_${Date.now() % 1000}`;
  };
  const createIndex = (table, keys, include = []) =>
    createIndexNamed(nameFor(table, keyNamesOf(keys)), table, keys, include);
  const INDEX_ROLLBACK = (table, keys) => [
    `DROP INDEX ${bracket(nameFor(table, keys))} ON ${sqlTable(table)};`,
  ];
  const sid = d.statementId ?? "s1";
  const findings = detectFindings(d);
  const findingId = (rule) => {
    const i = findings.findIndex((f) => f.rule === rule);
    return i === -1 ? [] : [`${sid}:finding:${i}`];
  };
  const ops = d.topOperators ?? [];
  const out = [];

  // 1. Eager index spool: SQL Server builds a temporary index on every execution because a permanent one is
  //    missing. The spool's seek column, the ORDER BY above it and its output columns define that index.
  //    (A lazy spool caches by the outer column and is not an index request: skip it.)
  for (const o of ops) {
    if (o.op !== "Index Spool" || o.logicalOp !== "Eager Spool") continue;
    if (!o.sourceObject || !o.seekColumns?.length) continue;
    const table = o.sourceObject;
    const cols = (o.outputColumns ?? []).filter(
      (c) => !c.table || c.table === table,
    );
    const order = (o.orderAbove ?? []).filter(
      (c) => c.table === table && !o.seekColumns.map(lc).includes(lc(c.column)),
    );
    const keys = [
      ...o.seekColumns,
      ...order.map((c) => ({ column: c.column, desc: c.desc })),
    ];
    const keyNames = keys.map((k) => (typeof k === "string" ? k : k.column));
    out.push(
      option({
        key: `rule_index_for_spool_${o.id}`,
        title: `Create the index SQL Server keeps building at run time: ${shortTable(table)}(${keys
          .map((k) =>
            typeof k === "string" ? k : `${k.column}${k.desc ? " DESC" : ""}`,
          )
          .join(", ")})`,
        diagnosis: `Node ${o.id} is an eager index spool: for every execution the engine reads ${shortTable(table)} and builds a temporary index on ${o.seekColumns.join(", ")}, because no permanent index supports this seek${order.length ? ` in ${order.map((c) => c.column).join(", ")} order` : ""}.${impactOf(d, o)}`,
        actions: [
          {
            title: "Create the supporting index",
            detail: `Keys ${keyNames.join(", ")}${cols.length ? `, INCLUDE the columns the spool returns` : ""}, so the spool is replaced by an index seek.`,
            effort: "low",
            requires_change_control: true,
          },
        ],
        option_type: "index",
        sql_to_run: createIndex(
          table,
          keys,
          cols.map((c) => c.column),
        ),
        expected: `The index spool at node ${o.id} and the scan feeding it disappear; the inner side becomes an index seek.`,
        evidence_ids: [...findingId("index_spool"), `${sid}:operator:${o.id}`],
        prerequisites: INDEX_PREREQ,
        validation: INDEX_VALIDATION(sid, o.id),
        rollback: INDEX_ROLLBACK(table, keyNames),
      }),
    );
    break; // one spool index per plan; the largest spool comes first in topOperators
  }

  // 2. Key lookup repeated many times: cover it with the seek index's keys plus the looked-up columns.
  if (findings.some((f) => f.rule === "key_lookup")) {
    const lookup = ops.find(
      (o) => o.lookup && o.siblingBefore?.seekColumns?.length,
    );
    const table = lookup?.object?.split(".").slice(0, -1).join(".");
    const seekTable = lookup?.siblingBefore?.object
      ?.split(".")
      .slice(0, -1)
      .join(".");
    if (lookup && table && table === seekTable) {
      const keys = lookup.siblingBefore.seekColumns;
      const predicateCols = [
        ...(lookup.predicate ?? "").matchAll(
          /\[([^\]]+)\]\.\[([^\]]+)\](?!\.)/g,
        ),
      ]
        .map((m) => m[2])
        .filter((c) => !/^\d/.test(c));
      const include = unique([
        ...(lookup.outputColumns ?? [])
          .filter((c) => !c.table || c.table === table)
          .map((c) => c.column),
        ...predicateCols,
      ]);
      if (include.length && include.length <= 12) {
        const existing = lookup.siblingBefore.object.split(".").at(-1);
        out.push(
          option({
            key: `rule_cover_lookup_${lookup.id}`,
            title: `Cover the key lookup: index on ${shortTable(table)}(${keys.join(", ")}) INCLUDE (${include.join(", ")})`,
            diagnosis: `Node ${lookup.id} looks up ${include.join(", ")} in the clustered index for every row that ${existing} returns, because that index does not contain them.${impactOf(d, lookup)}`,
            actions: [
              {
                title: "Create a covering index",
                detail: `Same keys as ${existing} (${keys.join(", ")}), with the looked-up columns as INCLUDE. Alternatively add the INCLUDE columns to ${existing} with DROP_EXISTING.`,
                effort: "low",
                requires_change_control: true,
              },
            ],
            option_type: "index",
            sql_to_run: createIndex(table, keys, include),
            expected: `The key lookup at node ${lookup.id} and its nested loop disappear; the seek returns every column itself.`,
            evidence_ids: [
              ...findingId("key_lookup"),
              `${sid}:operator:${lookup.id}`,
            ],
            prerequisites: [
              `Consider extending ${existing} instead of adding a near-duplicate index.`,
              ...INDEX_PREREQ,
            ],
            validation: INDEX_VALIDATION(sid, lookup.id),
            rollback: INDEX_ROLLBACK(table, keys),
          }),
        );
      }
    }
  }

  // 3. YEAR(column) = literal in the statement: rewrite as a half-open range AND index the column. They are
  //    one fix: the range alone still scans without an index, the index alone cannot be sought under YEAR().
  if (
    findings.some((f) => f.rule === "non_sargable") &&
    d.sql &&
    !d.sqlTruncated
  ) {
    const matches = [
      ...d.sql.matchAll(
        /\bYEAR\s*\(\s*((?:\[?\w+\]?\s*\.\s*)*\[?(\w+)\]?)\s*\)\s*=\s*(\d{4})\b/gi,
      ),
    ];
    const scan = ops.find((o) =>
      new RegExp(
        `datepart\\s*\\(\\s*year\\s*,[^)]*\\[${matches[0]?.[2]}\\]`,
        "i",
      ).test(o.predicate ?? ""),
    );
    const table = scan?.object?.split(".").slice(0, -1).join(".");
    if (matches.length === 1 && scan && table) {
      const [whole, expr, column, year] = matches[0];
      const y = Number(year);
      const rewritten = d.sql.replace(
        whole,
        `${expr} >= '${y}0101' AND ${expr} < '${y + 1}0101'`,
      );
      const include = unique(
        (scan.outputColumns ?? [])
          .filter((c) => !c.table || c.table === table)
          .map((c) => c.column),
      );
      // The plan already scans a nonclustered index named for this column: the index exists, only YEAR()
      // stops it being sought. Then the rewrite alone is the fix.
      const scannedIndex =
        scan.op === "Index Scan" ? scan.object.split(".").at(-1) : null;
      const indexExists =
        !!scannedIndex && lc(scannedIndex).includes(lc(column));
      if (indexExists) {
        out.push(
          option({
            key: `rule_sargable_year_${column}`,
            title: `Rewrite YEAR(${column}) = ${y} as a date range so ${scannedIndex} can be sought`,
            diagnosis: `YEAR() around ${column} stops ${scannedIndex} being sought, so node ${scan.id} scans all of it and applies the function to every row.${impactOf(d, scan)}`,
            actions: [
              {
                title: "Rewrite the predicate as a half-open range",
                detail: `${column} >= '${y}0101' AND ${column} < '${y + 1}0101' returns the same rows for date and datetime columns.`,
                effort: "low",
                requires_change_control: true,
              },
            ],
            option_type: "rewrite",
            sql_to_run: rewritten.trim().replace(/;?$/, ";"),
            expected: `Node ${scan.id} becomes a seek on ${scannedIndex} over the ${column} range instead of a full scan.`,
            evidence_ids: [
              ...findingId("non_sargable"),
              `${sid}:operator:${scan.id}`,
            ],
            prerequisites: [
              `Confirm ${column} is a date/datetime type (a string column needs a different rewrite).`,
              `Confirm ${scannedIndex} leads with ${column}.`,
            ],
            validation: [
              "Run the old and new statements and compare the results: same rows, same count.",
              ...INDEX_VALIDATION(sid, scan.id),
            ],
            rollback: ["Deploy the original statement text again."],
          }),
        );
      } else if (include.length <= 8) {
        out.push(
          option({
            key: `rule_sargable_year_${column}`,
            title: `Rewrite YEAR(${column}) = ${y} as a date range and index ${column} (one change)`,
            diagnosis: `YEAR() around ${column} hides the column from any index, so node ${scan.id} reads the whole of ${shortTable(table)} and applies the function to every row.${impactOf(d, scan)}`,
            actions: [
              {
                title: `Create an index on ${column}`,
                detail: "So the range predicate has something to seek on.",
                effort: "low",
                requires_change_control: true,
              },
              {
                title: "Rewrite the predicate as a half-open range",
                detail: `${column} >= '${y}0101' AND ${column} < '${y + 1}0101' returns the same rows for date and datetime columns.`,
                effort: "low",
                requires_change_control: true,
              },
            ],
            option_type: "rewrite",
            sql_to_run: `${createIndex(table, [column], include)}\n${rewritten.trim().replace(/;?$/, ";")}`,
            expected: `Node ${scan.id} becomes an index seek on the ${column} range instead of a full scan.`,
            evidence_ids: [
              ...findingId("non_sargable"),
              `${sid}:operator:${scan.id}`,
            ],
            prerequisites: [
              `Confirm ${column} is a date/datetime type (a string column needs a different rewrite).`,
              ...INDEX_PREREQ,
            ],
            validation: [
              "Run the old and new statements and compare the results: same rows, same count.",
              ...INDEX_VALIDATION(sid, scan.id),
            ],
            rollback: [
              "Deploy the original statement text again.",
              ...INDEX_ROLLBACK(table, [column]),
            ],
          }),
        );
      }
    }
  }

  // 4. The optimizer's own missing-index request, when nothing above already covers that table.
  const mi = [...(d.missingIndexes ?? [])].sort(
    (a, b) => (b.impact ?? 0) - (a.impact ?? 0),
  )[0];
  if (
    mi &&
    (mi.impact ?? 0) >= 20 &&
    [...mi.equality, ...mi.inequality].length &&
    !out.some(
      (o) =>
        o.option_type === "index" && o.sql_to_run.includes(sqlTable(mi.table)),
    )
  ) {
    const keys = [...mi.equality, ...mi.inequality];
    out.push(
      option({
        key: `rule_missing_index_${shortTable(mi.table)}`,
        title: `Create the index the optimizer asked for on ${shortTable(mi.table)}(${keys.join(", ")})`,
        diagnosis: `The optimizer recorded a missing index on ${shortTable(mi.table)} with an estimated ${Math.round(mi.impact)}% improvement for this statement.`,
        actions: [
          {
            title: "Create the requested index",
            detail:
              "Equality columns first, then range columns, with the requested INCLUDE columns.",
            effort: "low",
            requires_change_control: true,
          },
        ],
        option_type: "index",
        sql_to_run: createIndex(mi.table, keys, mi.included ?? []),
        expected:
          "The scan or residual filter on this table becomes an index seek.",
        evidence_ids: [...findingId("missing_index")],
        prerequisites: [
          "Missing-index requests ignore existing indexes and write cost: merge with an existing index where the keys overlap.",
          ...INDEX_PREREQ,
        ],
        validation: [
          "Compare logical reads, CPU and elapsed time before and after on the same parameter values.",
        ],
        rollback: INDEX_ROLLBACK(mi.table, keys),
      }),
    );
  }

  // 5. A filtered index the parameterized plan could not use, or a plan compiled for other parameter
  //    values: recompiling for the actual values is the direct test. Only for a complete, single statement.
  const recompileFor = findings.find(
    (f) =>
      f.rule === "unmatched_indexes" ||
      f.rule === "parameter_sniffing" ||
      f.rule === "table_variable",
  );
  if (
    recompileFor &&
    d.sql &&
    !d.sqlTruncated &&
    /^\s*(SELECT|UPDATE|DELETE|WITH)\b/i.test(d.sql) &&
    !/\bOPTION\s*\(/i.test(d.sql) &&
    !/;\s*\S/.test(d.sql.trim().replace(/;\s*$/, ""))
  ) {
    out.push(
      option({
        key: `rule_recompile_${recompileFor.rule}`,
        title:
          "Compile the statement for its actual values: OPTION (RECOMPILE)",
        diagnosis:
          recompileFor.rule === "unmatched_indexes"
            ? "The plan is parameterized, so the optimizer cannot prove the filtered index matches and does not use it."
            : recompileFor.rule === "table_variable"
              ? "The table variable is estimated at one row, so the joins around it are planned for one row. Recompiling lets the optimizer see its real row count."
              : "The plan was compiled for different parameter values than the ones it ran with, and its row estimates do not fit this execution.",
        actions: [
          {
            title: "Add OPTION (RECOMPILE)",
            detail:
              "Each execution is compiled for its own values. Costs compile CPU on every run: prefer it for statements that run rarely or vary widely.",
            effort: "low",
            requires_change_control: true,
          },
        ],
        option_type: "rewrite",
        sql_to_run: `${d.sql.trim().replace(/;\s*$/, "")}\nOPTION (RECOMPILE);`,
        expected:
          recompileFor.rule === "unmatched_indexes"
            ? "The filtered index is used for literal-equivalent values."
            : recompileFor.rule === "table_variable"
              ? "The table variable's real row count drives the join choice (for example a hash join instead of a nested loop)."
              : "Estimates match the runtime values; the join and access choices fit this execution.",
        evidence_ids: findingId(recompileFor.rule),
        prerequisites: [
          "Check how often the statement runs: RECOMPILE adds compile CPU to every execution.",
        ],
        validation: [
          "Compare the actual plan and elapsed time for several representative parameter values.",
        ],
        rollback: ["Deploy the statement without the OPTION clause."],
      }),
    );
  }

  const complete =
    d.sql &&
    !d.sqlTruncated &&
    !/\bOPTION\s*\(/i.test(d.sql) &&
    !/;\s*\S/.test(d.sql.trim().replace(/;\s*$/, ""));
  const tableOf = (object) => object?.split(".").slice(0, -1).join(".");

  // 6. Other functions wrapped around a column: CAST/CONVERT(date, col) = value and LEFT(col, n) = 'text'.
  //    Same shape as YEAR(): the range or LIKE prefix lets an index on the column be sought.
  if (
    findings.some((f) => f.rule === "non_sargable") &&
    complete &&
    !out.some((o) => o.key.startsWith("rule_sargable_"))
  ) {
    const COL = "((?:\\[?\\w+\\]?\\s*\\.\\s*)*\\[?(\\w+)\\]?)";
    const patterns = [
      {
        re: new RegExp(
          `\\b(?:CAST\\s*\\(\\s*${COL}\\s+AS\\s+date\\s*\\)|CONVERT\\s*\\(\\s*date\\s*,\\s*${COL}\\s*\\))\\s*=\\s*(@\\w+|'[^']*')`,
          "gi",
        ),
        pick: (m) => ({
          expr: m[1] ?? m[3],
          column: m[2] ?? m[4],
          value: m[5],
        }),
        replace: ({ expr, value }) =>
          `${expr} >= ${value} AND ${expr} < DATEADD(day, 1, ${value})`,
        what: (c) => `CAST(${c} AS date)`,
        form: "a one-day range",
      },
      {
        re: new RegExp(
          `\\bLEFT\\s*\\(\\s*${COL}\\s*,\\s*(\\d+)\\s*\\)\\s*=\\s*'([^'%_\\[]*)'`,
          "gi",
        ),
        pick: (m) => ({
          expr: m[1],
          column: m[2],
          n: Number(m[3]),
          text: m[4],
        }),
        valid: (p) => p.text.length === p.n,
        replace: ({ expr, text }) => `${expr} LIKE '${text}%'`,
        what: (c) => `LEFT(${c}, n)`,
        form: "a LIKE prefix",
      },
    ];
    for (const pat of patterns) {
      const found = [...d.sql.matchAll(pat.re)];
      if (found.length !== 1) continue;
      const m = pat.pick(found[0]);
      if (pat.valid && !pat.valid(m)) continue;
      const scan = ops.find((o) =>
        new RegExp(`\\[${m.column}\\]`, "i").test(o.predicate ?? ""),
      );
      const table = tableOf(scan?.object);
      if (!scan || !table) continue;
      const rewritten = d.sql.replace(found[0][0], pat.replace(m));
      const scannedIndex =
        scan.op === "Index Scan" ? scan.object.split(".").at(-1) : null;
      const indexExists =
        !!scannedIndex && lc(scannedIndex).includes(lc(m.column));
      const include = unique(
        (scan.outputColumns ?? [])
          .filter((c) => !c.table || c.table === table)
          .map((c) => c.column),
      );
      if (!indexExists && include.length > 8) continue;
      out.push(
        option({
          key: `rule_sargable_${m.column}`,
          title: indexExists
            ? `Rewrite ${pat.what(m.column)} as ${pat.form} so ${scannedIndex} can be sought`
            : `Rewrite ${pat.what(m.column)} as ${pat.form} and index ${m.column} (one change)`,
          diagnosis: `A function around ${m.column} hides it from any index, so node ${scan.id} reads all of ${indexExists ? scannedIndex : shortTable(table)} and applies the function to every row.${impactOf(d, scan)}`,
          actions: [
            ...(indexExists
              ? []
              : [
                  {
                    title: `Create an index on ${m.column}`,
                    detail: `So the rewritten predicate has something to seek on.`,
                    effort: "low",
                    requires_change_control: true,
                  },
                ]),
            {
              title: `Rewrite the predicate as ${pat.form}`,
              detail: `${pat.replace(m)} returns the same rows.`,
              effort: "low",
              requires_change_control: true,
            },
          ],
          option_type: "rewrite",
          sql_to_run: indexExists
            ? rewritten.trim().replace(/;?$/, ";")
            : `${createIndex(table, [m.column], include)}\n${rewritten.trim().replace(/;?$/, ";")}`,
          expected: `Node ${scan.id} becomes an index seek on ${m.column} instead of a full scan.`,
          evidence_ids: [
            ...findingId("non_sargable"),
            `${sid}:operator:${scan.id}`,
          ],
          prerequisites: [
            `Confirm ${m.column}'s type: the rewrite assumes a date/datetime column for a date cast, a string column for LEFT.`,
            ...(indexExists ? [] : INDEX_PREREQ),
          ],
          validation: [
            "Run the old and new statements and compare the results: same rows, same count.",
            ...INDEX_VALIDATION(sid, scan.id),
          ],
          rollback: [
            "Deploy the original statement text again.",
            ...(indexExists ? [] : INDEX_ROLLBACK(table, [m.column])),
          ],
        }),
      );
      break;
    }
  }

  // 7. Columns the optimizer had no statistics for: create them (cheap, and cannot change results).
  const noStats = unique(
    (d.warnings ?? [])
      .map((w) => /^ColumnsWithNoStatistics column=(.+)$/.exec(w)?.[1])
      .filter(Boolean),
  ).slice(0, 5);
  if (noStats.length) {
    const cols = noStats.map((full) => {
      const parts = full.split(".");
      return { table: parts.slice(0, -1).join("."), column: parts.at(-1) };
    });
    out.push(
      option({
        key: "rule_create_statistics",
        title: `Create the missing statistics on ${cols.map((c) => `${shortTable(c.table)}.${c.column}`).join(", ")}`,
        diagnosis: `The optimizer had no statistics for ${cols.map((c) => `${shortTable(c.table)}.${c.column}`).join(", ")} and guessed its selectivity (plan warning ColumnsWithNoStatistics). Auto-create statistics may be off for this database.`,
        actions: [
          {
            title: "Create the statistics",
            detail:
              "One statistics object per column, sampled fully so the histogram is exact.",
            effort: "low",
            requires_change_control: false,
          },
        ],
        option_type: "statistics",
        sql_to_run: cols
          .map(
            (c) =>
              `CREATE STATISTICS ${bracket(`ST_${shortTable(c.table)}_${c.column}`.replace(/[^\w]/g, "_"))} ON ${sqlTable(c.table)} (${bracket(c.column)}) WITH FULLSCAN;`,
          )
          .join("\n"),
        expected:
          "The estimates for these columns come from a histogram instead of a guess; the join and memory grant fit the real rows.",
        evidence_ids: findingId("missing_statistics"),
        prerequisites: [
          "Check SELECT is_auto_create_stats_on FROM sys.databases for this database: if it is off, consider turning it on.",
        ],
        validation: [
          "Capture the actual plan again: the ColumnsWithNoStatistics warning is gone and estimates move toward actual rows.",
        ],
        rollback: cols.map(
          (c) =>
            `DROP STATISTICS ${sqlTable(c.table)}.${bracket(`ST_${shortTable(c.table)}_${c.column}`.replace(/[^\w]/g, "_"))};`,
        ),
      }),
    );
  }

  // 8. A real estimate error on an operator reading a table whose statistics are stale or thinly sampled:
  //    refresh exactly those statistics. Never when the plan's estimates are already right.
  const staleByTable = new Map(
    (d.statistics ?? [])
      .filter(
        (st) =>
          (st.modifications ?? 0) >= 50000 ||
          (st.samplingPercent != null && st.samplingPercent < 5),
      )
      .map((st) => [lc(st.table), st]),
  );
  const missedOn = (d.rowGuessErrors ?? [])
    .map((e) => ops.find((o) => o.id === e.id))
    .find((o) => o?.object && staleByTable.has(lc(tableOf(o.object))));
  if (d.actual && missedOn) {
    const st = staleByTable.get(lc(tableOf(missedOn.object)));
    const err = d.rowGuessErrors.find((e) => e.id === missedOn.id);
    out.push(
      option({
        key: "rule_refresh_statistics",
        title: `Refresh statistics ${st.name} on ${shortTable(st.table)} WITH FULLSCAN`,
        diagnosis: `Node ${missedOn.id} estimated ${err.est} rows per execution but got ${err.actual}; it reads ${shortTable(st.table)}, whose statistics ${st.name} ${
          (st.modifications ?? 0) >= 50000
            ? `have ${st.modifications.toLocaleString("en-US")} modifications since ${st.lastUpdate ?? "the last update"}`
            : `were sampled at ${st.samplingPercent}%`
        }.${impactOf(d, missedOn)}`,
        actions: [
          {
            title: "Update the statistics with a full scan",
            detail:
              "Rebuilds the histogram from every row; cheap compared with changing the query or the schema.",
            effort: "low",
            requires_change_control: false,
          },
        ],
        option_type: "statistics",
        sql_to_run: `UPDATE STATISTICS ${sqlTable(st.table)} ${bracket(st.name)} WITH FULLSCAN;`,
        expected: `The estimate at node ${missedOn.id} moves close to the actual rows, and the plan shape follows.`,
        evidence_ids: [
          ...findingId("stale_statistics"),
          `${sid}:operator:${missedOn.id}`,
        ],
        prerequisites: [
          "A full scan reads the whole table: run it off-peak on large tables.",
        ],
        validation: [
          "Capture the actual plan again and compare estimated and actual rows at the same node.",
        ],
        rollback: [
          "Statistics cannot be reverted; the next automatic update replaces them.",
        ],
      }),
    );
  }

  // 9. A row goal that planned for a few rows and read many: plan for all rows instead.
  if (
    findings.some((f) => f.rule === "row_goal") &&
    complete &&
    /^\s*(SELECT|WITH)\b/i.test(d.sql)
  ) {
    const goal = ops.find((o) => o.rowGoal);
    out.push(
      option({
        key: "rule_disable_row_goal",
        title:
          "Plan for every row: OPTION (USE HINT ('DISABLE_OPTIMIZER_ROWGOAL'))",
        diagnosis: `TOP, EXISTS or FAST made the optimizer plan for a few rows${goal ? ` at node ${goal.id}` : ""}, assuming matches are spread evenly; they were not, so the nested loop ran far more times than planned.${goal ? impactOf(d, goal) : ""}`,
        actions: [
          {
            title: "Add the hint",
            detail:
              "The optimizer costs the full input, usually choosing a hash join or a different access path.",
            effort: "low",
            requires_change_control: true,
          },
        ],
        option_type: "rewrite",
        sql_to_run: `${d.sql.trim().replace(/;\s*$/, "")}\nOPTION (USE HINT ('DISABLE_OPTIMIZER_ROWGOAL'));`,
        expected:
          "The plan is costed for all qualifying rows; the repeated nested-loop work disappears.",
        evidence_ids: findingId("row_goal"),
        prerequisites: ["SQL Server 2016 SP1 or later (USE HINT)."],
        validation: [
          "Compare actual rows, reads and elapsed time with and without the hint.",
        ],
        rollback: ["Deploy the statement without the OPTION clause."],
      }),
    );
  }

  // 10. An implicit conversion on the column side that prevents a seek: send the parameter as the
  //     column's type. The plan shows the column converted to the parameter's (wider) type.
  const convert = (d.warnings ?? [])
    .map((w) =>
      /ConvertIssue=Seek Plan Expression=CONVERT_IMPLICIT\((n?(?:var)?char)\((\d+|max)\),\[[^\]]+\]\.\[([^\]]+)\],\d+\)\s*=\s*\[?(@\w+)\]?/i.exec(
        w,
      ),
    )
    .find(Boolean);
  if (convert) {
    const [, toType, length, column, param] = convert;
    const columnType = `${toType.toLowerCase().replace(/^n/, "")}(${length})`;
    const declared = (d.parameters ?? []).find(
      (p) => lc(p.name) === lc(param),
    )?.type;
    out.push(
      option({
        key: "rule_match_parameter_type",
        title: `Send ${param} as ${columnType} to match ${column}`,
        diagnosis: `${column} is converted to ${toType}(${length}) on every row because ${param} arrives as ${declared ?? toType}; the conversion on the column side stops an index seek.`,
        actions: [
          {
            title: `Declare ${param} as ${columnType}`,
            detail: `In the application or ORM, map the parameter to ${columnType} (for example SqlDbType.VarChar with Size ${length}), or CAST(${param} AS ${columnType}) in the query if the values are always non-Unicode.`,
            effort: "medium",
            requires_change_control: true,
          },
        ],
        option_type: "app",
        sql_to_run: null,
        expected: `The CONVERT_IMPLICIT on ${column} disappears and the predicate becomes an index seek.`,
        evidence_ids: findingId("implicit_conversion"),
        prerequisites: [
          `Confirm ${column}'s declared type (the plan implies ${columnType}) and that the values never need Unicode.`,
        ],
        validation: [
          "Capture the actual plan again: the PlanAffectingConvert warning is gone and the scan is a seek.",
        ],
        rollback: ["Restore the previous parameter mapping."],
      }),
    );
  }

  // 11. Blocking: the plan is not the problem. Find the head blocker with a read-only query.
  if (findings.some((f) => f.rule === "wait_blocking")) {
    out.push(
      option({
        key: "rule_find_blocker",
        title: "Find the session that is blocking this query",
        diagnosis:
          "Most of the elapsed time was spent waiting for locks held by another session, not executing this plan. Tuning the plan will not remove the wait.",
        actions: [
          {
            title: "Identify the head blocker",
            detail:
              "Run the read-only query while the problem happens; it lists blocked sessions, their blocker and what the blocker last ran.",
            effort: "low",
            requires_change_control: false,
          },
        ],
        option_type: "ops",
        sql_to_run:
          "SELECT r.session_id, r.blocking_session_id, r.wait_type, r.wait_time, r.wait_resource, t.text AS blocked_sql, b.text AS blocker_last_sql FROM sys.dm_exec_requests AS r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS t LEFT JOIN sys.dm_exec_connections AS c ON c.session_id = r.blocking_session_id OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) AS b WHERE r.blocking_session_id <> 0;",
        expected:
          "Names the blocking session and statement, so the fix goes to the transaction holding the locks.",
        evidence_ids: findingId("wait_blocking"),
        prerequisites: ["VIEW SERVER STATE permission."],
        validation: [
          "After fixing the blocker, the query's LCK_ waits disappear from its plan.",
        ],
        rollback: ["Nothing to roll back: the query only reads system views."],
      }),
    );
  }

  // Most useful first: when the query was blocked, the plan is not the problem.
  const PRIORITY = [
    "rule_find_blocker",
    "rule_index_for_spool",
    "rule_cover_lookup",
    "rule_sargable",
    "rule_refresh_statistics",
    "rule_create_statistics",
    "rule_missing_index",
    "rule_recompile",
    "rule_disable_row_goal",
    "rule_match_parameter_type",
  ];
  const rank = (o) => {
    const i = PRIORITY.findIndex((p) => o.key.startsWith(p));
    return i === -1 ? PRIORITY.length : i;
  };
  return applyExistingIndexes(
    out.sort((a, b) => rank(a) - rank(b)),
    d.schemaContext,
  ).slice(0, 3);
}

const CREATE_RE =
  /CREATE NONCLUSTERED INDEX \[([^\]]+)\] ON \[([^\]]+)\]\.\[([^\]]+)\] \(([^)]*)\)(?: INCLUDE \(([^)]*)\))?;/;
const cols = (list) =>
  (list ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^\[([^\]]+)\](?:\s+(DESC|ASC))?$/i.exec(x);
      return { column: m ? m[1] : x, desc: /DESC/i.test(m?.[2] ?? "") };
    });
const indexSql = (unique, name, schema, table, keys, include, extra = "") =>
  `CREATE ${unique ? "UNIQUE " : ""}NONCLUSTERED INDEX ${bracket(name)} ON ${bracket(schema)}.${bracket(table)} (${keys
    .map((k) => `${bracket(k.column)}${k.desc ? " DESC" : ""}`)
    .join(
      ", ",
    )})${include.length ? ` INCLUDE (${include.map(bracket).join(", ")})` : ""}${extra};`;

/**
 * With the DBA's real index definitions (lib/schema-context.mjs), an index a rule proposes is checked
 * against what the table already has: already covered (the option is dropped, or a rewrite keeps only its
 * rewrite), the same keys with fewer columns (extend that index with DROP_EXISTING instead of adding a
 * near-duplicate), or genuinely new (created under a name no existing index uses).
 */
export function applyExistingIndexes(options, context) {
  if (!context) return options;
  const result = [];
  for (const o of options) {
    const m = CREATE_RE.exec(o.sql_to_run ?? "");
    if (!m) {
      result.push(o);
      continue;
    }
    const [statement, name, schema, table, keyList, includeList] = m;
    const keys = cols(keyList);
    const include = cols(includeList).map((c) => c.column);
    const existing = indexesOf(context, `${schema}.${table}`).filter(
      (i) => !i.filtered && i.keys.length,
    );
    const same = (a, b) =>
      lc(a.column) === lc(b.column) && !!a.desc === !!b.desc;
    const leads = (i) => keys.every((k, n) => i.keys[n] && same(k, i.keys[n]));
    const has = (i, c) =>
      /CLUSTERED/i.test(i.type) && !/NONCLUSTERED/i.test(i.type)
        ? true // the clustered index holds every column
        : [...i.keys.map((k) => k.column), ...i.include]
            .map(lc)
            .includes(lc(c));
    const covering = existing.find(
      (i) => leads(i) && include.every((c) => has(i, c)),
    );
    const rest = (o.sql_to_run ?? "").replace(statement, "").trim();
    if (covering) {
      // The index this option would add already exists: an index-only option has nothing left to do.
      if (!rest) continue;
      result.push({
        ...o,
        title: o.title.replace(
          / and index \S+ \(one change\)$/,
          ` so ${covering.name} can be sought`,
        ),
        sql_to_run: rest,
        actions: o.actions.filter((a) => !/^Create an index/.test(a.title)),
        prerequisites: [
          `${covering.name} already covers this (keys ${covering.keys.map((k) => k.column).join(", ")}), so no new index is needed.`,
          ...o.prerequisites.filter(
            (p) => !/duplicate an existing|maintenance window/.test(p),
          ),
        ],
        rollback: o.rollback.filter((r) => !/^DROP INDEX/.test(r)),
      });
      continue;
    }
    const extend = existing.find(
      (i) =>
        /NONCLUSTERED/i.test(i.type) &&
        i.keys.length === keys.length &&
        leads(i),
    );
    if (extend) {
      const merged = [...extend.include];
      for (const c of include)
        if (
          !merged.map(lc).includes(lc(c)) &&
          !extend.keys.map((k) => lc(k.column)).includes(lc(c))
        )
          merged.push(c);
      const sqlExtend = indexSql(
        extend.unique,
        extend.name,
        schema,
        table,
        extend.keys,
        merged,
        " WITH (DROP_EXISTING = ON)",
      );
      result.push({
        ...o,
        title: `Extend ${extend.name} with INCLUDE (${merged.join(", ")}) instead of adding a second index on (${keys.map((k) => k.column).join(", ")})`,
        sql_to_run: (o.sql_to_run ?? "").replace(statement, sqlExtend),
        prerequisites: [
          `${extend.name} already has these keys; extending it avoids a near-duplicate index and its write cost.`,
          "DROP_EXISTING rebuilds the index: run it in a maintenance window or WITH (ONLINE = ON) where supported.",
        ],
        rollback: [
          indexSql(
            extend.unique,
            extend.name,
            schema,
            table,
            extend.keys,
            extend.include,
            " WITH (DROP_EXISTING = ON)",
          ),
          ...o.rollback.filter((r) => !/^DROP INDEX/.test(r)),
        ],
      });
      continue;
    }
    // New index: never reuse a name the table already has.
    const taken = new Set(existing.map((i) => lc(i.name)));
    let fresh = name;
    for (let n = 2; taken.has(lc(fresh)); n++) fresh = `${name}_${n}`;
    result.push(
      fresh === name
        ? o
        : {
            ...o,
            sql_to_run: o.sql_to_run.replace(`[${name}]`, `[${fresh}]`),
            rollback: o.rollback.map((r) =>
              r.replace(`[${name}]`, `[${fresh}]`),
            ),
          },
    );
  }
  return result;
}

/**
 * The analyst's options plus the rule-built ones. A model option that creates the same index as a rule
 * option (same table and keys) is dropped in favour of the rule's: same fix, stated the same way every run.
 */
export function withRuleOptions(ruleOpts, modelOpts, limit = 6) {
  const indexKey = (sql) => {
    const m =
      /CREATE\s+(?:UNIQUE\s+)?(?:NONCLUSTERED\s+)?INDEX\s+\S+\s+ON\s+([^\s(]+)\s*\(([^)]*)\)/i.exec(
        sql ?? "",
      );
    if (!m) return null;
    const table = m[1].replace(/[[\]]/g, "").split(".").at(-1).toLowerCase();
    const keys = m[2].split(",").map((k) =>
      k
        .replace(/[[\]]|\s+(ASC|DESC)\s*$/gi, "")
        .trim()
        .toLowerCase(),
    );
    return `${table}(${keys.join(",")})`;
  };
  const taken = new Set(
    ruleOpts.map((o) => indexKey(o.sql_to_run)).filter(Boolean),
  );
  const keys = new Set(ruleOpts.map((o) => o.key));
  const model = modelOpts.filter((o) => {
    const k = indexKey(o.sql_to_run);
    return !(k && taken.has(k)) && !keys.has(o.key);
  });
  return [...ruleOpts, ...model].slice(0, limit);
}

/** Below this, measured elapsed and CPU time, a statement is not worth tuning for speed. */
export const FAST_QUERY_MS = 100;

/**
 * Why no change is needed, when an actual plan shows the statement already finished in a few milliseconds;
 * null otherwise. Findings still appear in the report (a cross join that is fast today may not stay fast).
 */
export function fastQueryReason(d) {
  const t = d.queryTime;
  if (!d.actual || d.incompleteExecution || !t) return null;
  if (t.elapsedMs == null || t.cpuMs == null) return null;
  if (t.elapsedMs >= FAST_QUERY_MS || t.cpuMs >= FAST_QUERY_MS) return null;
  const notes = detectFindings(d).filter((f) => f.severity !== "info");
  return (
    `The statement ran in ${t.elapsedMs} ms (${t.cpuMs} ms CPU), so there is nothing to gain by tuning it for speed.` +
    (notes.length
      ? ` Review the findings below anyway: ${notes.map((f) => f.title).join("; ")}.`
      : "")
  );
}
