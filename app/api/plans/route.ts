import { requireUser } from "@/lib/auth";
import { ingestPlan, MAX_PLAN_BYTES } from "@/lib/server/plans";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const user = await requireUser().catch(() => null);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (Number(req.headers.get("content-length")) > MAX_PLAN_BYTES)
    return Response.json(
      { error: "Plan exceeds the 100 MB limit." },
      { status: 413 },
    );
  if (!req.body)
    return Response.json({ error: "Empty upload." }, { status: 400 });
  try {
    return Response.json(
      await ingestPlan(
        req.body,
        user.id,
        decodeURIComponent(req.headers.get("x-plan-name") ?? "Pasted plan"),
        req.signal,
      ),
    );
  } catch (e) {
    const error = (e as Error).message;
    return Response.json(
      { error },
      {
        status: error.includes("100 MB")
          ? 413
          : error.includes("Two uploads")
            ? 429
            : 400,
      },
    );
  }
}
