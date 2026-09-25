"use client";
import { useActionState } from "react";

type Result = { ok: boolean; error?: string; message?: string } | null;
type Action = (state: Result, fd: FormData) => Promise<Result>;

const Feedback = ({ state }: { state: Result }) =>
  state ? (
    <p
      role={state.ok ? "status" : "alert"}
      className={state.ok ? "ok-text" : "danger-text"}
    >
      {state.ok ? state.message : state.error}
    </p>
  ) : null;

export function AccountForm({
  action,
  email,
}: {
  action: Action;
  email: string;
}) {
  const [state, formAction, pending] = useActionState<Result, FormData>(
    action,
    null,
  );
  return (
    <form action={formAction} className="card settings-group">
      <div className="form-field">
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          className="field"
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={email}
          required
        />
        <span className="field-help">You sign in with this address.</span>
      </div>
      <div className="form-field">
        <label className="label" htmlFor="current_password">
          Current password
        </label>
        <input
          className="field"
          id="current_password"
          name="current_password"
          type="password"
          autoComplete="current-password"
        />
        <span className="field-help">Required only to set a new password.</span>
      </div>
      <div className="form-field">
        <label className="label" htmlFor="new_password">
          New password
        </label>
        <input
          className="field"
          id="new_password"
          name="new_password"
          type="password"
          autoComplete="new-password"
          minLength={10}
        />
        <span className="field-help">
          At least 10 characters. Changing it signs out your other devices.
        </span>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Update account"}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function DataForm({ action, count }: { action: Action; count: number }) {
  const [state, formAction, pending] = useActionState<Result, FormData>(
    action,
    null,
  );
  return (
    <div className="card settings-group">
      <p>
        <strong>{count.toLocaleString()}</strong>{" "}
        {count === 1 ? "analysis" : "analyses"} saved in this workspace. Rename
        or delete single runs from the history list.
      </p>
      <div className="form-actions">
        <a className="btn" href="/api/export" download>
          Export all analyses (JSON)
        </a>
      </div>
      {/* Outside the danger zone: after deleting everything that section is gone, the result must stay. */}
      <Feedback state={state} />
      {count > 0 && (
        <details className="danger-zone">
          <summary>Delete all analyses</summary>
          <form action={formAction} className="settings-group">
            <p className="field-help">
              Removes every analysis and its uploaded plan. This cannot be
              undone: export first if you may need them.
            </p>
            <div className="form-field">
              <label className="label" htmlFor="confirm">
                Type DELETE to confirm
              </label>
              <input
                className="field"
                id="confirm"
                name="confirm"
                autoComplete="off"
              />
            </div>
            <div className="form-actions">
              <button className="btn btn-danger" disabled={pending}>
                {pending ? "Deleting…" : "Delete all analyses"}
              </button>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}
