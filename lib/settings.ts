import { getSettings, saveSettings, type SettingsInput } from "./db.ts";
import { seal, open, mask } from "./vault.ts";

export type AnalystConfig = { baseUrl: string; apiKey: string; model: string; extra: Record<string, unknown> };
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const kept = (fd: FormData, k: string, existing: string) => { const v = str(fd, k); return v ? seal(v) : existing; };

export function saveSettingsForm(userId: string, fd: FormData, onboarded = 1) {
  const cur = getSettings(userId);
  let extra = str(fd, "analyst_extra") || "{}";
  try { JSON.parse(extra); } catch { extra = "{}"; }
  saveSettings(userId, {
    analyst_base_url: str(fd, "analyst_base_url").replace(/\/+$/, ""),
    analyst_key: kept(fd, "analyst_key", cur?.analyst_key ?? ""),
    analyst_model: str(fd, "analyst_model"),
    analyst_extra: extra,
    jev_key: kept(fd, "jev_key", cur?.jev_key ?? ""),
    jev_model: str(fd, "jev_model") || "jev-latest",
    onboarded: cur?.onboarded === 1 ? 1 : onboarded,
  } satisfies SettingsInput);
}
export function analystConfig(userId: string): AnalystConfig | null {
  const s = getSettings(userId);
  const baseUrl = s?.analyst_base_url ?? "";
  const apiKey = open(s?.analyst_key ?? "");
  const model = s?.analyst_model ?? "";
  if (!baseUrl || !apiKey || !model) return null;
  let extra: Record<string, unknown> = {};
  try { extra = JSON.parse(s!.analyst_extra) as Record<string, unknown>; } catch { /* bad JSON means no extra params */ }
  return { baseUrl, apiKey, model, extra };
}
export const jevKey = (userId: string) => open(getSettings(userId)?.jev_key ?? "");
export const jevModel = (userId: string) => getSettings(userId)?.jev_model || "jev-latest";
export function settingsView(userId: string) {
  const s = getSettings(userId);
  const analystKey = open(s?.analyst_key ?? "");
  const jev = open(s?.jev_key ?? "");
  return {
    analyst_base_url: s?.analyst_base_url ?? "", analyst_model: s?.analyst_model ?? "",
    analyst_extra: s?.analyst_extra ?? "{}", jev_model: s?.jev_model ?? "jev-latest",
    analyst_key_masked: mask(analystKey), jev_key_masked: mask(jev),
    has_analyst: !!(s?.analyst_base_url && s?.analyst_model && analystKey), has_jev: !!jev,
  };
}
export type SettingsView = ReturnType<typeof settingsView>;
