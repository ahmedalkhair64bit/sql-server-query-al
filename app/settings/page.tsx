import { Workspace } from "@/components/workspace";
import { requireUser } from "@/lib/auth";
import { settingsView } from "@/lib/settings";
import { listAnalyses } from "@/lib/db";
import { saveSettingsAction, signOut } from "@/lib/actions";
import { SettingsForm } from "@/components/settings-form";

export default async function Settings() {
  const u = await requireUser();
  const rows = listAnalyses(u.id);
  return (
    <Workspace rows={rows}>
      <section className="settings-page">
        <h1
          style={{
            fontFamily: "var(--qai-font-display)",
            fontSize: "var(--qai-text-2xl)",
          }}
        >
          Settings
        </h1>
        <SettingsForm
          action={saveSettingsAction}
          view={settingsView(u.id)}
          account
        />
        <section className="card">
          <p className="label">History · {rows.length}</p>
          <p style={{ fontSize: "var(--qai-text-sm)" }}>
            Rename or delete individual runs from the left rail. Nothing here
            deletes them in bulk — that is on purpose.
          </p>
        </section>
        <form action={signOut}>
          <button className="btn">Sign out</button>
        </form>
      </section>
    </Workspace>
  );
}
