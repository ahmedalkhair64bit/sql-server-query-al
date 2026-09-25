import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { settingsView, analystConfig, jevKey, jevModel } from "@/lib/settings";
import { getSettings, setModelStatus } from "@/lib/db";
import { saveModelsAction } from "@/lib/actions";
import { testAnalyst, testJev } from "@/lib/connection";
import { ModelsForm } from "@/components/models-form";

export const dynamic = "force-dynamic";

const STEPS = ["Welcome", "Connect models", "Check"] as const;
const FLOW = [
  ["Upload a plan", "Actual or estimated ShowPlan XML, up to 100 MB."],
  [
    "Rule checks",
    "Key lookups, spills, parameter sniffing, bad estimates and more are found in code.",
  ],
  [
    "Options from your model",
    "Your analyst model proposes 2 to 4 fixes, each with SQL, validation and rollback.",
  ],
  [
    "Jev decides",
    "Jev scores the options and picks a first action, or says the evidence is not enough.",
  ],
] as const;

export default async function Setup({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const u = await requireUser();
  const step = (await searchParams).step ?? "1";
  const n = ["1", "2", "3"].includes(step) ? Number(step) : 1;
  const view = settingsView(u.id);
  // Someone already set up who lands on the welcome screen goes straight to work.
  if (
    n === 1 &&
    getSettings(u.id)?.onboarded === 1 &&
    view.has_analyst &&
    view.has_jev
  )
    redirect("/app");

  let analyst = view.analyst_status,
    jev = view.jev_status;
  if (n === 3) {
    // Test anything configured but not yet proven, so "Ready" is never a guess.
    const cfg = analystConfig(u.id);
    if (cfg && !analyst?.ok) {
      analyst = await testAnalyst(cfg);
      setModelStatus(u.id, "analyst", JSON.stringify(analyst));
    }
    const key = jevKey(u.id);
    if (key && !jev?.ok) {
      jev = await testJev(key, jevModel(u.id));
      setModelStatus(u.id, "jev", JSON.stringify(jev));
    }
  }
  const missing = [
    !view.has_analyst && "the analyst model",
    !view.has_jev && "the Jev key",
  ].filter(Boolean) as string[];
  const ready = !missing.length && analyst?.ok && jev?.ok;

  return (
    <main className="setup">
      <Image
        src="/brand/logo.png"
        alt="SQL Server Query AI"
        width={120}
        height={120}
        className="setup-logo"
      />
      <ol className="stepper" aria-label="Setup progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            data-state={i + 1 < n ? "done" : i + 1 === n ? "current" : "todo"}
            aria-current={i + 1 === n ? "step" : undefined}
          >
            <span>{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <p className="label">Step {n} of 3</p>

      {n === 1 && (
        <>
          <h1 className="setup-title">Welcome to SQL Server Query AI</h1>
          <p className="setup-lead">
            Turn an execution plan into a short list of fixes, with one
            recommended first action you can validate and roll back.
          </p>
          <ol className="flow">
            {FLOW.map(([title, text], i) => (
              <li key={title}>
                <span className="flow-num">{i + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="card need">
            <h2>You will need</h2>
            <ul>
              <li>
                An API key for an <strong>OpenAI-compatible model</strong>:
                OpenAI, Azure OpenAI, Google Gemini, OpenRouter, or your own
                Ollama or vLLM server.
              </li>
              <li>
                A <strong>TypeSafe API key</strong> for Jev, from
                console.typesafe.ai/keys.
              </li>
            </ul>
            <p className="field-help">
              Keys are encrypted with this deployment&apos;s APP_SECRET and
              never leave the container except to call those providers. The app
              never connects to your SQL Server.
            </p>
          </div>
          <Link className="btn btn-primary setup-next" href="/setup?step=2">
            Connect models
          </Link>
        </>
      )}

      {n === 2 && (
        <>
          <h1 className="setup-title">Connect your models</h1>
          <p className="setup-lead">
            Fill in both, then use the Test buttons. You can change everything
            later in Settings.
          </p>
          <ModelsForm
            action={saveModelsAction}
            view={view}
            after="/setup?step=3"
            submitLabel="Save and continue"
          />
          <Link className="setup-back" href="/setup?step=1">
            Back
          </Link>
        </>
      )}

      {n === 3 && (
        <>
          <h1 className="setup-title">
            {ready
              ? "You are ready"
              : missing.length
                ? "Almost there"
                : "A connection needs attention"}
          </h1>
          <ul className="checklist">
            <li data-state={analyst?.ok ? "ok" : "failed"}>
              <strong>Analyst model</strong>
              <span>
                {!view.has_analyst
                  ? "Not configured."
                  : analyst?.ok
                    ? `${view.analyst_model} answered in ${analyst.ms.toLocaleString()} ms.`
                    : (analyst?.message ?? "Not tested.")}
              </span>
            </li>
            <li data-state={jev?.ok ? "ok" : "failed"}>
              <strong>Jev</strong>
              <span>
                {!view.has_jev
                  ? "Not configured."
                  : jev?.ok
                    ? `${view.jev_model} answered in ${jev.ms.toLocaleString()} ms.`
                    : (jev?.message ?? "Not tested.")}
              </span>
            </li>
          </ul>
          {ready ? (
            <>
              <p className="setup-lead">
                Try it on a sample plan first: a key lookup running 60,000
                times. It takes about a minute and shows every part of a report.
              </p>
              <div className="setup-actions">
                <Link className="btn btn-primary" href="/app?sample=1">
                  Analyse the sample plan
                </Link>
                <Link className="btn" href="/app">
                  Upload my own plan
                </Link>
              </div>
            </>
          ) : (
            <div className="setup-actions">
              <Link className="btn btn-primary" href="/setup?step=2">
                {missing.length
                  ? `Add ${missing.join(" and ")}`
                  : "Fix the settings"}
              </Link>
              {!missing.length && (
                <Link className="btn" href="/app">
                  Continue anyway
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
