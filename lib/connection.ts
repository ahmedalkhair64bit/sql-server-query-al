import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { makeJevClient } from "./jev.ts";
import type { AnalystConfig } from "./settings.ts";

export type ConnectionStatus = {
  ok: boolean;
  ms: number;
  message: string;
  /** Identifies what was tested, so a later settings change makes the status stale. */
  fingerprint: string;
  at: number;
  models?: string[];
};
const TIMEOUT_MS = 20_000;
export const analystFingerprint = (
  c: Pick<AnalystConfig, "baseUrl" | "model" | "apiKey">,
) => `${c.baseUrl}|${c.model}|${c.apiKey.slice(-4)}`;
export const jevFingerprint = (key: string, model: string) =>
  `${model}|${key.slice(-4)}`;

// Turn HTTP failures into the next step the user should take.
function explain(status: number, body: string, baseUrl: string) {
  const detail = (() => {
    try {
      const j = JSON.parse(body);
      return String(j.error?.message ?? j.message ?? j.detail ?? "").slice(
        0,
        200,
      );
    } catch {
      return body.slice(0, 200);
    }
  })();
  const tail = detail ? ` Provider said: ${detail}` : "";
  if (status === 401 || status === 403)
    return `The API key was rejected (HTTP ${status}).${tail}`;
  if (status === 404)
    return `Not found (HTTP 404): check that the base URL ends at the API root (usually /v1) and the model name is exact.${tail}`;
  if (status === 429) return `Rate limited or out of quota (HTTP 429).${tail}`;
  if (status >= 500)
    return `The provider failed (HTTP ${status}). Try again shortly.${tail}`;
  return `${baseUrl} answered HTTP ${status}.${tail}`;
}

/** One tiny chat completion with the exact model and extra params an analysis will use. */
export async function testAnalyst(
  cfg: AnalystConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionStatus> {
  const started = Date.now();
  const done = (
    ok: boolean,
    message: string,
    models?: string[],
  ): ConnectionStatus => ({
    ok,
    ms: Date.now() - started,
    message,
    fingerprint: analystFingerprint(cfg),
    at: Date.now(),
    ...(models?.length ? { models } : {}),
  });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
  };
  // The model list is a convenience for the form; providers that do not serve it are fine.
  const models = await fetchImpl(`${cfg.baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(async (r) =>
      r.ok
        ? (((await r.json()) as { data?: { id?: string }[] }).data ?? [])
        : [],
    )
    .then((d) =>
      d
        .map((m) => String(m.id ?? ""))
        .filter(Boolean)
        .slice(0, 100),
    )
    .catch(() => [] as string[]);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 16,
        ...cfg.extra,
        stream: false,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      }),
    });
  } catch (e) {
    const err = e as Error;
    return done(
      false,
      err.name === "TimeoutError"
        ? `No answer from ${cfg.baseUrl} within ${TIMEOUT_MS / 1000} s.`
        : `Could not reach ${cfg.baseUrl}: ${(err.cause as Error)?.message ?? err.message}`,
      models,
    );
  }
  const text = await res.text();
  if (!res.ok)
    return done(false, explain(res.status, text, cfg.baseUrl), models);
  try {
    const j = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
    };
    if (!Array.isArray(j.choices)) throw new Error();
    return done(true, `${cfg.model} answered.`, models);
  } catch {
    return done(
      false,
      `${cfg.baseUrl} answered, but not with an OpenAI-compatible chat completion.`,
      models,
    );
  }
}

/** One single-question System One call. */
export async function testJev(
  key: string,
  model: string,
  client?: TypeSafeClient,
): Promise<ConnectionStatus> {
  const started = Date.now();
  const done = (ok: boolean, message: string): ConnectionStatus => ({
    ok,
    ms: Date.now() - started,
    message,
    fingerprint: jevFingerprint(key, model),
    at: Date.now(),
  });
  try {
    const c = client ?? makeJevClient(key, model);
    const r = await c.systemOne(
      {
        state: { ping: "ok" },
        questions: { alive: noul("The value of `ping` is the word ok.") },
      },
      { retry: { maxRetries: 0 }, timeout: TIMEOUT_MS },
    );
    return typeof r.answers?.alive?.noul === "number"
      ? done(true, `${model} answered.`)
      : done(false, "Jev answered without the expected judgment.");
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 401 || err.status === 403)
      return done(
        false,
        `The TypeSafe API key was rejected (HTTP ${err.status}).`,
      );
    if (err.status === 404)
      return done(false, `Jev model "${model}" was not found (HTTP 404).`);
    if (err.status === 429)
      return done(false, "Jev is rate limited or out of quota (HTTP 429).");
    return done(
      false,
      `Jev could not be reached: ${err.message.slice(0, 200)}`,
    );
  }
}
