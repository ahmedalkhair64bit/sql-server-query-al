"use client";
import { useActionState, useRef, useState } from "react";
import type { SettingsView } from "@/lib/settings";
import type { ConnectionStatus } from "@/lib/connection";
import { PROVIDERS } from "@/lib/providers";

type Result = { ok: boolean; error?: string; message?: string } | null;
type Tested = ConnectionStatus & { saved?: boolean };

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help && (
        <span className="field-help" id={`${id}-help`}>
          {help}
        </span>
      )}
    </div>
  );
}

function StatusLine({ status }: { status: Tested | ConnectionStatus | null }) {
  if (!status)
    return (
      <p className="status-line" data-state="untested">
        Not tested yet
      </p>
    );
  return (
    <p
      className="status-line"
      data-state={status.ok ? "ok" : "failed"}
      role={status.ok ? "status" : "alert"}
    >
      {status.ok
        ? `Connected · answered in ${status.ms.toLocaleString()} ms`
        : status.message}
      {"saved" in status && status.saved === false && status.ok && (
        <> · Save to keep these settings</>
      )}
    </p>
  );
}

// Model settings, shared by onboarding (step 2) and Settings. Each model has a Test button that checks the
// values in the form, saved or not, with one tiny request.
export function ModelsForm({
  action,
  view,
  after,
  privacy,
  submitLabel = "Save model settings",
}: {
  action: (state: Result, fd: FormData) => Promise<Result>;
  view: SettingsView;
  after?: string;
  privacy?: boolean;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState<Result, FormData>(
    action,
    null,
  );
  const form = useRef<HTMLFormElement>(null);
  // The last save's message describes the form as it was then; editing any field retires it.
  const [dismissed, setDismissed] = useState<Result>(null);
  const message = state && state !== dismissed ? state : null;
  const [provider, setProvider] = useState(view.provider);
  const [baseUrl, setBaseUrl] = useState(view.analyst_base_url);
  const [status, setStatus] = useState<{
    analyst: Tested | ConnectionStatus | null;
    jev: Tested | ConnectionStatus | null;
  }>({ analyst: view.analyst_status, jev: view.jev_status });
  const [testing, setTesting] = useState<"analyst" | "jev" | null>(null);
  const [listed, setListed] = useState<string[]>(
    view.analyst_status?.models ?? [],
  );
  const preset = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const suggestions = [...new Set([...preset.models, ...listed])];

  async function test(target: "analyst" | "jev") {
    if (!form.current) return;
    setTesting(target);
    const fd = new FormData(form.current);
    fd.set("target", target);
    try {
      const r = await fetch("/api/settings/test", { method: "POST", body: fd });
      const data = (await r.json()) as Tested & { error?: string };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setStatus((s) => ({ ...s, [target]: data }));
      if (target === "analyst" && data.models?.length) setListed(data.models);
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [target]: {
          ok: false,
          ms: 0,
          message: `The test could not run: ${(e as Error).message}`,
          fingerprint: "",
          at: Date.now(),
        },
      }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <form
      ref={form}
      action={formAction}
      onChange={() => setDismissed(state)}
      className="settings-form"
    >
      {after && <input type="hidden" name="after" value={after} />}

      <fieldset className="card settings-group">
        <legend>
          <span className="group-title">Analyst model</span>
          <span className="group-sub">
            Proposes the fix options. Any OpenAI-compatible API.
          </span>
        </legend>
        <Field id="analyst_provider" label="Provider" help={preset.urlHint}>
          <select
            id="analyst_provider"
            className="field"
            value={provider}
            onChange={(e) => {
              const next = PROVIDERS.find((p) => p.id === e.target.value)!;
              setProvider(next.id);
              if (next.baseUrl) setBaseUrl(next.baseUrl);
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="analyst_base_url" label="Base URL">
          <input
            className="field"
            id="analyst_base_url"
            name="analyst_base_url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <Field
          id="analyst_key"
          label="API key"
          help={
            view.analyst_key_masked
              ? `A key ending in ${view.analyst_key_masked.slice(-4)} is saved. Leave empty to keep it.`
              : preset.keyHint
          }
        >
          <input
            className="field"
            id="analyst_key"
            name="analyst_key"
            type="password"
            autoComplete="off"
            placeholder={
              view.analyst_key_masked
                ? `Saved ${view.analyst_key_masked}`
                : "Paste the API key"
            }
          />
        </Field>
        <Field
          id="analyst_model"
          label="Model"
          help={
            listed.length
              ? `${listed.length} models found for this key: start typing to pick one.`
              : preset.id === "azure"
                ? "Your deployment name."
                : "Exact model name. Test the connection to list the models this key can use."
          }
        >
          <input
            className="field"
            id="analyst_model"
            name="analyst_model"
            list="analyst_model_list"
            autoComplete="off"
            spellCheck={false}
            defaultValue={view.analyst_model}
            placeholder={preset.models[0] ?? "model-name"}
          />
          <datalist id="analyst_model_list">
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <div className="check-field">
          <input
            type="checkbox"
            id="thinking_off"
            name="thinking_off"
            defaultChecked={view.thinking_off}
          />
          <label htmlFor="thinking_off">
            Reasoning model on vLLM or SGLang: turn off streamed thinking
            <span className="field-help">
              Needed for Qwen3, DeepSeek-R1 and similar models, or the answer
              arrives empty.
            </span>
          </label>
        </div>
        <Field
          id="max_tokens"
          label="Maximum response length (tokens)"
          help="Leave empty for 4,096. Raise it if long answers are cut off."
        >
          <input
            className="field"
            id="max_tokens"
            name="max_tokens"
            type="number"
            min={256}
            max={200000}
            step={1}
            inputMode="numeric"
            defaultValue={view.max_tokens ?? ""}
            placeholder="4096"
          />
        </Field>
        <details className="advanced">
          <summary>Advanced request parameters</summary>
          <Field
            id="analyst_extra"
            label="Extra JSON merged into every request"
            help='For example {"temperature":0.2}. The two settings above override the same keys here.'
          >
            <input
              className="field mono"
              id="analyst_extra"
              name="analyst_extra"
              spellCheck={false}
              autoComplete="off"
              defaultValue={view.analyst_extra}
            />
          </Field>
        </details>
        <div className="test-row">
          <button
            type="button"
            className="btn"
            onClick={() => test("analyst")}
            disabled={testing !== null}
          >
            {testing === "analyst" ? "Testing…" : "Test analyst connection"}
          </button>
          <StatusLine status={status.analyst} />
        </div>
      </fieldset>

      <fieldset className="card settings-group">
        <legend>
          <span className="group-title">Jev decision engine</span>
          <span className="group-sub">
            Scores the options and picks one, or declines. Runs on TypeSafe
            System One.
          </span>
        </legend>
        <Field
          id="jev_key"
          label="TypeSafe API key"
          help={
            view.jev_key_masked
              ? `A key ending in ${view.jev_key_masked.slice(-4)} is saved. Leave empty to keep it.`
              : "Create one at console.typesafe.ai/keys."
          }
        >
          <input
            className="field"
            id="jev_key"
            name="jev_key"
            type="password"
            autoComplete="off"
            placeholder={
              view.jev_key_masked
                ? `Saved ${view.jev_key_masked}`
                : "Paste the TypeSafe API key"
            }
          />
        </Field>
        <Field
          id="jev_model"
          label="Jev model"
          help="Keep jev-latest unless TypeSafe told you to pin a version."
        >
          <input
            className="field"
            id="jev_model"
            name="jev_model"
            autoComplete="off"
            spellCheck={false}
            defaultValue={view.jev_model}
          />
        </Field>
        <div className="test-row">
          <button
            type="button"
            className="btn"
            onClick={() => test("jev")}
            disabled={testing !== null}
          >
            {testing === "jev" ? "Testing…" : "Test Jev connection"}
          </button>
          <StatusLine status={status.jev} />
        </div>
      </fieldset>

      {privacy && (
        <fieldset className="card settings-group">
          <legend>
            <span className="group-title">Privacy</span>
            <span className="group-sub">
              What leaves this container when you run an analysis.
            </span>
          </legend>
          <input type="hidden" name="send_sql_present" value="1" />
          <div className="check-field">
            <input
              type="checkbox"
              id="send_sql"
              name="send_sql"
              defaultChecked={view.send_sql}
            />
            <label htmlFor="send_sql">
              Send the query text to the analyst model
              <span className="field-help">
                When off, only plan evidence is sent (operators, row counts,
                warnings, predicates, table and index names). Query rewrites are
                then not offered.
              </span>
            </label>
          </div>
        </fieldset>
      )}

      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {message && !message.ok && (
          <p role="alert" className="danger-text">
            {message.error}
          </p>
        )}
        {message?.ok && (
          <p role="status" className="ok-text">
            {message.message ?? "Saved."}
          </p>
        )}
      </div>
    </form>
  );
}
