import { requireUser } from "@/lib/auth";
import { getAnalysis, patchAnalysis } from "@/lib/db";
import { compareDigests } from "@/lib/compare.mjs";
import {
  ownedPlan,
  statementByHash,
  statementDigest,
} from "@/lib/server/plans";
import type { Digest } from "@/lib/digest";
export const runtime = "nodejs";
// Compare the analysed statement with the same statement from an "after" plan the user uploaded.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  const a = getAnalysis(id, u.id);
  if (!a)
    return Response.json({ error: "Analysis not found." }, { status: 404 });
  if (!a.digest)
    return Response.json(
      { error: "This analysis has no stored plan evidence to compare with." },
      { status: 409 },
    );
  let body: { planId?: string; statementId?: string; appliedKey?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Expected JSON with a planId." },
      { status: 400 },
    );
  }
  const plan = body.planId ? ownedPlan(body.planId, u.id) : null;
  if (!plan)
    return Response.json({ error: "Plan not found." }, { status: 404 });
  const before = JSON.parse(a.digest) as Digest;
  try {
    // Same query hash first (the statement did not move), then the user's choice, then the costliest.
    const statementId =
      body.statementId ??
      (before.queryHash
        ? await statementByHash(plan.id, before.queryHash)
        : null) ??
      plan.recommended;
    const after = await statementDigest(plan.id, statementId);
    const candidates = a.candidates ? JSON.parse(a.candidates) : [];
    const appliedKey = candidates.some(
      (c: { key: string }) => c.key === body.appliedKey,
    )
      ? body.appliedKey
      : null;
    const comparison = {
      ...compareDigests(before, after),
      appliedKey,
      afterPlan: plan.name,
      afterStatement: statementId,
      at: Date.now(),
    };
    patchAnalysis(id, { comparison: JSON.stringify(comparison) });
    return Response.json(comparison);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
