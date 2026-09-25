import { Workspace } from "@/components/workspace";
import { requireUser } from "@/lib/auth";
import { settingsView, modelHealth } from "@/lib/settings";
import { listAnalyses } from "@/lib/db";
import {
  saveModelsAction,
  saveAccountAction,
  deleteAllAction,
  signOut,
} from "@/lib/actions";
import { ModelsForm } from "@/components/models-form";
import { AccountForm, DataForm } from "@/components/account-forms";

export default async function Settings() {
  const u = await requireUser();
  const rows = listAnalyses(u.id);
  return (
    <Workspace rows={rows} health={modelHealth(u.id)}>
      <section className="settings-page">
        <h1 className="page-title">Settings</h1>
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#models">Models</a>
          <a href="#account">Account</a>
          <a href="#data">Data</a>
        </nav>
        <section id="models" className="settings-section">
          <h2>Models</h2>
          <ModelsForm
            action={saveModelsAction}
            view={settingsView(u.id)}
            privacy
          />
        </section>
        <section id="account" className="settings-section">
          <h2>Account</h2>
          <AccountForm action={saveAccountAction} email={u.email} />
          <form action={signOut}>
            <button className="btn">Sign out of this device</button>
          </form>
        </section>
        <section id="data" className="settings-section">
          <h2>Data</h2>
          <DataForm action={deleteAllAction} count={rows.length} />
        </section>
      </section>
    </Workspace>
  );
}
