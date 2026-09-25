import { requireUser } from "@/lib/auth";
import { analystConfig, jevKey } from "@/lib/settings";
import { sse } from "@/lib/stream";
import { newAnalysis, patchAnalysis } from "@/lib/db";
import {
  ingestPlan,
  ownedPlan,
  statementDigest,
  attachPlan,
} from "@/lib/server/plans";
import {
  startAnalysis,
  runningCount,
  MAX_RUNNING_PER_USER,
} from "@/lib/server/jobs";
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
    if (runningCount(u.id) >= MAX_RUNNING_PER_USER)
      return Response.json(
        {
          error: `You already have ${MAX_RUNNING_PER_USER} analyses running. Wait for one to finish.`,
        },
        { status: 429 },
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
    // The run belongs to the server. This response only watches it: closing the page stops the watching,
    // never the analysis (use /api/analyses/[id]/stop for that).
    let watching = true;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (event: string, data: unknown) => {
          if (!watching) return;
          ctrl.enqueue(new TextEncoder().encode(sse(event, data)));
          if (event === "done") {
            watching = false;
            ctrl.close();
          }
        };
        send("created", { id });
        startAnalysis({ id, userId: u.id, digest, note }, send);
      },
      cancel() {
        watching = false;
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
