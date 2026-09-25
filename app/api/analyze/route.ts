import { requireUser } from "@/lib/auth";
import {
  analystConfig,
  jevKey,
  jevModel,
  digestForModels,
} from "@/lib/settings";
import { proposeCandidates } from "@/lib/analyst";
import { judgeCandidates, jevFallback, makeJevClient } from "@/lib/jev";
import { sse } from "@/lib/stream";
import { newAnalysis, patchAnalysis } from "@/lib/db";
import {
  ingestPlan,
  ownedPlan,
  statementDigest,
  attachPlan,
} from "@/lib/server/plans";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  const analyst = analystConfig(u.id),
    jev = jevKey(u.id);
  if (!analyst || !jev)
    return Response.json(
      { error: "Configure the analyst and Jev in Settings first." },
      { status: 412 },
    );
  let body: {
    planId?: string;
    statementId?: string;
    xml?: string;
    note?: string;
  };
  try {
    const reader = req.body?.getReader();
    if (!reader) throw new Error("Empty request.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_000_000) {
        await reader.cancel();
        return Response.json(
          { error: "Use the upload endpoint for large plans." },
          { status: 413 },
        );
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return Response.json(
      { error: "Expected JSON with a planId and statementId, or xml." },
      { status: 400 },
    );
  }
  let planId = body.planId,
    statementId = body.statementId;
  try {
    if (!planId && typeof body.xml === "string") {
      const plan = await ingestPlan(
        new Blob([body.xml]).stream(),
        u.id,
        "Pasted plan",
        req.signal,
      );
      planId = plan.id;
      statementId = plan.recommended;
    }
    if (!planId || !ownedPlan(planId, u.id))
      return Response.json({ error: "Plan not found." }, { status: 404 });
    if (!statementId)
      return Response.json(
        { error: "Select a statement first." },
        { status: 400 },
      );
    const digest = await statementDigest(planId, statementId);
    const note = String(body.note ?? "").slice(0, 2000);
    const id = newAnalysis(
      u.id,
      note.trim().slice(0, 120) || digest.sql.slice(0, 100) || "Plan analysis",
      "",
    );
    attachPlan(id, planId, statementId);
    patchAnalysis(id, { digest: JSON.stringify(digest), note });
    const ac = new AbortController();
    let abandoned = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const send = (event: string, data: unknown) => {
          if (!abandoned)
            ctrl.enqueue(new TextEncoder().encode(sse(event, data)));
        };
        try {
          send("created", { id });
          send("stage", { stage: "digesting" });
          // The page renders the stored digest (operators, warnings); the model gets digestForModel.
          send("digest", digest);
          send("stage", { stage: "proposing" });
          // The privacy setting can withhold the statement text from both models.
          const modelDigest = digestForModels(u.id, digest);
          const candidates = await proposeCandidates(
            analyst,
            modelDigest,
            note,
            fetch,
            ac.signal,
          );
          patchAnalysis(id, { candidates: JSON.stringify(candidates) });
          send("candidates", candidates);
          if (abandoned) return;
          send("stage", { stage: "judging" });
          let verdict;
          try {
            verdict = await judgeCandidates(
              modelDigest,
              candidates,
              makeJevClient(jev, jevModel(u.id)),
              ac.signal,
              note,
            );
          } catch {
            verdict = jevFallback(
              candidates,
              "Jev could not be reached. Retry the decision when the service is available.",
            );
          }
          if (abandoned) return;
          patchAnalysis(id, {
            verdict: JSON.stringify(verdict),
            status: "done",
          });
          send("verdict", verdict);
          send("done", { id });
        } catch (e) {
          const message = abandoned
            ? "Analysis cancelled."
            : (e as Error).message;
          patchAnalysis(id, {
            status: abandoned ? "abandoned" : "failed",
            error: message,
          });
          send("error", { stage: "analysis", message });
          send("done", { id });
        } finally {
          if (!abandoned) ctrl.close();
        }
      },
      cancel() {
        abandoned = true;
        ac.abort();
        patchAnalysis(id, {
          status: "abandoned",
          error: "Stopped before the analysis completed.",
        });
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
