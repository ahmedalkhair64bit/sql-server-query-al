#!/usr/bin/env python3
"""Independent ground truth for ShowPlan XML, to check lib/plan-parser.mjs against.

Written against the ShowPlan schema with Python's ElementTree: a different language and XML parser that shares
no code with the app, so an agreement between the two is evidence, not a tautology. For every statement that has
a query plan it prints one JSON line with what a DBA would read off the plan:

  statement text and estimated cost, measured CPU/elapsed, memory grant, missing-index requests, and per
  operator: estimated subtree and own cost (subtree minus direct children), estimated rows and executions,
  actual rows, executions, logical reads and elapsed time summed/maxed over threads, the object it touches,
  and whether it is a lookup.

  python3 scripts/verify-parser.py plan.sqlplan [...]   (see scripts/verify-parser.mjs for the comparison)
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

NS = "{http://schemas.microsoft.com/sqlserver/2004/07/showplan}"


def local(tag):
    return tag.split("}", 1)[-1]


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def read_xml(path):
    raw = open(path, "rb").read()
    for bom, enc in ((b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be"), (b"\xef\xbb\xbf", "utf-8-sig")):
        if raw.startswith(bom):
            return raw.decode(enc)
    if raw[:2] == b"<\x00":
        return raw.decode("utf-16-le")
    return raw.decode("utf-8")


def child_relops(relop):
    """RelOps directly below this one: the first RelOp on every path down, not deeper ones."""
    out = []

    def walk(el):
        for c in el:
            if local(c.tag) == "RelOp":
                out.append(c)
            else:
                walk(c)

    walk(relop)
    return out


def operator(relop):
    a = relop.attrib
    subtree = num(a.get("EstimatedTotalSubtreeCost")) or 0.0
    kids = child_relops(relop)
    own = subtree - sum(num(k.get("EstimatedTotalSubtreeCost")) or 0.0 for k in kids)
    threads = [
        t
        for rti in relop.findall(NS + "RunTimeInformation")
        for t in rti.findall(NS + "RunTimeCountersPerThread")
    ]
    def total(attr):
        vals = [num(t.get(attr)) for t in threads if t.get(attr) is not None]
        return sum(vals) if vals else None

    def most(attr):
        vals = [num(t.get(attr)) for t in threads if t.get(attr) is not None]
        return max(vals) if vals else None

    obj = None
    lookup = False
    for child in relop:
        if local(child.tag) in ("RelOp", "OutputList", "RunTimeInformation", "Warnings", "MemoryFractions"):
            continue
        if child.get("Lookup") in ("1", "true"):
            lookup = True
        o = child.find(NS + "Object")
        if o is not None:
            parts = [o.get(k) for k in ("Database", "Schema", "Table", "Index")]
            obj = ".".join(p.strip("[]") for p in parts if p)
            break
    return {
        "id": a.get("NodeId"),
        "op": a.get("PhysicalOp"),
        "subtree": subtree,
        "own": max(own, 0.0),
        "estRows": num(a.get("EstimateRows")),
        "estExecs": (num(a.get("EstimateRebinds")) or 0) + (num(a.get("EstimateRewinds")) or 0) + 1,
        "actualRows": total("ActualRows"),
        "execs": total("ActualExecutions"),
        "logicalReads": total("ActualLogicalReads"),
        "elapsedMs": most("ActualElapsedms"),
        "threads": len(threads),
        "parallel": a.get("Parallel") in ("1", "true"),
        "object": obj,
        "lookup": lookup or (a.get("PhysicalOp") in ("RID Lookup",)),
        "children": [k.get("NodeId") for k in kids],
        "batch": any(t.get("ActualExecutionMode") == "Batch" for t in threads),
    }


def statements(root):
    for stmt in root.iter():
        if local(stmt.tag) not in ("StmtSimple", "StmtCursor", "StmtCond", "StmtUseDb", "StmtReceive", "ExternalDistributedComputation"):
            continue
        if local(stmt.tag) == "StmtCond":
            continue  # its branches are statements of their own
        plans = [stmt.find(NS + "QueryPlan")]
        if plans[0] is None:
            # A cursor keeps one QueryPlan per operation (population, fetch) under CursorPlan.
            plans = list(stmt.iter(NS + "QueryPlan"))
            if not plans:
                continue
        plan = plans[0]
        ops = [operator(r) for p in plans for r in p.iter(NS + "RelOp")]
        qts = plan.find(NS + "QueryTimeStats")
        mg = plan.find(NS + "MemoryGrantInfo")
        missing = plan.findall(".//" + NS + "MissingIndex")
        yield {
            "statementId": stmt.get("StatementId"),
            "type": stmt.get("StatementType"),
            "sql": re.sub(r"\s+", " ", stmt.get("StatementText") or "").strip(),
            "cost": num(stmt.get("StatementSubTreeCost")),
            "cpuMs": num(qts.get("CpuTime")) if qts is not None else None,
            "elapsedMs": num(qts.get("ElapsedTime")) if qts is not None else None,
            "grantedKb": num(mg.get("GrantedMemory")) if mg is not None else None,
            "maxUsedKb": num(mg.get("MaxUsedMemory")) if mg is not None else None,
            "missingIndexes": len(missing),
            "operators": ops,
        }


def main():
    for path in sys.argv[1:]:
        try:
            text = re.sub(r"^\s*<\?xml[^>]*\?>", "", read_xml(path))  # the declared encoding no longer applies
            root = ET.fromstring(text)
        except ET.ParseError as e:
            print(json.dumps({"file": path, "error": str(e)}))
            continue
        for s in statements(root):
            s["file"] = path
            print(json.dumps(s))


if __name__ == "__main__":
    main()
