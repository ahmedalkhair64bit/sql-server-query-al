import { requireUser } from "@/lib/auth";
import { getSettings, setModelStatus } from "@/lib/db";
import { open } from "@/lib/vault";
import { extraFromForm, jevModel } from "@/lib/settings";
import { testAnalyst, testJev } from "@/lib/connection";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tests the values currently in the form (unsaved edits included); a blank key means the saved key.
// The result is stored only when it describes the saved settings, so the status card never vouches for
// something that was not saved.
export async function POST(req: Request) {
  const u = await requireUser().catch(() => null);
  if (!u) return Response.json({ error: "Sign in first." }, { status: 401 });
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return Response.json(
      { error: "Expected the settings form." },
      { status: 400 },
    );
  }
  const s = getSettings(u.id);
  const v = (k: string) => String(fd.get(k) ?? "").trim();
  const target = v("target");
  if (target === "analyst") {
    let extra: Record<string, unknown>;
    try {
      extra = extraFromForm(fd);
    } catch (e) {
      return Response.json({ ok: false, message: (e as Error).message });
    }
    const cfg = {
      baseUrl: v("analyst_base_url").replace(/\/+$/, ""),
      apiKey: v("analyst_key") || open(s?.analyst_key ?? ""),
      model: v("analyst_model"),
      extra,
    };
    const missing = [
      !cfg.baseUrl && "base URL",
      !cfg.apiKey && "API key",
      !cfg.model && "model name",
    ].filter(Boolean);
    if (missing.length)
      return Response.json({
        ok: false,
        message: `Enter the ${missing.join(", ")} first.`,
      });
    if (!/^https?:\/\//i.test(cfg.baseUrl))
      return Response.json({
        ok: false,
        message: "The base URL must start with http:// or https://.",
      });
    const status = await testAnalyst(cfg);
    const saved =
      s &&
      s.analyst_base_url === cfg.baseUrl &&
      s.analyst_model === cfg.model &&
      open(s.analyst_key) === cfg.apiKey &&
      s.analyst_extra === JSON.stringify(extra);
    if (saved) setModelStatus(u.id, "analyst", JSON.stringify(status));
    return Response.json({ ...status, saved: !!saved });
  }
  if (target === "jev") {
    const key = v("jev_key") || open(s?.jev_key ?? "");
    const model = v("jev_model") || "jev-latest";
    if (!key)
      return Response.json({
        ok: false,
        message: "Enter the TypeSafe API key first.",
      });
    const status = await testJev(key, model);
    const saved = s && open(s.jev_key) === key && jevModel(u.id) === model;
    if (saved) setModelStatus(u.id, "jev", JSON.stringify(status));
    return Response.json({ ...status, saved: !!saved });
  }
  return Response.json({ error: "Unknown target." }, { status: 400 });
}
