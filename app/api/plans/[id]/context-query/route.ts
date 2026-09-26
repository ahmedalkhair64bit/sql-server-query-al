import { requireUser } from "@/lib/auth";
import { ownedPlan, statementDigest } from "@/lib/server/plans";
import { contextQuery } from "@/lib/schema-context.mjs";

// The read-only query that lists the existing indexes of the tables in one statement of an uploaded plan.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  if (!ownedPlan(id, user.id))
    return Response.json({ error: "Plan not found." }, { status: 404 });
  const statement = new URL(req.url).searchParams.get("statement");
  if (!statement)
    return Response.json(
      { error: "Select a statement first." },
      { status: 400 },
    );
  const digest = await statementDigest(id, statement).catch(() => null);
  if (!digest)
    return Response.json({ error: "Statement not found." }, { status: 404 });
  const sql = contextQuery(digest.tables);
  return sql
    ? Response.json({ sql, tables: digest.tables })
    : Response.json(
        { error: "This statement reads no permanent tables." },
        { status: 409 },
      );
}
