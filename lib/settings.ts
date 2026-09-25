import {
  getSettings,
  saveSettings,
  setSendSql,
  type SettingsInput,
} from "./db.ts";
import { seal, open, mask } from "./vault.ts";
import { providerFor } from "./providers.ts";
import type { ConnectionStatus } from "./connection.ts";
import type { Digest } from "./digest.ts";

export type AnalystConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  extra: Record<string, unknown>;
};
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const kept = (fd: FormData, k: string, existing: string) => {
  const v = str(fd, k);
  return v ? seal(v) : existing;
};

/**
 * The analyst's extra request params, assembled from the form: the raw JSON (Advanced), plus the two
 * settings people actually need, which override it. Throws with a readable message on bad JSON.
 */
export function extraFromForm(fd: FormData): Record<string, unknown> {
  const raw = str(fd, "analyst_extra") || "{}";
  let extra: Record<string, unknown>;
  try {
    extra = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Advanced request params are not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra))
    throw new Error(
      'Advanced request params must be a JSON object, e.g. {"temperature":0.2}.',
    );
  // Reasoning models served by vLLM/SGLang stream their thinking instead of the answer unless told not to.
  const kwargs = {
    ...((extra.chat_template_kwargs as Record<string, unknown>) ?? {}),
  };
  if (fd.get("thinking_off") === "on") kwargs.enable_thinking = false;
  else delete kwargs.enable_thinking;
  if (Object.keys(kwargs).length) extra.chat_template_kwargs = kwargs;
  else delete extra.chat_template_kwargs;
  const max = str(fd, "max_tokens");
  if (max) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 256 || n > 200000)
      throw new Error(
        "Maximum response length must be a whole number between 256 and 200,000 tokens.",
      );
    extra.max_tokens = n;
  } else delete extra.max_tokens;
  return extra;
}

/** Split stored extra params back into the form's fields. */
export function extraForForm(json: string) {
  let extra: Record<string, unknown> = {};
  try {
    extra = JSON.parse(json || "{}");
  } catch {
    /* shown as {} */
  }
  const kwargs = {
    ...((extra.chat_template_kwargs as Record<string, unknown>) ?? {}),
  };
  const thinkingOff = kwargs.enable_thinking === false;
  delete kwargs.enable_thinking;
  const rest: Record<string, unknown> = { ...extra };
  delete rest.max_tokens;
  if (Object.keys(kwargs).length) rest.chat_template_kwargs = kwargs;
  else delete rest.chat_template_kwargs;
  return {
    thinkingOff,
    maxTokens: typeof extra.max_tokens === "number" ? extra.max_tokens : null,
    raw: Object.keys(rest).length ? JSON.stringify(rest) : "{}",
  };
}

export type SaveResult = { ok: true } | { ok: false; error: string };
/**
 * Saves the model settings. `require` (onboarding) refuses to save an incomplete configuration, so the
 * wizard can never reach its ready screen with a model missing.
 */
export function saveModelSettings(
  userId: string,
  fd: FormData,
  opts: { require?: boolean; onboarded?: number } = {},
): SaveResult {
  const cur = getSettings(userId);
  let extra: Record<string, unknown>;
  try {
    extra = extraFromForm(fd);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const baseUrl = str(fd, "analyst_base_url").replace(/\/+$/, "");
  if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl))
    return {
      ok: false,
      error: "The base URL must start with http:// or https://.",
    };
  if (baseUrl.includes("YOUR-RESOURCE"))
    return {
      ok: false,
      error: "Replace YOUR-RESOURCE in the Azure URL with your resource name.",
    };
  const input = {
    analyst_base_url: baseUrl,
    analyst_key: kept(fd, "analyst_key", cur?.analyst_key ?? ""),
    analyst_model: str(fd, "analyst_model"),
    analyst_extra: JSON.stringify(extra),
    jev_key: kept(fd, "jev_key", cur?.jev_key ?? ""),
    jev_model: str(fd, "jev_model") || "jev-latest",
    onboarded: cur?.onboarded === 1 ? 1 : (opts.onboarded ?? 1),
  } satisfies SettingsInput;
  if (opts.require) {
    const missing = [
      !input.analyst_base_url && "the analyst base URL",
      !input.analyst_key && "the analyst API key",
      !input.analyst_model && "the analyst model name",
      !input.jev_key && "the TypeSafe (Jev) API key",
    ].filter(Boolean);
    if (missing.length)
      return { ok: false, error: `Still needed: ${missing.join(", ")}.` };
  }
  saveSettings(userId, input);
  if (fd.has("send_sql_present"))
    setSendSql(userId, fd.get("send_sql") === "on");
  return { ok: true };
}

