"use client";
import { useActionState } from "react";

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
  return (
    <form action={formAction} className="card auth-form">
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
            required
          />
          {f.help && <span className="auth-help">{f.help}</span>}
        </div>
      ))}
      {state && !state.ok && (
        <p role="alert" className="auth-error">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" disabled={pending}>
        {submit}
      </button>
    </form>
  );
}
