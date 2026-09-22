import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAnalysis } from "@/lib/db";
import { ReportView } from "@/components/report-view";
import { ExportButtons } from "@/components/export-buttons";
import { AnalysisResults } from "@/components/analysis-results";

export default async function Stored({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const u = await requireUser();
  const a = getAnalysis((await params).id, u.id);
  if (!a) notFound();
  // Never redirect here: a row left "running" by a crashed process would bounce this page to itself forever.
  const interrupted = a.status === "running";
  const modern = a.digest && JSON.parse(a.digest).version === 2;
  return (
    <section style={{ display: "grid", gap: "var(--qai-space-xl)" }}>
      <h1
        style={{
          fontFamily: "var(--qai-font-display)",
          fontSize: "var(--qai-text-2xl)",
          margin: 0,
        }}
      >
        {a.title}
      </h1>
      {interrupted && (
        <p role="alert" style={{ color: "var(--qai-warn)" }}>
          This run was interrupted before it finished — what is below is
          everything it managed to produce.
        </p>
      )}
      {a.error && (
        <p role="alert" style={{ color: "var(--qai-danger)" }}>
          {a.error}
        </p>
      )}
      {modern && (
        <AnalysisResults
          id={a.id}
          digest={JSON.parse(a.digest!)}
          candidates={a.candidates ? JSON.parse(a.candidates) : []}
          verdict={a.verdict ? JSON.parse(a.verdict) : null}
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
