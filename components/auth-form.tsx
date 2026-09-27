"use client";
import { useActionState, useState } from "react";
import { useShake } from "./motion";

export type FormResult = { ok?: boolean; error?: string } | null;

export function AuthForm({
  action,
  submit,
  fields,
}: {
  action: (state: FormResult, fd: FormData) => Promise<FormResult>;
  submit: string;
  fields: {
    name: string;
    label: string;
    type: string;
    autoComplete?: string;
    help?: string;
  }[];
}) {
  const [state, formAction, pending] = useActionState<FormResult, FormData>(
    action,
    null,
  );
  // Editing a field after a failed attempt clears its error marks.
  const [seen, setSeen] = useState<FormResult>(null);
  const failed = !!state && !state.ok && state !== seen;
  // React resets the form after each attempt; the email comes back, the password does not.
  const [kept, setKept] = useState<Record<string, string>>({});
  // Each failed attempt is a new state object, so a repeated wrong password shakes again.
  const shake = useShake<HTMLFormElement>(failed ? state : null);
  return (
    <form
      action={formAction}
      className="card auth-form"
      ref={shake}
      onChange={() => setSeen(state)}
    >
      {fields.map((f) => (
        <div key={f.name} className="auth-field">
          <label className="label" htmlFor={f.name}>
            {f.label}
          </label>
          <input
            className="field"
            id={f.name}
            name={f.name}
            type={f.type}
            autoComplete={f.autoComplete}
            defaultValue={f.type === "password" ? undefined : kept[f.name]}
            onChange={(e) =>
              f.type !== "password" &&
              setKept((k) => ({ ...k, [f.name]: e.target.value }))
            }
            aria-invalid={failed || undefined}
            aria-describedby={failed ? "auth-error" : undefined}
            required
          />
          {f.help && <span className="auth-help">{f.help}</span>}
        </div>
      ))}
      {failed && (
        <p role="alert" id="auth-error" className="auth-error t-error-in">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" disabled={pending}>
        {submit}
      </button>
    </form>
  );
}
