import { requireUser } from "@/lib/auth";
import { ownedPlan, listStatements } from "@/lib/server/plans";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  const plan = ownedPlan(id, user.id);
  if (!plan)
    return Response.json({ error: "Plan not found." }, { status: 404 });
  const page = Math.max(
    0,
    Math.min(
      Math.ceil(plan.count / 50) - 1,
      Number(new URL(req.url).searchParams.get("page")) || 0,
    ),
  );
  return Response.json({
    id,
    count: plan.count,
    recommended: plan.recommended,
    page,
    statements: await listStatements(id, page),
  });
}
