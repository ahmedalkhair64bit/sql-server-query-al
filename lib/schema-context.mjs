// Existing index definitions, supplied by the DBA. A plan names the indexes it used but not their keys or
// INCLUDE columns, so without this an index suggestion can duplicate one the table already has. The DBA
// runs contextQuery() (read-only, system views) in the plan's database and pastes its one JSON result.
//
// Pure module: no Node or React imports.

const quote = (s) => `N'${String(s).replace(/'/g, "''")}'`;

/**
 * T-SQL that returns, as one JSON value, the indexes and row counts of the given tables.
 * @param tables plan table names, "Db.schema.table" or "schema.table"
 */
export function contextQuery(tables) {
  const names = [
    ...new Set(
      (tables ?? [])
        .map((t) => String(t).split(".").slice(-2))
        .filter(
          (p) =>
            p.length === 2 &&
            p.every(Boolean) &&
            !p[1].startsWith("#") &&
            !p[1].startsWith("@"),
        )
        .map((p) => `${p[0]}.${p[1]}`),
    ),
  ].slice(0, 40);
  if (!names.length) return null;
  const col = (filter) =>
    `JSON_QUERY((SELECT c.name AS [column]${filter === "key" ? ", ic.is_descending_key AS [desc]" : ""} FROM sys.index_columns AS ic JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ${filter === "key" ? "ic.key_ordinal > 0 ORDER BY ic.key_ordinal" : "ic.is_included_column = 1 ORDER BY ic.index_column_id"} FOR JSON PATH))`;
  return `-- Existing indexes for the tables in this plan. Read-only: system views only.
-- Run it in the plan's database, then paste the single JSON value it returns.
SET NOCOUNT ON;
SELECT (
  SELECT s.name AS [schema], t.name AS [table],
    (SELECT SUM(p.rows) FROM sys.partitions AS p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS [rows],
    JSON_QUERY((
      SELECT i.name AS [name], i.type_desc AS [type], i.is_unique AS [unique], i.has_filter AS [filtered],
        i.filter_definition AS [filter], ${col("key")} AS [keys], ${col("include")} AS [include]
      FROM sys.indexes AS i
      WHERE i.object_id = t.object_id AND i.type > 0
      FOR JSON PATH)) AS [indexes]
  FROM sys.tables AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id
  WHERE CONCAT(s.name, N'.', t.name) IN (${names.map(quote).join(", ")})
  FOR JSON PATH
) AS existing_indexes;`;
}

const str = (v, max = 256) => (typeof v === "string" ? v.slice(0, max) : null);
const bool = (v) => v === true || v === 1 || v === "1" || v === "true";

/**
 * Parses what contextQuery() returned. Tolerates surrounding text and a JSON value SSMS split over several
 * lines. Returns null when nothing usable is found; never throws.
 */
export function parseContext(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const joined = text.slice(0, 500_000).replace(/\r?\n/g, "");
  const start = joined.indexOf("[");
  const end = joined.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let raw;
  try {
    raw = JSON.parse(joined.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const tables = raw
    .filter((t) => t && typeof t === "object" && str(t.table))
    .slice(0, 40)
    .map((t) => ({
      schema: str(t.schema) ?? "dbo",
      table: str(t.table),
      rows: Number.isFinite(Number(t.rows)) ? Number(t.rows) : null,
      indexes: (Array.isArray(t.indexes) ? t.indexes : [])
        .filter((i) => i && str(i.name))
        .slice(0, 60)
        .map((i) => ({
          name: str(i.name),
          type: str(i.type, 40) ?? "",
          unique: bool(i.unique),
          filtered: bool(i.filtered),
          filter: str(i.filter, 500),
          keys: (Array.isArray(i.keys) ? i.keys : [])
            .filter((k) => k && str(k.column))
            .slice(0, 32)
            .map((k) => ({ column: str(k.column), desc: bool(k.desc) })),
          include: (Array.isArray(i.include) ? i.include : [])
            .map((k) => str(k?.column))
            .filter(Boolean)
            .slice(0, 64),
        })),
    }));
  return tables.length ? { tables } : null;
}

/** The existing indexes of a plan table ("Db.schema.table"), or [] when the DBA supplied none for it. */
export function indexesOf(context, planTable) {
  const [schema, table] = String(planTable)
    .split(".")
    .slice(-2)
    .map((s) => s.toLowerCase());
  const t = context?.tables?.find(
    (x) => x.table.toLowerCase() === table && x.schema.toLowerCase() === schema,
  );
  return t?.indexes ?? [];
}

/** Compact definitions for the models: "IX_Orders_CustomerId NONCLUSTERED (CustomerId) INCLUDE (Total)". */
export function describeIndexes(context) {
  return (context?.tables ?? []).flatMap((t) =>
    t.indexes.map(
      (i) =>
        `${t.schema}.${t.table}.${i.name} ${i.type}${i.unique ? " UNIQUE" : ""} (${i.keys
          .map((k) => `${k.column}${k.desc ? " DESC" : ""}`)
          .join(
            ", ",
          )})${i.include.length ? ` INCLUDE (${i.include.join(", ")})` : ""}${i.filtered ? ` WHERE ${i.filter}` : ""}${t.rows != null ? ` [table rows ${t.rows}]` : ""}`,
    ),
  );
}
