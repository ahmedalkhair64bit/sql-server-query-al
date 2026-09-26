# Real ShowPlan test plans

Copied unchanged from the `test_plans` folder of
[JustinPealing/html-query-plan](https://github.com/JustinPealing/html-query-plan) at commit
`975fec279303aeec9d685398d4d8d170a05bcdcc`, under the MIT licence in `LICENSE`.

54 plans produced by SQL Server itself: spills, adaptive joins, key and RID lookups, eager and lazy spools,
cursors, columnstore DML, batch mode, conditional statements, unmatched filtered indexes, a join without a
predicate, and real Stack Overflow data-explorer queries. `npm run verify:parser` checks every number the
parser reads from them against an independent reader (`scripts/verify-parser.py`).
