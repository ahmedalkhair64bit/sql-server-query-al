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
        diagnosis: `Node ${o.id} is an eager index spool: for every execution the engine reads ${shortTable(table)} and builds a temporary index on ${o.seekColumns.join(", ")}, because no permanent index supports this seek${order.length ? ` in ${order.map((c) => c.column).join(", ")} order` : ""}.`,
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
            diagnosis: `Node ${lookup.id} looks up ${include.join(", ")} in the clustered index for every row that ${existing} returns, because that index does not contain them.`,
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
            diagnosis: `YEAR() around ${column} stops ${scannedIndex} being sought, so node ${scan.id} scans all of it and applies the function to every row.`,
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
            diagnosis: `YEAR() around ${column} hides the column from any index, so node ${scan.id} reads the whole of ${shortTable(table)} and applies the function to every row.`,
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
    (f) => f.rule === "unmatched_indexes" || f.rule === "parameter_sniffing",
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

  return out.slice(0, 3);
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
