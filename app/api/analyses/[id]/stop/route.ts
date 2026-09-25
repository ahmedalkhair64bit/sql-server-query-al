import { requireUser } from "@/lib/auth";
import { getAnalysis } from "@/lib/db";
import { stopAnalysis } from "@/lib/server/jobs";

// Stopping is explicit: leaving the page never stops a run.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  if (!getAnalysis(id, u.id))
    return Response.json({ error: "Analysis not found." }, { status: 404 });
  return stopAnalysis(id, u.id)
    ? Response.json({ stopping: true })
    : Response.json(
        { error: "This analysis is not running." },
        { status: 409 },
      );
}
