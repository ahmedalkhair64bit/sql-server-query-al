"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PipelineProgress } from "./pipeline-progress";

/** A run still going on the server: its progress, refreshed until it finishes, and an explicit Stop. */
export function LiveRun({
  id,
  stage,
  startedAt,
}: {
  id: string;
  stage: string;
  startedAt: number;
}) {
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [router]);
  async function stop() {
    setStopping(true);
    await fetch(`/api/analyses/${id}/stop`, { method: "POST" }).catch(
      () => null,
    );
    router.refresh();
  }
  return (
    <div className="live-run">
      <PipelineProgress stage={stage} startedAt={startedAt} />
      <p className="live-run-note">
        This analysis keeps running on the server. You can open other pages and
        come back; the report fills in when it finishes.
      </p>
      <div className="live-run-actions no-print">
        <button className="btn" onClick={stop} disabled={stopping}>
          {stopping ? "Stopping…" : "Stop analysis"}
        </button>
      </div>
    </div>
  );
}

/** Runs a finished, stopped or interrupted analysis again from its stored evidence: no upload needed. */
export function RunAgain({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function again() {
    setBusy(true);
    setError("");
    const r = await fetch(`/api/analyses/${id}/rerun`, { method: "POST" });
    if (!r.ok)
      setError(
        ((await r.json().catch(() => ({}))) as { error?: string }).error ??
          "Could not start the analysis.",
      );
    setBusy(false);
    router.refresh();
  }
  return (
    <div className="run-again no-print">
      <button className="btn btn-primary" onClick={again} disabled={busy}>
        {busy ? "Starting…" : "Run again"}
      </button>
      <span className="muted">Uses the same plan and context note.</span>
      {error && (
        <p role="alert" className="report-alert danger">
          {error}
        </p>
      )}
    </div>
  );
}