export function analystConfig(userId: string): AnalystConfig | null {
  const s = getSettings(userId);
  const baseUrl = s?.analyst_base_url ?? "";
  const apiKey = open(s?.analyst_key ?? "");
  const model = s?.analyst_model ?? "";
  if (!baseUrl || !apiKey || !model) return null;
  let extra: Record<string, unknown> = {};
  try {
    extra = JSON.parse(s!.analyst_extra) as Record<string, unknown>;
  } catch {
    /* bad JSON means no extra params */
  }
  return { baseUrl, apiKey, model, extra };
}
export const jevKey = (userId: string) =>
  open(getSettings(userId)?.jev_key ?? "");
export const jevModel = (userId: string) =>
  getSettings(userId)?.jev_model || "jev-latest";

/**
 * The digest the models see. With "send query text" off, the statement text is withheld: the plan's
 * operators and predicates still go, and rewrites are ruled out because the model never saw the query.
 */
export function digestForModels(userId: string, d: Digest): Digest {
  if (getSettings(userId)?.send_sql !== 0) return d;
  return {
    ...d,
    sql: "",
    sqlTruncated: true,
    coverage: [
      ...(d.coverage ?? []),
      "Query text withheld by the workspace privacy setting; rewrites are not possible.",
    ],
  };
}

const parseStatus = (
  json: string | null | undefined,
  fingerprint: string,
): ConnectionStatus | null => {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as ConnectionStatus;
    // A test of different settings says nothing about the current ones.
    return s.fingerprint === fingerprint ? s : null;
  } catch {
    return null;
  }
};

export function settingsView(userId: string) {
  const s = getSettings(userId);
  const analystKey = open(s?.analyst_key ?? "");
  const jev = open(s?.jev_key ?? "");
  const baseUrl = s?.analyst_base_url ?? "";
  const model = s?.analyst_model ?? "";
  const jevModelName = s?.jev_model ?? "jev-latest";
  const extra = extraForForm(s?.analyst_extra ?? "{}");
  return {
    analyst_base_url: baseUrl,
    analyst_model: model,
    analyst_extra: extra.raw,
    thinking_off: extra.thinkingOff,
    max_tokens: extra.maxTokens,
    provider: providerFor(baseUrl).id,
    jev_model: jevModelName,
    analyst_key_masked: mask(analystKey),
    jev_key_masked: mask(jev),
    has_analyst: !!(baseUrl && model && analystKey),
    has_jev: !!jev,
    send_sql: s?.send_sql !== 0,
    analyst_status: parseStatus(
      s?.analyst_status,
      `${baseUrl}|${model}|${analystKey.slice(-4)}`,
    ),
    jev_status: parseStatus(s?.jev_status, `${jevModelName}|${jev.slice(-4)}`),
  };
}
export type SettingsView = ReturnType<typeof settingsView>;

/** Header indicator: connected only when both models passed a test of the current settings. */
export function modelHealth(userId: string): "ok" | "failed" | "untested" {
  const v = settingsView(userId);
  if (v.analyst_status?.ok === false || v.jev_status?.ok === false)
    return "failed";
  return v.analyst_status?.ok && v.jev_status?.ok ? "ok" : "untested";
}
