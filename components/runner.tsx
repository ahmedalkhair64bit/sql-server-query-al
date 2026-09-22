"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readSse } from "@/lib/stream";
import type { Candidate } from "@/lib/analyst";
import type { Digest } from "@/lib/digest";
import type { Verdict } from "@/lib/jev";
import { AnalysisResults } from "./analysis-results";
import { Icon } from "./icons";
type Summary = {
  id: string;
  sql: string;
  estimatedCost: number | null;
  actual: boolean;
};
type Plan = {
  id: string;
  name: string;
  bytes: number;
  count: number;
  recommended: string;
  statements: Summary[];
};
const stages: Record<string, string> = {
  digesting: "Reading the evidence",
  proposing: "Your analyst is exploring remedies",
  judging: "Jev is evaluating the best action",
};
export function Runner() {
  const router = useRouter();
  const [mode, setMode] = useState<"upload" | "paste">("upload"),
    [xml, setXml] = useState(""),
    [note, setNote] = useState(""),
    [plan, setPlan] = useState<Plan | null>(null),
    [statement, setStatement] = useState(""),
    [page, setPage] = useState(0);
  const [stage, setStage] = useState<string | null>(null),
    [error, setError] = useState(""),
    [drag, setDrag] = useState(false),
    [digest, setDigest] = useState<Digest | null>(null),
    [candidates, setCandidates] = useState<Candidate[]>([]),
    [verdict, setVerdict] = useState<Verdict | null>(null),
    [id, setId] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const reset = () => {
      abort.current?.abort();
      setStage(null);
      setPlan(null);
      setStatement("");
      setXml("");
      setNote("");
      setDigest(null);
      setCandidates([]);
      setVerdict(null);
      setId(undefined);
      setError("");
    };
    window.addEventListener("qai-new-analysis", reset);
    return () => {
      abort.current?.abort();
      window.removeEventListener("qai-new-analysis", reset);
    };
  }, []);
  async function upload(file: File | Blob, name = "Pasted plan") {
    if (file.size > 100_000_000) {
      setError(
        "Plan exceeds the 100 MB limit. Split the batch or export a smaller plan.",
      );
      return;
    }
    setError("");
    setStage("uploading");
    setPlan(null);
    setDigest(null);
    setCandidates([]);
    setVerdict(null);
    setId(undefined);
    setPage(0);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const r = await fetch("/api/plans", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-plan-name": encodeURIComponent(name),
        },
        body: file,
        signal: ac.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPlan(data);
      setStatement(data.recommended);
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      setStage(null);
    }
  }
  async function paginate(next: number) {
    if (!plan) return;
    setError("");
    try {
      const r = await fetch(`/api/plans/${plan.id}?page=${next}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPlan({ ...plan, statements: data.statements });
      setPage(data.page);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function run() {
    if (!plan) return;
    setError("");
    setStage("digesting");
    setCandidates([]);
    setVerdict(null);
    setDigest(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, statementId: statement, note }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body)
        throw new Error((await r.json()).error ?? "Analysis failed.");
      let complete = false;
      for await (const e of readSse(r.body)) {
        if (e.event === "created") setId(e.data.id);
        if (e.event === "stage") setStage(e.data.stage);
        if (e.event === "digest") setDigest(e.data);
        if (e.event === "candidates") setCandidates(e.data);
        if (e.event === "verdict") setVerdict(e.data);
        if (e.event === "error") setError(e.data.message);
        if (e.event === "done") {
          complete = true;
          setStage(null);
          router.push(`/app/${e.data.id}`);
          router.refresh();
        }
      }
      if (!complete && !ac.signal.aborted)
        throw new Error(
          "The connection ended before analysis completed. Check the saved analysis in history.",
        );
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      setStage(null);
    }
  }
  function cancel() {
    abort.current?.abort();
    setStage(null);
    setError("Stopped. You can retry when ready.");
    router.refresh();
  }
  return (
    <div className="analysis-workspace">
      <section className="welcome">
        <div className="welcome-brand">
          <Image
            src="/brand/logo.png"
            alt="SQL Server Query AI — Analyze, troubleshoot, optimize"
            width={190}
            height={190}
            priority
          />
        </div>
        <h1>A clearer path to a faster query.</h1>
        <p>
          Bring your execution plan. Explore the possibilities.
          <br className="desktop-only" /> Let Jev help you choose the next move.
        </p>
      </section>
      <section className="composer">
        <div
          className="composer-tabs"
          role="group"
          aria-label="Plan input method"
        >
          <button
            className={mode === "upload" ? "active" : ""}
            onClick={() => setMode("upload")}
            disabled={!!stage}
          >
            <Icon name="upload" size={17} />
            Upload a plan
          </button>
          <button
            className={mode === "paste" ? "active" : ""}
            onClick={() => setMode("paste")}
            disabled={!!stage}
          >
            Paste XML
          </button>
          <span>SQL Server ShowPlan</span>
        </div>
        {mode === "upload" ? (
          <div
            className={`dropzone ${drag ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f && !stage) void upload(f, f.name);
            }}
          >
            <div className="upload-symbol">
              <Icon name="upload" size={25} />
            </div>
            <strong>
              {plan ? plan.name : "Drop your execution plan here"}
            </strong>
            <p>
              {plan
                ? `${(plan.bytes / 1e6).toFixed(2)} MB · ${plan.count} statement${plan.count === 1 ? "" : "s"} found`
                : ".sqlplan or .xml · Actual or estimated · Up to 100 MB"}
            </p>
            <button
              className="btn"
              onClick={() => input.current?.click()}
              disabled={!!stage}
            >
              {plan ? "Choose another file" : "Browse files"}
            </button>
            <input
              ref={input}
              className="sr-only"
              type="file"
              accept=".sqlplan,.xml"
              aria-label="Load a .sqlplan file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f, f.name);
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <div className="paste-area">
            <label htmlFor="xml">ShowPlan XML</label>
            <textarea
              className="field"
              id="xml"
              rows={7}
              value={xml}
              onChange={(e) => setXml(e.target.value)}
              spellCheck={false}
              placeholder="<ShowPlanXML …>"
              disabled={!!stage}
            />
            <button
              className="btn"
              onClick={() => upload(new Blob([xml]))}
              disabled={!!stage || !xml.trim()}
            >
              Read statements
            </button>
          </div>
        )}
        {plan && (
          <div className="statement-picker">
            <div className="section-title">
              <label htmlFor="statement">Choose a statement</label>
              <span className="muted">Highest estimated cost suggested</span>
            </div>
            <select
              id="statement"
              className="field"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              disabled={!!stage}
            >
              {!plan.statements.some((s) => s.id === statement) && (
                <option value={statement}>
                  Selected statement {statement}
                </option>
              )}
              {plan.statements.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · Cost {s.estimatedCost ?? "unknown"} ·{" "}
                  {s.sql.slice(0, 150) || "Statement without SQL text"}
                  {s.id === plan.recommended ? " · Suggested" : ""}
                </option>
              ))}
            </select>
            {plan.count > 50 && (
              <div className="pagination">
                <button
                  className="btn"
                  onClick={() => paginate(page - 1)}
                  disabled={!page || !!stage}
                >
                  Previous
                </button>
                <span>
                  Page {page + 1} of {Math.ceil(plan.count / 50)}
                </span>
                <button
                  className="btn"
                  onClick={() => paginate(page + 1)}
                  disabled={(page + 1) * 50 >= plan.count || !!stage}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
        <div className="composer-bottom">
          <label htmlFor="note">
            Add context <span className="muted">optional</span>
          </label>
          <textarea
            id="note"
            className="context-input"
            rows={2}
            maxLength={2000}
            placeholder="What changed? What is slow? Any constraints on making changes?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={!!stage}
          />
          <div className="composer-actions">
            <span>
              <Icon name="shield" size={15} />
              Only bounded evidence is sent to your models
            </span>
            {stage ? (
              <button className="btn" onClick={cancel}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={run}
                disabled={!plan || !statement}
              >
                Analyse plan
                <Icon name="arrow" size={17} />
              </button>
            )}
          </div>
        </div>
      </section>
      {stage && (
        <div className="progress-status" role="status">
          <span className="spinner" />
          <div>
            <strong>
              {stage === "uploading"
                ? "Uploading and indexing your plan"
                : (stages[stage] ?? stage)}
            </strong>
            <small>
              {stage === "uploading"
                ? "Large plans may take a little longer."
                : "Your results appear here as they become available."}
            </small>
          </div>
        </div>
      )}
      {error && (
        <div className="notice danger-text" role="alert">
          {error}
        </div>
      )}
      {!digest && !stage && (
        <div className="workspace-guidance">
          <div>
            <Icon name="file" />
            <h3>Start with the evidence</h3>
            <p>Estimated or actual plans, even complex batches.</p>
          </div>
          <div>
            <Icon name="chart" />
            <h3>Compare real alternatives</h3>
            <p>Distinct remedies with steps and validation.</p>
          </div>
          <div>
            <Icon name="shield" />
            <h3>A considered next step</h3>
            <p>Jev evaluates fit, safety, and operational effort.</p>
          </div>
        </div>
      )}
      <details className="help-details">
        <summary>Where do I get an execution plan?</summary>
        <p>
          In SSMS, enable Include Actual Execution Plan (Ctrl+M), run your
          query, then right-click the Execution Plan tab and select Save
          Execution Plan As. You can also export an estimated plan or paste
          ShowPlan XML from SET STATISTICS XML ON. Plain SQL and screenshots are
          not execution plans.
        </p>
      </details>
      {(digest || candidates.length > 0) && (
        <AnalysisResults
          key={id ?? "new"}
          digest={digest}
          candidates={candidates}
          verdict={verdict}
          id={id}
        />
      )}
    </div>
  );
}
