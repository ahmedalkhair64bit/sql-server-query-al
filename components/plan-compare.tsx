"use client";
import { useState } from "react";
import type { Candidate } from "@/lib/analyst";

type Metric = {
  label: string;
  unit: string;
  before: number | null;
  after: number | null;
  change: number | null;
};
type Item = { rule: string; title: string };
export type Comparison = {
  basis: "measured" | "estimated";
  verdict: "improved" | "regressed" | "unchanged" | "inconclusive";
  summary: string;
  sameQuery: boolean | null;
  metrics: Metric[];
  resolved: Item[];
  remaining: Item[];
  introduced: Item[];
  appliedKey: string | null;
  afterPlan: string;
  at: number;
};

const VERDICT = {
  improved: "Improved",
  regressed: "Regressed",
  unchanged: "No clear change",
  inconclusive: "Inconclusive",
};
const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString());
const pct = (v: number | null) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

// After applying an option, upload the new plan: the app compares it with the analysed statement and
// records the outcome, which is the only real evidence of whether the recommendation worked.
export function PlanCompare({
  id,
  candidates,
  recommended,
  initial,
}: {
  id: string;
  candidates: Candidate[];
  recommended: string | null;
  initial: Comparison | null;
}) {
  const [result, setResult] = useState<Comparison | null>(initial);
  const [applied, setApplied] = useState(
    initial?.appliedKey ?? recommended ?? candidates[0]?.key ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function compare(file: File) {
    setBusy(true);
    setError("");
    try {
      const up = await fetch("/api/plans", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-plan-name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const plan = await up.json();
      if (!up.ok) throw new Error(plan.error);
      const r = await fetch(`/api/analyses/${id}/compare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, appliedKey: applied || null }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card compare-section" data-compare>
      <div className="section-title">
        <h2>Did it work?</h2>
        {result && (
          <span className="pill" data-verdict={result.verdict}>
            {VERDICT[result.verdict]}
          </span>
        )}
      </div>
      <p className="muted">
        After applying an option, capture the actual execution plan again and
        upload it here. The app compares it with this analysis.
      </p>
      <div className="compare-controls no-print">
        {candidates.length > 0 && (
          <label>
            Option applied
            <select
              value={applied}
              onChange={(e) => setApplied(e.target.value)}
            >
              {candidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.title}
                </option>
              ))}
              <option value="">Something else</option>
            </select>
          </label>
        )}
        <label className="btn">
          {busy ? "Comparing…" : "Upload the after plan"}
          <input
            type="file"
            accept=".sqlplan,.xml"
            hidden
            disabled={busy}
            aria-label="After plan file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void compare(f);
            }}
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>
            <strong>{VERDICT[result.verdict]}.</strong> {result.summary}
            {result.sameQuery === false &&
              " The after plan has a different query hash (expected for a rewrite)."}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {result.metrics.map((m) => (
                  <tr key={m.label}>
                    <td>
                      {m.label}
                      {m.unit && <small>{m.unit}</small>}
                    </td>
                    <td>{fmt(m.before)}</td>
                    <td>{fmt(m.after)}</td>
                    <td>{pct(m.change)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!result.resolved.length && (
            <p className="notice">
              Resolved: {result.resolved.map((f) => f.title).join(" · ")}
            </p>
          )}
          {!!result.introduced.length && (
            <p className="notice danger-text">
              New: {result.introduced.map((f) => f.title).join(" · ")}
            </p>
          )}
          {!!result.remaining.length && (
            <p className="muted">
              Still present: {result.remaining.map((f) => f.title).join(" · ")}
            </p>
          )}
          <small className="muted">
            Compared with {result.afterPlan} on{" "}
            {new Date(result.at).toLocaleString()}
          </small>
        </>
      )}
    </section>
  );
}
