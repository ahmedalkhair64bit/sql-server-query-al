// Deterministic checks on an option's T-SQL, run before Jev sees it. Errors reject the option (the model
// named something the plan does not contain, or wrote SQL that cannot run); warnings are shown to the DBA.
// This is a focused reader for the DDL shapes the analyst is asked to produce, not a full T-SQL parser.
// Pure module: no Node or React imports.

const unquote = (s) =>
  s
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^"|"$/g, "");
/** Split a multi-part name on dots outside brackets: [a.b].[c] -> ["a.b", "c"]. */
export function nameParts(name) {
  const parts = [];
  let cur = "",
    bracket = false;
  for (const ch of name.trim()) {
    if (ch === "[") bracket = true;
    if (ch === "]") bracket = false;
    if (ch === "." && !bracket) {
      parts.push(unquote(cur));
      cur = "";
    } else cur += ch;
  }
  parts.push(unquote(cur));
  return parts.filter(Boolean);
}
const lc = (s) => s.toLowerCase();
/** Column list "([A] ASC, B DESC)" -> ["A", "B"]. */
const columnList = (s) =>
  (s ?? "")
    .split(",")
    .map((c) => unquote(c.trim().replace(/\s+(ASC|DESC)\s*$/i, "")))
    .filter(Boolean);

/** Remove comments and string literals so structure checks never trip over their contents. */
function strip(sql) {
  let out = "",
    i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { text: out, error: "Unterminated /* comment." };
      i = end + 2;
      out += " ";
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'"))
        j += sql[j] === "'" ? 2 : 1;
      if (j >= sql.length)
        return { text: out, error: "Unterminated string literal." };
      out += "''";
      i = j + 1;
    } else if (sql[i] === "[") {
      const end = sql.indexOf("]", i);
      if (end === -1) return { text: out, error: "Unterminated [identifier]." };
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else out += sql[i++];
  }
  return { text: out, error: null };
}

/**
 * True when the SQL only reads SQL Server's own system views and functions (sys.dm_exec_requests,
 * sys.dm_exec_sql_text, sys.indexes ...): a diagnostic that cannot change data, settings or the query's result.
 * Conservative: any write, EXEC, DBCC, SET, variable or non-sys object makes it false.
 */
