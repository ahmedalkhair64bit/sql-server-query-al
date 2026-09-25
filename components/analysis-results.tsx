"use client";
import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { Candidate } from "@/lib/analyst";
import type { Digest } from "@/lib/digest";
import type { Verdict } from "@/lib/jev";
import { Icon } from "./icons";
import { copyText } from "@/lib/clipboard";
gsap.registerPlugin(useGSAP, ScrollTrigger);
const labels: Record<string, string> = {
  bottleneck_fit: "Bottleneck fit",
  semantic_safety: "Semantic safety",
  ease: "Operational ease",
  root_cause: "Root cause",
};
export function AnalysisResults({
  digest,
  candidates,
  verdict: initial,
  id,
}: {
  digest: Digest | null;
  candidates: Candidate[];
  verdict: Verdict | null;
  id?: string;
}) {
  const [updated, setUpdated] = useState<Verdict | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState("");
  const verdict = updated ?? initial;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const states = new Map<HTMLDetailsElement, boolean>();
    const before = () => {
      root.current?.querySelectorAll("details").forEach((el) => {
        states.set(el, el.open);
        el.open = true;
      });
    };
    const after = () => {
      states.forEach((open, el) => {
        el.open = open;
      });
      states.clear();
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".decision-card", { y: 12, opacity: 0, duration: 0.35 });
        ScrollTrigger.batch(".option-card", {
          onEnter: (els) =>
            gsap.fromTo(
              els,
              { y: 12, opacity: 0.4 },
              { y: 0, opacity: 1, stagger: 0.06, duration: 0.35 },
            ),
          once: true,
        });
      });
      return () => mm.revert();
    },
    { scope: root, dependencies: [candidates.length, verdict?.status] },
  );
  const selected =
    verdict?.source === "jev"
      ? candidates.find((c) => c.key === verdict.headline)
      : null;
  async function retry() {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/analyses/${id}/jev`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setUpdated(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string, key: string) {
    try {
      await copyText(value);
      setCopied(key);
    } catch {
      setError(
        "Clipboard access failed. Select the SQL text and copy it manually.",
      );
    }
  }
  const sorted = [...candidates].sort((a, b) =>
    a.key === selected?.key ? -1 : b.key === selected?.key ? 1 : 0,
  );
  return (
    <div ref={root} className="results" id="report">
      {verdict && (
        <section
          className={`decision-card ${selected ? "chosen" : "abstained"}`}
          data-verdict
        >
          <div className="decision-eyebrow">
            <Icon name="shield" size={18} />
            {selected
              ? "Jev’s recommended first action"
              : "Jev has not selected an action"}
          </div>
          <h2>
            {selected?.title ??
              (verdict.status === "unavailable"
                ? "Decision engine unavailable"
                : "More evidence is needed")}
          </h2>
          <p>
            {selected && <strong>Expected effect: </strong>}
            {selected?.expected ??
              "The alternatives below are not approved recommendations. Review the evidence, add missing context, or retry Jev."}
          </p>
          <div className="decision-meta">
            {selected && (
              <span>
                Decision confidence {Math.round(verdict.jev_confidence * 100)}%
              </span>
            )}
            {id && (
              <button className="btn" onClick={retry} disabled={busy}>
                {busy ? "Jev is reviewing…" : "Retry Jev"}
              </button>
            )}
            <button className="btn" onClick={() => window.print()}>
              Export to PDF
            </button>
          </div>
          {verdict.flags.filter((f) => !f.includes("Jev could")).length > 0 && (
            <p className="muted">
              {verdict.flags.map((f) => f.replaceAll("_", " ")).join(" · ")}
            </p>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {digest && (
        <section className="evidence-section">
          <div className="section-title">
            <h2>What the plan tells us</h2>
            <span className="pill">
              {digest.actual
                ? "Actual execution plan"
                : "Estimated execution plan"}
            </span>
          </div>
          <div className="grid-metrics">
            <div>
              <span>Estimated subtree cost</span>
              <strong>
                {digest.subtreeCost?.toLocaleString() ?? "Not available"}
              </strong>
              <small>Optimizer units, not runtime</small>
            </div>
            <div>
              <span>Tables in scope</span>
              <strong>{digest.tables.length}</strong>
              <small>Selected statement only</small>
            </div>
            <div>
              <span>Execution</span>
              <strong>{digest.parallel ? "Parallel" : "Serial"}</strong>
              <small>
                {digest.nonParallelReason ?? "As recorded in the plan"}
              </small>
            </div>
          </div>
          {(digest.queryTime || digest.memoryGrant) && (
            <div className="grid-metrics">
              {digest.queryTime?.elapsedMs != null && (
                <div>
                  <span>Measured elapsed time</span>
                  <strong>
                    {digest.queryTime.elapsedMs.toLocaleString()} ms
                  </strong>
                  <small>
                    CPU {digest.queryTime.cpuMs?.toLocaleString() ?? "—"} ms
                  </small>
                </div>
              )}
              {digest.memoryGrant?.grantedKb != null && (
                <div>
                  <span>Memory grant</span>
                  <strong>
                    {digest.memoryGrant.grantedKb.toLocaleString()} KB
                  </strong>
                  <small>
                    Max used{" "}
                    {digest.memoryGrant.maxUsedKb?.toLocaleString() ?? "—"} KB
                  </small>
                </div>
              )}
            </div>
          )}
          {digest.parameters?.some((p) => p.differs) && (
            <p className="notice">
              Compiled for different parameter values than it ran with:{" "}
              {digest.parameters
                .filter((p) => p.differs)
                .map(
                  (p) => `${p.name} compiled ${p.compiled}, ran ${p.runtime}`,
                )
                .join(" · ")}
            </p>
          )}
          {digest.earlyAbort && (
            <p className="notice">
              Optimization ended early: <strong>{digest.earlyAbort}</strong>
            </p>
          )}
          <details className="evidence-details">
            <summary>Inspect operators and evidence</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Estimated rows per execution</th>
                    <th>Actual rows</th>
                    <th>
                      {digest.costBasis === "operator"
                        ? "Estimated operator cost"
                        : "Estimated subtree cost"}
                    </th>
                    {digest.actual && <th>Own time (ms)</th>}
                    {digest.actual && <th>Logical reads</th>}
                  </tr>
                </thead>
                <tbody>
                  {digest.topOperators.map((o, i) => (
                    <tr key={`${o.id}-${i}`}>
                      <td>
                        {o.op}
                        {o.lookup ? " (lookup)" : ""}
                        <small>
                          Node {o.id}
                          {o.object ? ` · ${o.object}` : ""}
                        </small>
                      </td>
                      <td>{o.estRows.toLocaleString()}</td>
                      <td>
                        {o.actualRows?.toLocaleString() ?? "Not recorded"}
                        {o.execs != null && o.execs > 1 && (
                          <small>{o.execs.toLocaleString()} executions</small>
                        )}
                      </td>
                      <td>{o.cost.toLocaleString()}</td>
                      {digest.actual && (
                        <td>{o.actualElapsedMs?.toLocaleString() ?? "—"}</td>
                      )}
                      {digest.actual && (
                        <td>{o.logicalReads?.toLocaleString() ?? "—"}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {digest.warnings.map((w, i) => (
              <p className="notice" key={i}>
                {w}
              </p>
            ))}
          </details>
          {!!digest.coverage?.length && (
            <details>
              <summary>Evidence coverage and limitations</summary>
              <ul>
                {digest.coverage.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {!!candidates.length && (
        <section>
          <div className="section-title">
            <h2>
              {selected ? "Your action plan" : "Remediation alternatives"}
            </h2>
            <span className="muted">{candidates.length} options evaluated</span>
          </div>
          {sorted.map((c, i) => {
            const scores = verdict?.order.find((r) => r.key === c.key);
            const winner = c.key === selected?.key;
            return (
              <details
                key={c.key}
                className={`option-card ${winner ? "selected-option" : ""}`}
                open={winner || (!selected && i === 0)}
              >
                <summary>
                  <span className="option-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.option_type}{" "}
                      {winner
                        ? "· Recommended by Jev"
                        : c.rejected_reasons?.length
                          ? "· Needs correction"
                          : "· Alternative"}
                    </small>
                  </span>
                  <Icon name="plus" size={17} />
                </summary>
                <div className="option-content">
                  <p>{c.diagnosis}</p>
                  {c.rejected_reasons?.map((r, i) => (
                    <p className="notice danger-text" key={i}>
                      {r}
                    </p>
                  ))}
                  {scores?.flags
                    .filter((f) =>
                      [
                        "unsupported_claim",
                        "operational_risk",
                        "invalid_evidence",
                        "low_confidence",
                      ].includes(f),
                    )
                    .map((f) => (
                      <p className="notice" key={f}>
                        Jev review:{" "}
                        {
                          (
                            {
                              unsupported_claim:
                                "The plan evidence does not sufficiently support this claim.",
                              operational_risk:
                                "Operational risk is too high for a recommended first action.",
                              invalid_evidence:
                                "The evidence or required validation is incomplete.",
                              low_confidence:
                                "The assessment is uncertain; gather more evidence.",
                            } as Record<string, string>
                          )[f]
                        }
                      </p>
                    ))}
                  {scores?.flags.includes("verify_semantics") && (
                    <p className="notice danger-text">
                      Semantic safety was insufficient. This option cannot be
                      selected.
                    </p>
                  )}
                  {!!c.prerequisites?.length && (
                    <>
                      <h3>Before you start</h3>
                      <ul>
                        {c.prerequisites.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <h3>Steps to take</h3>
                  <ol className="action-steps">
                    {c.actions.map((a, i) => (
                      <li key={i}>
                        <strong>{a.title}</strong>
                        <p>{a.detail}</p>
                        <small>
                          {a.effort} effort
                          {a.requires_change_control
                            ? " · Change approval required"
                            : ""}
                        </small>
                      </li>
                    ))}
                  </ol>
                  {c.sql_to_run && (
                    <div className="sql-block">
                      <div>
                        <span>T-SQL · Review before running</span>
                        <button
                          className="btn"
                          onClick={() => copy(c.sql_to_run!, c.key)}
                        >
                          {copied === c.key ? "Copied" : "Copy SQL"}
                        </button>
                      </div>
                      <pre className="sql">
                        <code>{c.sql_to_run}</code>
                      </pre>
                    </div>
                  )}
                  <div className="validation-grid">
                    <div>
                      <h3>Validate the result</h3>
                      <ul>
                        {(c.validation?.length
                          ? c.validation
                          : [
                              "Compare results and runtime against the original in a test environment.",
                            ]
                        ).map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3>Rollback</h3>
                      <ul>
                        {(c.rollback?.length
                          ? c.rollback
                          : [
                              "Record the original configuration and prepare a reviewed recovery procedure before changing anything.",
                            ]
                        ).map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {scores && verdict?.status !== "unavailable" && (
                    <div className="score-grid">
                      {Object.entries(scores.dims).map(([key, d]) => (
                        <div key={key}>
                          <span>
                            {labels[key]}
                            <strong>{Math.round(d.value * 100)}%</strong>
                          </span>
                          <div className="score-track">
                            <div
                              className="bar"
                              style={{ width: `${d.value * 100}%` }}
                            />
                          </div>
                          <small>
                            {d.confidence === null
                              ? "Probability of root-cause fit"
                              : `Confidence ${Math.round(d.confidence * 100)}%`}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                  {!!c.evidence_ids?.length && (
                    <p className="evidence-refs">
                      Evidence: {c.evidence_ids.join(" · ")}
                    </p>
                  )}
                </div>
              </details>
            );
          })}
        </section>
      )}
    </div>
  );
}
