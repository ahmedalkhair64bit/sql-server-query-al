"use client";
import { useActionState } from "react";

export type FormResult = { ok?: boolean; error?: string } | null;

export function AuthForm({ action, submit, fields }: {
  action: (state: FormResult, fd: FormData) => Promise<FormResult>;
  submit: string;
  fields: { name: string; label: string; type: string; autoComplete?: string; help?: string }[];
}) {
  const [state, formAction, pending] = useActionState<FormResult, FormData>(action, null);
  return <form action={formAction} className="card" style={{ display: "grid", gap: "var(--qai-space-md)" }}>
    {fields.map((f) => <div key={f.name} style={{ display: "grid", gap: "var(--qai-space-xs)" }}>
      <label className="label" htmlFor={f.name}>{f.label}</label>
      <input className="field" id={f.name} name={f.name} type={f.type} autoComplete={f.autoComplete} required />
      {f.help && <span style={{ fontSize: "var(--qai-text-xs)", color: "var(--qai-ink-muted)" }}>{f.help}</span>}
    </div>)}
    {state && !state.ok && <p role="alert" style={{ color: "var(--qai-danger)" }}>{state.error}</p>}
    <button className="btn btn-primary" disabled={pending}>{submit}</button>
  </form>;
}