export function isSystemReadOnly(sql) {
  const { text, error } = strip(sql ?? "");
  if (error || !text.trim()) return false;
  const t = text.replace(/\[([^\]]*)\]/g, "$1");
  if (
    /\b(INSERT|UPDATE|DELETE|MERGE|INTO|EXEC|EXECUTE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|DENY|KILL|DBCC|SET|DECLARE|BACKUP|RESTORE|SHUTDOWN|RECONFIGURE|OPENROWSET|OPENQUERY|OPENDATASOURCE|OPENXML|BULK)\b|@/i.test(
      t,
    )
  )
    return false;
  const statements = t
    .split(/;|\bGO\b/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!statements.every((x) => /^(SELECT|WITH)\b/i.test(x))) return false;
  const cteNames = [
    ...t.matchAll(/(?:\bWITH|,)\s*(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi),
  ].map((m) => m[1].toLowerCase());
  const sources = [...t.matchAll(/\b(?:FROM|JOIN|APPLY)\s+([\w.#]+)/gi)].map(
    (m) => m[1].toLowerCase(),
  );
  return sources.every(
    (o) =>
      cteNames.includes(o) ||
      /^(\w+\.)?sys\.\w+$/.test(o) ||
      /^(master|msdb)\.(dbo\.)?sys\w*$/.test(o),
  );
}

function balanced(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

const NAME = String.raw`((?:\[[^\]]+\]|"[^"]+"|[\w#@$]+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[\w#@$]+)){0,3})`;
const CREATE_INDEX = new RegExp(
  String.raw`CREATE\s+(UNIQUE\s+)?(CLUSTERED\s+|NONCLUSTERED\s+)?(COLUMNSTORE\s+)?INDEX\s+${NAME}\s+ON\s+${NAME}\s*(?:\(([^)]*)\))?(?:\s*INCLUDE\s*\(([^)]*)\))?(?:\s*WHERE\s+([^;]*?)(?=\s+WITH\b|;|$))?`,
  "gi",
);
const CREATE_STATS = new RegExp(
  String.raw`CREATE\s+STATISTICS\s+${NAME}\s+ON\s+${NAME}\s*\(([^)]*)\)`,
  "gi",
);
const UPDATE_STATS = new RegExp(
  String.raw`UPDATE\s+STATISTICS\s+${NAME}`,
  "gi",
);

/** Parse the DDL an index/statistics option is expected to contain. */
export function parseDdl(sql) {
  const stripped = strip(sql ?? "");
  // SSMS batch separators: models write "CREATE INDEX ...\nGO\nSELECT ...". Treat GO as a statement end.
  const text = stripped.text.replace(/^[ \t]*GO[ \t]*(\d+)?[ \t]*$/gim, ";");
  const error = stripped.error;
  const indexes = [...text.matchAll(CREATE_INDEX)].map((m) => ({
    unique: !!m[1],
    clustered: /^CLUSTERED/i.test(m[2] ?? ""),
    columnstore: !!m[3],
    name: nameParts(m[4]).at(-1),
    table: nameParts(m[5]),
    keys: columnList(m[6]),
    include: columnList(m[7]),
    filtered: !!m[8],
  }));
  const statistics = [
    ...[...text.matchAll(CREATE_STATS)].map((m) => ({
      create: true,
      name: nameParts(m[1]).at(-1),
      table: nameParts(m[2]),
      columns: columnList(m[3]),
    })),
    ...[...text.matchAll(UPDATE_STATS)].map((m) => ({
      create: false,
      table: nameParts(m[1]),
      columns: [],
    })),
  ];
  // Nothing but index and statistics DDL: such SQL cannot change what the query returns.
  const onlyDdl = text
    .split(/;|\bGO\b/i)
    .map((x) => x.trim())
    .filter(Boolean)
    .every((x) =>
      /^(CREATE\s+(UNIQUE\s+)?((NON)?CLUSTERED\s+)?(COLUMNSTORE\s+)?INDEX|CREATE\s+STATISTICS|UPDATE\s+STATISTICS|DROP\s+INDEX)\b/i.test(
        x,
      ),
    );
  return { text, error, indexes, statistics, onlyDdl };
}

/** Map a DDL table name onto a plan table ("db.schema.table"), matching on the parts both sides name. */
function planTable(parts, tables) {
  const want = parts.map(lc);
  return (
    tables.find((t) => {
      const have = t.split(".").map(lc);
      const n = Math.min(want.length, have.length);
      return n > 0 && want.slice(-n).join(".") === have.slice(-n).join(".");
    }) ?? null
  );
}

function knownColumns(d, table) {
  const cols = new Set((d.columns?.[table] ?? []).map(lc));
  for (const m of d.missingIndexes ?? [])
    if (m.table === table)
      for (const c of [...m.equality, ...m.inequality, ...m.included])
        cols.add(lc(c));
  for (const o of d.topOperators ?? [])
    if (o.object?.startsWith(table + ".") || o.object === table)
      for (const c of o.seekColumns ?? []) cols.add(lc(c));
  // Predicates name columns as [db].[schema].[table].[column]; any operator's predicate may mention this table.
  const re = /\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]/g;
  for (const o of d.topOperators ?? [])
    for (const m of (o.predicate ?? "").matchAll(re))
      if (`${m[1]}.${m[2]}.${m[3]}` === table) cols.add(lc(m[4]));
  return cols;
}

const VERB =
  /^\s*(?:;?\s*WITH\b[\s\S]*?\)\s*)?(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * @returns {{ errors: string[], warnings: string[], ddl: ReturnType<typeof parseDdl> | null }}
 */
export function checkCandidateSql(c, d) {
  const errors = [],
    warnings = [];
  if (!c.sql_to_run) return { errors, warnings, ddl: null };
  const ddl = parseDdl(c.sql_to_run);
  if (ddl.error) errors.push(`The SQL is not well-formed: ${ddl.error}`);
  else if (!balanced(ddl.text))
    errors.push("The SQL is not well-formed: parentheses do not balance.");
  const tables = d.tables ?? [];
  const checkTable = (parts, what) => {
    const t = planTable(parts, tables);
    if (!t && tables.length)
      errors.push(
        `${what} targets ${parts.join(".")}, which does not appear in the plan.`,
      );
    return t;
  };
  // Columns the same SQL creates first (ALTER TABLE ... ADD CreationYear AS YEAR(CreationDate) PERSISTED).
  const added = [
    ...ddl.text.matchAll(
      /ALTER\s+TABLE\s+((?:\[[^\]]+\]|[\w#]+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+))*)\s+ADD\s+(\[[^\]]+\]|\w+)/gi,
    ),
  ].map((m) => ({
    table: planTable(nameParts(m[1]), tables),
    column: lc(unquote(m[2])),
  }));
  const checkColumns = (table, cols, what) => {
    if (!table) return;
    const known = knownColumns(d, table);
    if (!known.size) return;
    for (const a of added) if (a.table === table) known.add(a.column);
    const unknown = cols.filter((c) => !known.has(lc(c)));
    if (unknown.length)
      errors.push(
        `${what} names column(s) the plan never references on ${table}: ${unknown.join(", ")}.`,
      );
  };

  if (c.option_type === "index" && !ddl.indexes.length)
    errors.push("An index option must contain a CREATE INDEX statement.");
  // Every CREATE INDEX is checked, including the one a rewrite needs to seek on its new predicate.
  {
    for (const ix of ddl.indexes) {
      const table = checkTable(ix.table, `CREATE INDEX ${ix.name}`);
      checkColumns(
        table,
        [...ix.keys, ...ix.include],
        `CREATE INDEX ${ix.name}`,
      );
      if (!ix.keys.length && !ix.columnstore)
        errors.push(`CREATE INDEX ${ix.name} has no key columns.`);
      if (
        table &&
        (d.indexes ?? []).some(
          (e) => e.table === table && lc(e.index) === lc(ix.name),
        )
      )
        errors.push(
          `An index named ${ix.name} already exists on ${table}; use a new name or DROP_EXISTING deliberately.`,
        );
      if (ix.unique)
        warnings.push(
          `${ix.name} is UNIQUE: inserts or updates that create duplicates will start failing.`,
        );
      if (ix.clustered)
        warnings.push(
          `${ix.name} is CLUSTERED: it rebuilds the table and every nonclustered index.`,
        );
      // An existing index already seeking on the same leading keys makes this one likely redundant.
      for (const o of d.topOperators ?? []) {
        const seek = (o.seekColumns ?? []).map(lc);
        if (
          table &&
          o.object?.startsWith(table + ".") &&
          seek.length &&
          ix.keys.length &&
          seek.slice(0, ix.keys.length).join(",") === ix.keys.map(lc).join(",")
        )
          warnings.push(
            `${o.object.slice(table.length + 1)} already seeks on (${o.seekColumns.join(", ")}); extend it with INCLUDE columns instead of adding a near-duplicate.`,
          );
      }
      // Equality columns should lead the key, as in the optimizer's own suggestion.
      const mi = (d.missingIndexes ?? []).find((m) => m.table === table);
      if (mi) {
        const eq = new Set(mi.equality.map(lc)),
          ineq = new Set(mi.inequality.map(lc));
        const keys = ix.keys.map(lc);
        const firstIneq = keys.findIndex((k) => ineq.has(k));
        if (
          firstIneq !== -1 &&
          keys.slice(firstIneq + 1).some((k) => eq.has(k))
        )
          warnings.push(
            `${ix.name} puts a range column before an equality column; equality columns should lead the key.`,
          );
      }
    }
  }
  if (c.option_type === "statistics") {
    if (!ddl.statistics.length)
      errors.push(
        "A statistics option must contain CREATE STATISTICS or UPDATE STATISTICS.",
      );
    for (const s of ddl.statistics) {
      const table = checkTable(
        s.table,
        s.create ? `CREATE STATISTICS ${s.name}` : "UPDATE STATISTICS",
      );
      checkColumns(
        table,
        s.columns,
        `CREATE STATISTICS ${s.name ?? ""}`.trim(),
      );
    }
  }
  if (c.option_type === "rewrite") {
    const original = VERB.exec(strip(d.sql ?? "").text)?.[1];
    // A rewrite may set things up first (a temp table replacing a table variable, DECLAREs), as long as
    // the rest is the same kind of statement as the original.
    // A nonclustered CREATE INDEX may also come first: a SARGable rewrite and the index it seeks on are one fix.
    const SETUP =
      /^\s*(?:;\s*)?(?:CREATE\s+TABLE\s+#|CREATE\s+(?:UNIQUE\s+)?(?:NONCLUSTERED\s+)?INDEX\b|DECLARE\b|SET\s+(?:NOCOUNT|@)|INSERT\s+(?:INTO\s+)?#|SELECT\b[^;]*?\bINTO\s+#|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?#)[^;]*;/i;
    let rest = ddl.text,
      setup = false;
    while (SETUP.test(rest)) {
      rest = rest.replace(SETUP, "");
      setup = true;
    }
    rest = rest.replace(/^[\s;]+/, ""); // an empty statement left by a GO separator
    const rewrite = VERB.exec(rest)?.[1];
    if (!rewrite)
      errors.push(
        "A rewrite must be a SELECT, INSERT, UPDATE, DELETE or MERGE statement (optionally after temp-table or variable setup).",
      );
    else if (original && lc(original) !== lc(rewrite))
      errors.push(
        `The rewrite is a ${rewrite.toUpperCase()} but the original statement is a ${original.toUpperCase()}.`,
      );
    else if (setup)
      warnings.push(
        "The rewrite runs setup statements before the query (an index, temp tables or variables): run them first, in order.",
      );
  }
  return { errors, warnings, ddl };
}
