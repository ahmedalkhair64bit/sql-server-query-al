import { requireUser } from "@/lib/auth";
import { getAnalysis, patchAnalysis } from "@/lib/db";
import { jevKey, jevModel, digestForModels } from "@/lib/settings";
import { judgeCandidates, jevFallback, makeJevClient } from "@/lib/jev";
const pending = new Set<string>();
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params,
    a = getAnalysis(id, u.id);
  if (!a)
    return Response.json({ error: "Analysis not found." }, { status: 404 });
  if (!a.digest || !a.candidates || a.candidates === "[]")
    return Response.json(
      { error: "This analysis has no saved candidates to judge." },
      { status: 409 },
    );
  const key = jevKey(u.id);
  if (!key)
    return Response.json(
      { error: "Configure Jev in Settings." },
      { status: 412 },
    );
  if (pending.has(id))
    return Response.json(
      { error: "Jev is already reviewing this analysis." },
      { status: 409 },
    );
  pending.add(id);
  try {
    const candidates = JSON.parse(a.candidates);
    let verdict;
    try {
      verdict = await judgeCandidates(
        digestForModels(u.id, JSON.parse(a.digest)),
        candidates,
        makeJevClient(key, jevModel(u.id)),
        undefined,
        a.note ?? "",
      );
    } catch {
      verdict = jevFallback(
        candidates,
        "Jev could not be reached. Try again shortly.",
      );
    }
    patchAnalysis(id, { verdict: JSON.stringify(verdict) });
    return Response.json(verdict);
  } finally {
    pending.delete(id);
  }
}
