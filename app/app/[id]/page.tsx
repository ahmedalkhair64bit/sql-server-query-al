import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAnalysis } from "@/lib/db";
import { ReportView } from "@/components/report-view";
import { ExportButtons } from "@/components/export-buttons";
import { AnalysisResults } from "@/components/analysis-results";
import { LiveRun, RunAgain } from "@/components/live-run";
import { runningJob } from "@/lib/server/jobs";

export default async function Stored({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reused?: string }>;
}) {
  const u = await requireUser();
  const a = getAnalysis((await params).id, u.id);
  if (!a) notFound();
  // Never redirect here: a row left "running" by a restarted process would bounce this page forever.
  // A run lives in this process: "running" with no job means a restart interrupted it.
  const job = a.status === "running" ? runningJob(a.id) : null;
  const interrupted = a.status === "running" && !job;
  const reused = (await searchParams).reused === "1" && a.status === "done";
  const canRerun =
    !job &&
    a.status !== "done" &&
    !!a.digest &&
    JSON.parse(a.digest).version === 2;
  const modern = a.digest && JSON.parse(a.digest).version === 2;
  return (
    <section className="report-page">
      <h1 className="report-title" title={a.title}>
        {a.title}
      </h1>
      {job && <LiveRun id={a.id} stage={job.stage} startedAt={job.startedAt} />}
      {interrupted && (
        <p role="alert" className="report-alert warn">
          This run was interrupted before it finished (the server restarted).
          What is below is everything it managed to produce.
        </p>
      )}
      {a.error && !job && (
        <p role="alert" className="report-alert danger">
          {a.error}
        </p>
      )}
      {canRerun && <RunAgain id={a.id} />}
      {reused && (
        <div className="reused-note" role="status">
          <p>
            <strong>Same plan, same answer.</strong> This statement was already
            analysed with the same context note and models on{" "}
            {new Date(a.updated_at).toLocaleString("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            , so this is that result rather than a new call to the models.
          </p>
          <RunAgain
            id={a.id}
            label="Run again anyway"
            hint="Asks the models again; the result may differ."
          />
        </div>
      )}
      {modern && (
        <AnalysisResults
          id={a.id}
          digest={JSON.parse(a.digest!)}
          candidates={a.candidates ? JSON.parse(a.candidates) : []}
          verdict={a.verdict ? JSON.parse(a.verdict) : null}
          comparison={a.comparison ? JSON.parse(a.comparison) : null}
        />
      )}
      {!modern && a.verdict && (
        <AnalysisResults
          id={a.id}
          digest={a.digest ? JSON.parse(a.digest) : null}
          candidates={a.candidates ? JSON.parse(a.candidates) : []}
          verdict={JSON.parse(a.verdict)}
        />
      )}
      {!modern &&
        (a.oul ? (
          <>
            <ExportButtons oul={a.oul} title={a.title} />
            <ReportView oul={a.oul} streaming={false} />
          </>
        ) : (
          <p className="label">No narrative report was stored for this run.</p>
        ))}
    </section>
  );
}
