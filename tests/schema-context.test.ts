import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlanText, recommendStatement } from "../lib/plan-parser.mjs";
import { decodeBytes } from "../lib/plan-decoder.mjs";
import { ruleOptions } from "../lib/rule-options.mjs";
import {
  contextQuery,
  parseContext,
  describeIndexes,
} from "../lib/schema-context.mjs";
import { digestForModel } from "../lib/digest.ts";

const plan = (f: string) =>
  recommendStatement(
    parsePlanText(decodeBytes(readFileSync(`fixtures/eval/${f}`))),
  );
const orders = (indexes: unknown[]) =>
  JSON.stringify([{ schema: "dbo", table: "Orders", rows: 60000, indexes }]);
const idx = (
  name: string,
  keys: string[],
  include: string[] = [],
  extra: object = {},
) => ({
  name,
  type: "NONCLUSTERED",
  unique: false,
  filtered: false,
  keys: keys.map((column) => ({ column, desc: false })),
  include: include.map((column) => ({ column })),
  ...extra,
});
const withContext = (f: string, text: string) => {
  const d = plan(f);
  d.schemaContext = parseContext(text);
  return ruleOptions(d).map((o: any) => ({
    ...o,
    sql: o.sql_to_run.replace(/\s+/g, " "),
  }));
};

test("the context query reads only system views for the plan's permanent tables", () => {
  const sql = contextQuery([
    "[Sales].[dbo].[Orders]",
    "dbo.Customers",
    "#tmp",
    "dbo.O'Brien",
  ])!;
  assert.match(sql, /IN \(N'\[dbo\]\.\[Orders\]'|IN \(N'dbo\.Orders'/);
  assert.match(sql, /N'dbo\.O''Brien'/);
  assert.doesNotMatch(sql, /#tmp/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|EXEC)\b/i);
  assert.equal(contextQuery(["#tmp", "@t"]), null);
});

test("the pasted result is parsed from SSMS output split over lines, and junk is refused", () => {
  const text = orders([
    idx("IX_Orders_CustomerId", ["CustomerId"], ["OrderDate"]),
  ]);
  const split = `existing_indexes\n----\n${text.slice(0, 40)}\n${text.slice(40)}\n(1 row affected)`;
  const c = parseContext(split)!;
  assert.equal(c.tables[0].rows, 60000);
  assert.deepEqual(c.tables[0].indexes[0].include, ["OrderDate"]);
  assert.equal(parseContext("not json"), null);
  assert.equal(parseContext("[1, 2]"), null);
  assert.equal(parseContext(""), null);
  assert.deepEqual(describeIndexes(c), [
    "dbo.Orders.IX_Orders_CustomerId NONCLUSTERED (CustomerId) INCLUDE (OrderDate) [table rows 60000]",
  ]);
});

test("the models see the existing indexes", () => {
  const d = plan("key-lookup.sqlplan");
  d.schemaContext = parseContext(orders([idx("IX_A", ["CustomerId"])]));
  assert.deepEqual((digestForModel(d) as any).existing_indexes, [
    "dbo.Orders.IX_A NONCLUSTERED (CustomerId) [table rows 60000]",
  ]);
  assert.equal(
    (digestForModel(plan("key-lookup.sqlplan")) as any).existing_indexes,
    undefined,
  );
});

test("an index with the same keys is extended with DROP_EXISTING instead of duplicated", () => {
  const [o] = withContext(
    "key-lookup.sqlplan",
    orders([idx("IX_Orders_CustomerId", ["CustomerId"], ["OrderDate"])]),
  );
  assert.equal(
    o.sql,
    "CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId] ON [dbo].[Orders] ([CustomerId]) INCLUDE ([OrderDate], [Status], [Total]) WITH (DROP_EXISTING = ON);",
  );
  // Rollback puts the original definition back.
  assert.match(
    o.rollback[0],
    /INCLUDE \(\[OrderDate\]\) WITH \(DROP_EXISTING = ON\)/,
  );
});

test("an index that already covers the suggestion removes the index-only option", () => {
  const opts = withContext(
    "key-lookup.sqlplan",
    orders([idx("IX_Full", ["CustomerId", "OrderDate"], ["Status", "Total"])]),
  );
  assert.equal(
    opts.some((o: any) => /CREATE/.test(o.sql)),
    false,
  );
});

test("a filtered or differently keyed index is not treated as a match", () => {
  const [o] = withContext(
    "key-lookup.sqlplan",
    orders([
      idx("IX_Open", ["CustomerId"], ["Status", "Total"], {
        filtered: true,
        filter: "([Status]='open')",
      }),
      idx("IX_Date", ["OrderDate"], ["CustomerId", "Status", "Total"]),
    ]),
  );
  assert.match(
    o.sql,
    /^CREATE NONCLUSTERED INDEX \[\w+\] ON \[dbo\]\.\[Orders\] \(\[CustomerId\]\) INCLUDE \(\[Status\], \[Total\]\);$/,
  );
  assert.doesNotMatch(o.sql, /DROP_EXISTING/);
});

test("without context the options are unchanged", () => {
  const plain = ruleOptions(plan("key-lookup.sqlplan"));
  const d = plan("key-lookup.sqlplan");
  d.schemaContext = null;
  assert.deepEqual(ruleOptions(d), plain);
});
