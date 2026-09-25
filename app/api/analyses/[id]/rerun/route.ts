import { requireUser } from "@/lib/auth";
import { getAnalysis, patchAnalysis } from "@/lib/db";
import { analystConfig, jevKey } from "@/lib/settings";
import {
  startAnalysis,
  runningJob,
  runningCount,
  MAX_RUNNING_PER_USER,
} from "@/lib/server/jobs";

// Runs an analysis again from what it stored (the statement's evidence and the note): no upload needed.
// Used after a stop, a failure, a restart that interrupted it, or a change of model in Settings.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  const a = getAnalysis(id, u.id);
  if (!a)
    return Response.json({ error: "Analysis not found." }, { status: 404 });
  if (!a.digest || JSON.parse(a.digest).version !== 2)
    return Response.json(
      {
        error:
          "This analysis has no stored plan evidence. Upload the plan again.",
      },
      { status: 409 },
    );
  if (runningJob(id))
    return Response.json({ error: "It is already running." }, { status: 409 });
  if (!analystConfig(u.id) || !jevKey(u.id))
    return Response.json(
      { error: "Configure the analyst and Jev in Settings first." },
      { status: 412 },
    );
  if (runningCount(u.id) >= MAX_RUNNING_PER_USER)
    return Response.json(
      {
        error: `You already have ${MAX_RUNNING_PER_USER} analyses running. Wait for one to finish.`,
      },
      { status: 429 },
    );
  patchAnalysis(id, { candidates: "", verdict: "", comparison: "" });
  startAnalysis({
    id,
    userId: u.id,
    digest: JSON.parse(a.digest),
    note: a.note ?? "",
  });
  return Response.json({ running: true });
}
