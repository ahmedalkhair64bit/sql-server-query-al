"use client";
import { useEffect, useState } from "react";
import { SuccessCheck } from "./motion";

const STEPS = [
  {
    key: "uploading",
    title: "Index the plan",
    sub: "Streaming the XML to disk",
    doing: ["Streaming the XML to disk", "Finding the statements"],
  },
  {
    key: "digesting",
    title: "Rule checks",
    sub: "Operators, estimates, waits, findings",
    doing: ["Reading operators and warnings", "Running the rule checks"],
  },
  {
    key: "proposing",
    title: "Options from your model",
    sub: "2 to 4 distinct remedies",
    doing: [
      "Reading the costliest operators",
      "Comparing estimated and actual rows",
      "Drafting distinct fixes with their SQL",
      "Adding validation and rollback",
    ],
  },
  {
    key: "judging",
    title: "Jev decides",
    sub: "Scores every option, picks or declines",
    doing: [
      "Checking each option's safety",
      "Scoring fit to the bottleneck",
      "Weighing the options against each other",
    ],
  },
] as const;

// The live view of a run: which stage is running, what is done, and how long it has taken.
export function PipelineProgress({
  stage,
  startedAt,
}: {
  stage: string;
  /** When the run began on the server, for a page opened after it started. */
  startedAt?: number;
}) {
  const index = Math.max(
    0,
    STEPS.findIndex((s) => s.key === stage),
  );
  const [started] = useState(() => startedAt ?? Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, (now - started) / 1000);
  // The running step names, in turn, the parts of its work (every 2.6 s), so a long model call reads as
  // work in progress rather than a frozen screen.
  const tick = Math.floor(seconds / 2.6);
  const steps = stage === "uploading" ? STEPS.slice(0, 1) : STEPS.slice(1);
  const current = stage === "uploading" ? 0 : index - 1;
  return (
    <section className="pipeline" role="status" aria-live="polite">
      <div className="pipeline-head">
        <strong className="t-swap t-shimmer" key={stage}>
          {STEPS[index].title}…
        </strong>
        <span className="pipeline-timer">{seconds.toFixed(1)} s</span>
      </div>
      <ol className="pipeline-steps">
        {steps.map((s, i) => (
          <li
            key={s.key}
            data-state={
              i < current ? "done" : i === current ? "active" : "todo"
            }
          >
            <span className="pipeline-dot" aria-hidden="true">
              {i < current ? <SuccessCheck size={14} /> : i + 1}
            </span>
            <span className="pipeline-text">
              <strong>{s.title}</strong>
              {i === current ? (
                <small
                  className="t-swap"
                  key={tick % s.doing.length}
                  aria-hidden="true"
                >
                  {s.doing[tick % s.doing.length]}
                </small>
              ) : (
                <small>{s.sub}</small>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="pipeline-bar" aria-hidden="true">
        <span
          style={{
            width: `${Math.min(100, ((current + 0.5) / steps.length) * 100)}%`,
          }}
        />
      </div>
    </section>
  );
}
