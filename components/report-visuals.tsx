"use client";
import { useEffect, useRef, useState } from "react";
import type { Candidate } from "@/lib/analyst";
import type { Digest } from "@/lib/digest";
import type { Verdict } from "@/lib/jev";

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A number that counts up once when it first appears (static under reduced motion). */
export function CountUp({
  value,
  decimals = 0,
  suffix = "",
}: {
  value: number;
  decimals?: number;
  suffix?: string;
}) {
  const [shown, setShown] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (!first.current || reduced()) return;
    first.current = false;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 700);
      setShown(value * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <>
      {shown.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </>
  );
}

/** Jev's confidence in its pick, as a ring. The number in the middle is the value; the ring only echoes it. */
export function ConfidenceRing({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const r = 34,
    c = 2 * Math.PI * r;
  return (
    <figure
      className="ring"
      aria-label={`${label}: ${Math.round(value * 100)}%`}
    >
      <svg viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
        <circle cx="42" cy="42" r={r} className="ring-track" />
        <circle
          cx="42"
          cy="42"
          r={r}
          className="ring-value"
          strokeDasharray={c}
          style={{ ["--ring-offset" as string]: `${c * (1 - value)}` }}
        />
      </svg>
      <figcaption>
        <strong>
          <CountUp value={Math.round(value * 100)} suffix="%" />
        </strong>
        <small>{label}</small>
      </figcaption>
    </figure>
  );
}

const FLAG_TEXT: Record<string, string> = {
  low_confidence: "Jev was not confident enough in any single option.",
  nothing_clearly_worthwhile:
    "Jev judged that no option is clearly worth running on this evidence.",
  no_suitable_action: "Every option failed a safety, evidence or fit check.",
  jev_partial: "Jev could not review every option; retry to include them.",
  jev_unavailable: "Jev could not be reached, so nothing was selected.",
};

/** How Jev weighed each choice. Bars share one hue; the pick is marked by label and weight, not colour alone. */
export function ProbabilityBars({
  verdict,
  candidates,
}: {
  verdict: Verdict;
  candidates: Candidate[];
}) {
  const title = (key: string) =>
    key === "no_suitable_action"
      ? "Collect more evidence first"
      : (candidates.find((c) => c.key === key)?.title ?? key);
  const probs = verdict.jev_probabilities;
  const rows = probs
    ? Object.entries(probs).sort((a, b) => b[1] - a[1])
    : verdict.order.map((r) => [r.key, r.composite] as [string, number]);
  if (!rows.length) return null;
  return (
    <div className="prob">
      <p className="prob-caption">
        {probs ? "How Jev weighed each choice" : "Composite score per option"}
      </p>
      <ul>
        {rows.slice(0, 6).map(([key, p]) => {
          const picked = key === verdict.headline;
          return (
            <li
              key={key}
              data-picked={picked || undefined}
              title={`${title(key)}: ${Math.round(p * 100)}%`}
            >
              <span className="prob-label">
                {picked && <span className="prob-mark">Pick</span>}
                {title(key)}
              </span>
              <span className="prob-track">
                <span
                  className="prob-fill"
                  style={{ ["--w" as string]: `${Math.max(2, p * 100)}%` }}
                />
              </span>
              <span className="prob-value">{Math.round(p * 100)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function JevDecision({
  verdict,
  candidates,
  onRetry,
  busy,
}: {
  verdict: Verdict;
  candidates: Candidate[];
  onRetry?: () => void;
  busy: boolean;
}) {
  const selected =
    verdict.source === "jev"
      ? candidates.find((c) => c.key === verdict.headline)
      : null;
  const judged = verdict.order.length;
  const blocked = verdict.order.filter((r) =>
    r.flags.some((f) =>
      [
        "verify_semantics",
        "invalid_evidence",
        "low_confidence",
        "unsupported_claim",
        "operational_risk",
        "jev_failed",
      ].includes(f),
    ),
  ).length;
  const reasons = verdict.flags.map((f) => FLAG_TEXT[f]).filter(Boolean);
  const healthy = verdict.flags.includes("nothing_to_fix");
  const state = selected
    ? "chosen"
    : healthy
      ? "healthy"
      : verdict.status === "unavailable"
        ? "unavailable"
        : "abstained";
  return (
    <section className={`decision-hero ${state}`} data-verdict>
      <div className="decision-main">
        <p className="decision-eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          {selected
            ? "Jev's recommended first action"
            : state === "healthy"
              ? "No action needed"
              : state === "unavailable"
                ? "Jev did not answer"
                : "Jev declined to pick an action"}
        </p>
        <h2>
          {selected?.title ??
            (state === "healthy"
              ? "No change recommended for this plan"
              : state === "unavailable"
                ? "Decision engine unavailable"
                : "More evidence is needed")}
        </h2>
        <p className="decision-lead">
          {selected ? (
            <>
              <strong>Expected effect: </strong>
              {selected.expected}
            </>
          ) : state === "healthy" ? (
            (verdict.reason ??
            "The analyst found no performance problem worth changing.")
          ) : (
            (reasons[0] ??
            "The alternatives below are not approved recommendations. Review the evidence, add context, or retry Jev.")
          )}
        </p>
        {judged > 0 && (
          <ul className="decision-facts">
            <li>
              <strong>{judged}</strong> options judged
            </li>
            <li>
              <strong>{judged - blocked}</strong> passed every check
            </li>
            {selected && (
              <li>
                {verdict.agrees
                  ? "Agrees with the composite ranking"
                  : "Overrode the composite ranking"}
              </li>
            )}
          </ul>
        )}
        <div className="decision-actions no-print">
          {onRetry && !healthy && (
            <button className="btn" onClick={onRetry} disabled={busy}>
              {busy ? "Jev is reviewing…" : "Retry Jev"}
            </button>
          )}
          <button className="btn" onClick={() => window.print()}>
            Export to PDF
          </button>
        </div>
      </div>
      <div className="decision-side">
        {verdict.status !== "unavailable" && judged > 0 && (
          <ConfidenceRing
            value={
              selected ? verdict.jev_confidence : verdict.anything_worth_running
            }
            label={selected ? "Decision confidence" : "Anything worth running"}
          />
        )}
        {verdict.status !== "unavailable" && (
          <ProbabilityBars verdict={verdict} candidates={candidates} />
        )}
      </div>
    </section>
  );
}

/** Headline numbers from the plan. Measured values lead; estimates are labelled as such. */
export function MetricTiles({ digest }: { digest: Digest }) {
  const reads = (digest.topOperators ?? []).reduce(
    (s, o) => s + (o.logicalReads ?? 0),
    0,
  );
  const g = digest.memoryGrant;
  const tiles: {
    label: string;
    value: number | null;
    unit?: string;
    note: string;
    decimals?: number;
  }[] = [
    {
      label: "Elapsed time",
      value: digest.queryTime?.elapsedMs ?? null,
      unit: " ms",
      note: "Measured",
    },
    {
      label: "CPU time",
      value: digest.queryTime?.cpuMs ?? null,
      unit: " ms",
      note: "Measured",
    },
    { label: "Logical reads", value: reads || null, note: "Top operators" },
    {
      label: "Memory grant",
      value: g?.grantedKb != null ? Math.round(g.grantedKb / 1024) : null,
      unit: " MB",
      note:
        g?.maxUsedKb != null
          ? `${Math.round(g.maxUsedKb / 1024).toLocaleString()} MB used`
          : "Granted",
    },
    {
      label: "Estimated cost",
      value: digest.subtreeCost,
      note: "Optimizer units, not time",
      decimals: (digest.subtreeCost ?? 0) < 10 ? 3 : 1,
    },
  ];
  const shown = tiles.filter((t) => t.value != null);
  return (
    <div className="kpis">
      {shown.map((t) => (
        <div className="kpi" key={t.label}>
          <span>{t.label}</span>
          <strong>
            <CountUp
              value={t.value!}
              decimals={t.decimals ?? 0}
              suffix={t.unit ?? ""}
            />
          </strong>
          <small>{t.note}</small>
        </div>
      ))}
      <div className="kpi">
        <span>Execution</span>
        <strong>{digest.parallel ? "Parallel" : "Serial"}</strong>
        <small>{digest.actual ? "Actual plan" : "Estimated plan"}</small>
      </div>
    </div>
  );
}

const SEVERITY = {
  critical: { icon: "!", label: "Critical" },
  warning: { icon: "▲", label: "Warning" },
  info: { icon: "i", label: "Note" },
} as const;
export function FindingCards({
  findings,
}: {
  findings: {
    rule: string;
    severity: "critical" | "warning" | "info";
    title: string;
    detail: string;
  }[];
}) {
  if (!findings.length)
    return (
      <p className="finding-empty">
        <span aria-hidden="true">✓</span> No known problem patterns in this
        plan.
      </p>
    );
  return (
    <ul className="finding-grid" data-findings>
      {findings.map((f, i) => (
        <li key={i} className="finding-card" data-severity={f.severity}>
          <span className="finding-icon" aria-hidden="true">
            {SEVERITY[f.severity].icon}
          </span>
          <div>
            <span className="finding-sev">{SEVERITY[f.severity].label}</span>
            <strong>{f.title}</strong>
            <p>{f.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Where the time (or estimated cost) went, per operator. One hue; values are printed, not just drawn. */
export function TimeBars({ digest }: { digest: Digest }) {
  const measured = digest.topOperators.some(
    (o) => (o.actualElapsedMs ?? 0) > 0,
  );
  const value = (o: Digest["topOperators"][number]) =>
    measured ? (o.actualElapsedMs ?? 0) : o.cost;
  const rows = [...digest.topOperators]
    .filter((o) => value(o) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, 8);
  if (rows.length < 2) return null;
  const max = value(rows[0]);
  const total = digest.topOperators.reduce((s, o) => s + value(o), 0);
  return (
    <figure className="timebars">
      <figcaption>
        {measured
          ? "Where the time went: each operator's own elapsed time"
          : "Where the estimated cost is: each operator's own cost"}
      </figcaption>
      <ul>
        {rows.map((o) => {
          const v = value(o);
          const share = total ? Math.round((100 * v) / total) : 0;
          const text = measured
            ? `${v.toLocaleString()} ms`
            : v.toLocaleString(undefined, { maximumFractionDigits: 3 });
          return (
            <li
              key={o.id}
              title={`${o.op} (node ${o.id})${o.object ? ` on ${o.object}` : ""}: ${text}, ${share}% of the listed operators`}
            >
              <span className="tb-label">
                {o.op}
                <small>
                  Node {o.id}
                  {o.object
                    ? ` · ${o.object.split(".").slice(-2).join(".")}`
                    : ""}
                </small>
              </span>
              <span className="tb-track">
                <span
                  className="tb-fill"
                  style={{
                    ["--w" as string]: `${Math.max(1.5, (100 * v) / max)}%`,
                  }}
                />
              </span>
              <span className="tb-value">
                {text}
                <small>{share}%</small>
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
