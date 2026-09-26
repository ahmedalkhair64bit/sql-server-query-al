"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readSse } from "@/lib/stream";
import type { Candidate } from "@/lib/analyst";
import type { Digest } from "@/lib/digest";
import type { Verdict } from "@/lib/jev";
import { AnalysisResults } from "./analysis-results";
import { Icon } from "./icons";
import { PipelineProgress } from "./pipeline-progress";
import { parseContext } from "@/lib/schema-context.mjs";
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
const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : word.endsWith("x") ? "es" : "s"}`;
const contextSummary = (c: { tables: { indexes: unknown[] }[] }) =>
  `Read ${plural(c.tables.length, "table")} and ${plural(
    c.tables.reduce((n, t) => n + t.indexes.length, 0),
    "index",
  )}. Suggested indexes are checked against them.`;
export function Runner() {
  const router = useRouter();
  const [mode, setMode] = useState<"upload" | "paste">("upload"),
    [xml, setXml] = useState(""),
    [note, setNote] = useState(""),
    [plan, setPlan] = useState<Plan | null>(null),
    [statement, setStatement] = useState(""),
    [page, setPage] = useState(0),
    [context, setContext] = useState(""),
    [contextSql, setContextSql] = useState(""),
    [contextNote, setContextNote] = useState("");
  const [stage, setStage] = useState<string | null>(null),
    [error, setError] = useState(""),
    [drag, setDrag] = useState(false),
    [digest, setDigest] = useState<Digest | null>(null),
    [candidates, setCandidates] = useState<Candidate[]>([]),
    [verdict, setVerdict] = useState<Verdict | null>(null),
    [id, setId] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Onboarding ends with "Analyse the sample plan": /app?sample=1 loads the bundled plan ready to run.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("sample") !== "1")
      return;
    window.history.replaceState(null, "", "/app");
    void fetch("/samples/key-lookup.sqlplan")
      .then((r) => r.blob())
      .then(async (b) => {
        await upload(b, "Sample plan: key lookup");
        setNote(
          "Sample plan from onboarding: a key lookup executed 60,000 times.",
        );
      })
      .catch(() => setError("The sample plan could not be loaded."));
  }, []);
  useEffect(() => {
    const reset = () => {
      abort.current?.abort();
      setStage(null);
      setPlan(null);
      setStatement("");
      setXml("");
      setNote("");
      setContext("");
      setContextSql("");
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
    setContext("");
    setContextSql("");
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
      if (ac.signal.aborted) return;
      // The server refuses a third concurrent upload without reading its body, so the browser can see
      // the connection close ("Failed to fetch") instead of the 429 answer.
      setError(
        e instanceof TypeError
          ? "The upload was cut off. The server may be busy with two other uploads, or the connection dropped. Try again in a moment."
          : (e as Error).message,
      );
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
        body: JSON.stringify({
          planId: plan.id,
          statementId: statement,
          note,
          ...(context.trim() ? { context } : {}),
        }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body)
        throw new Error((await r.json()).error ?? "Analysis failed.");
      let complete = false;
      let created: string | undefined;
      for await (const e of readSse(r.body)) {
        if (e.event === "created") {
          created = e.data.id;
          setId(created);
          router.refresh(); // show it in history now: it keeps running if you leave this page
        }
        if (e.event === "stage") setStage(e.data.stage);
        if (e.event === "digest") setDigest(e.data);
        if (e.event === "candidates") setCandidates(e.data);
        if (e.event === "verdict") setVerdict(e.data);
        if (e.event === "error") setError(e.data.message);
        if (e.event === "done") {
          complete = true;
          setStage(null);
          router.push(`/app/${e.data.id}${e.data.reused ? "?reused=1" : ""}`);
          router.refresh();
        }
      }
      // The run continues on the server; if only this connection dropped, follow it on its report page.
      if (!complete && !ac.signal.aborted && created) {
        router.push(`/app/${created}`);
        return;
      }
      if (!complete && !ac.signal.aborted)
        throw new Error("The connection ended before the analysis started.");
    } catch (e) {
      if (ac.signal.aborted) return;
      // The server refuses a third concurrent upload without reading its body, so the browser can see
      // the connection close ("Failed to fetch") instead of the 429 answer.
      setError(
        e instanceof TypeError
          ? "The upload was cut off. The server may be busy with two other uploads, or the connection dropped. Try again in a moment."
          : (e as Error).message,
      );
    } finally {
      setStage(null);
    }
  }
  // The read-only query that lists the existing indexes of the statement's tables. Its result, pasted
  // back, keeps an index suggestion from duplicating an index the table already has.
  async function copyContextQuery() {
    if (!plan) return;
    setContextNote("");
    try {
      const r = await fetch(
        `/api/plans/${plan.id}/context-query?statement=${encodeURIComponent(statement)}`,
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setContextSql(data.sql);
      await navigator.clipboard?.writeText(data.sql).then(
        () => setContextNote("Query copied. Run it in the plan's database."),
        () => setContextNote("Select the query below and copy it."),
      );
    } catch (e) {
      setContextNote((e as Error).message);
    }
  }
  const contextTables = context.trim() ? parseContext(context) : null;
  // Stop asks the server to stop the run; its report then says so and offers Run again. Leaving the page
  // does not stop anything.
  async function cancel() {
    if (id) {
      await fetch(`/api/analyses/${id}/stop`, { method: "POST" }).catch(
        () => null,
      );
      return; // the stream ends with the stopped result and opens its report
    }
    abort.current?.abort();
    setStage(null);
    setError("Stopped. You can retry when ready.");
    router.refresh();
  }
  return (
    <div className="analysis-workspace">
      <section className="welcome">
        <h1>A clearer path to a faster query.</h1>
        <p>
          Upload an execution plan. The analyst proposes distinct fixes, and Jev
          picks the one to run first.
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
            <details className="help-details context-details">
              <summary>
                Existing indexes <span className="muted">optional</span>
              </summary>
              <p>
                A plan does not list the keys of the indexes a table already
                has. Run this read-only query (system views only) in the
                plan&apos;s database and paste its result, so a suggested index
                extends an existing one instead of duplicating it.
              </p>
              <button
                className="btn"
                type="button"
                onClick={copyContextQuery}
                disabled={!!stage || !statement}
              >
                Copy query
              </button>
              {contextNote && <p className="muted">{contextNote}</p>}
              {contextSql && (
                <textarea
                  className="field"
                  rows={4}
                  readOnly
                  value={contextSql}
                  aria-label="Existing indexes query"
                  spellCheck={false}
                />
              )}
              <label htmlFor="context">Query result</label>
              <textarea
                id="context"
                className="field"
                rows={3}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder='[{"schema":"dbo","table":"Orders","rows":…,"indexes":[…]}]'
                spellCheck={false}
                disabled={!!stage}
              />
              {context.trim() && (
                <p
                  className={contextTables ? "muted" : "danger-text"}
                  role="status"
                >
                  {contextTables
                    ? contextSummary(contextTables)
                    : "Not recognised: paste the single JSON value the query returns."}
                </p>
              )}
            </details>
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
        <PipelineProgress
          key={stage === "uploading" ? "upload" : "run"}
          stage={stage}
        />
      )}
      {error && (
        <div className="notice danger-text" role="alert">
          {error}
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
