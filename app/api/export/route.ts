import { requireUser } from "@/lib/auth";
import { exportAnalyses } from "@/lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Every analysis the user owns, as one JSON download. Stored JSON columns are parsed so the file reads cleanly.
export async function GET() {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parse = (v: unknown) => {
    try {
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return v;
    }
  };
  const analyses = exportAnalyses(u.id).map((a) => ({
    ...a,
    created_at: new Date(Number(a.created_at)).toISOString(),
    digest: parse(a.digest),
    candidates: parse(a.candidates),
    verdict: parse(a.verdict),
    comparison: parse(a.comparison),
  }));
  const date = new Date().toISOString().slice(0, 10);
  return new Response(
    JSON.stringify(
      { exported_at: new Date().toISOString(), analyses },
      null,
      2,
    ),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="sql-server-query-ai-${date}.json"`,
        "cache-control": "no-store",
      },
    },
  );
}
