"use client";
import { useActionState } from "react";
import type { SettingsView } from "@/lib/settings";

type Result = { ok?: boolean; error?: string } | null;

const Group = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <fieldset
    style={{
      border: 0,
      padding: 0,
      margin: 0,
      display: "grid",
      gap: "var(--qai-space-md)",
    }}
  >
    <legend className="label">{title}</legend>
    {children}
  </fieldset>
);

export function SettingsForm({
  action,
  view,
  step,
  account,
  after,
}: {
  action: (state: Result, fd: FormData) => Promise<Result>;
  view: SettingsView;
  step?: string;
  account?: boolean;
  after?: string;
}) {
  const [state, formAction, pending] = useActionState<Result, FormData>(
    action,
    null,
  );
  const F = (
    name: string,
    label: string,
    value: string,
    help: string,
    type = "text",
  ) => (
    <div key={name} style={{ display: "grid", gap: "var(--qai-space-xs)" }}>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <input
        className="field"
        id={name}
        name={name}
        type={name.endsWith("_key") ? "password" : type}
        defaultValue={value}
      />
      <span
        style={{
          fontSize: "var(--qai-text-xs)",
          color: "var(--qai-ink-muted)",
        }}
      >
        {help}
      </span>
    </div>
  );
  return (
    <form
      action={formAction}
      className="card"
      style={{ display: "grid", gap: "var(--qai-space-l)" }}
    >
      {after && <input type="hidden" name="after" value={after} />}
      {step && <p className="label">{step}</p>}
      <Group title="Analyst model — OpenAI-compatible">
        {F(
          "analyst_base_url",
          "Base URL",
          view.analyst_base_url,
          "e.g. https://api.openai.com/v1",
        )}
        {F(
          "analyst_key",
          "API key",
          "",
          view.has_analyst
            ? `Saved ${view.analyst_key_masked} — leave blank to keep it`
            : "Encrypted with APP_SECRET before it hits disk",
        )}
        {F(
          "analyst_model",
          "Model name",
          view.analyst_model,
          "e.g. gpt-4o-mini, llama-3.3-70b",
        )}
        {F(
          "analyst_extra",
          "Extra params (JSON)",
          view.analyst_extra,
          'Merged into the request body, e.g. {"temperature":0.2}. Reasoning models stream thinking, not the answer: ' +
            'vLLM/Qwen needs {"chat_template_kwargs":{"enable_thinking":false}} or the report arrives empty.',
        )}
      </Group>
      <Group title="Jev — TypeSafe System One">
        {F(
          "jev_key",
          "TypeSafe API key",
          "",
          view.has_jev
            ? `Saved ${view.jev_key_masked} — leave blank to keep it`
            : "console.typesafe.ai/keys",
        )}
        {F(
          "jev_model",
          "Jev model",
          view.jev_model,
          "jev-latest unless you know better",
        )}
      </Group>
      {account && (
        <Group title="Account">
          {F("email", "Email", "", "Used to sign in", "email")}
          {F(
            "password",
            "New password",
            "",
            "Leave blank to keep the current one",
            "password",
          )}
        </Group>
      )}
      {state && !state.ok && (
        <p role="alert" style={{ color: "var(--qai-danger)" }}>
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" style={{ color: "var(--qai-accent)" }}>
          Saved.
        </p>
      )}
      <button className="btn btn-primary" disabled={pending}>
        Save
      </button>
    </form>
  );
}
