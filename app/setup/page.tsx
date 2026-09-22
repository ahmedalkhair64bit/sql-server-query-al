import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { settingsView } from "@/lib/settings";
import { getSettings } from "@/lib/db";
import { saveSettingsAction } from "@/lib/actions";
import { SettingsForm } from "@/components/settings-form";

const TITLES = {
  1: "Paste a plan. Get a ranked fix.",
  2: "Say which models to ask.",
  3: "Ready.",
} as const;

export default async function Setup({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const u = await requireUser();
  const step = (await searchParams).step ?? "";
  const n = (["1", "2", "3"].includes(step) ? step : "1") as "1" | "2" | "3";
  const view = settingsView(u.id);
  // Step 3 stays reachable after onboarding: it is the "are both models actually ready?" screen.
  if (
    n !== "3" &&
    getSettings(u.id)?.onboarded === 1 &&
    view.has_analyst &&
    view.has_jev
  )
    redirect("/app");
  return (
    <main
      style={{
        maxWidth: 560,
        margin: "0 auto",
        padding: "var(--qai-space-3xl) var(--qai-space-l)",
        display: "grid",
        gap: "var(--qai-space-xl)",
      }}
    >
      <p className="label">Step {n} of 3</p>
      <h1
        style={{
          fontFamily: "var(--qai-font-display)",
          fontSize: "var(--qai-text-display)",
          letterSpacing: "-0.02em",
        }}
      >
        {TITLES[n]}
      </h1>
      {n === "1" && (
        <p>
          qAI reads a SQL Server ShowPlan XML, works out the bottleneck in code,
          asks your model for several ways to fix it, then has Jev score each
          one. You configure nothing on this screen.
        </p>
      )}
      {n === "2" && (
        <SettingsForm
          action={saveSettingsAction}
          view={view}
          step="Analyst model and Jev key"
          after="/setup?step=3"
        />
      )}
      {n === "3" && (
        <>
          <p>
            One run = one digest, a few model calls, four Jev questions per
            option. If the analyst or Jev is unreachable, the report says so
            instead of inventing a verdict.
          </p>
          <p className="label">
            Analyst {view.has_analyst ? "ready" : "missing"} · Jev{" "}
            {view.has_jev ? "ready" : "missing"}
          </p>
          <Link
            className="btn btn-primary"
            href="/app"
            style={{ justifySelf: "start", textDecoration: "none" }}
          >
            Go
          </Link>
        </>
      )}
      <p className="colophon">
        Keys stay in this container, encrypted with APP_SECRET ·{" "}
        <Link href="/settings">settings</Link>
      </p>
      {n !== "3" && (
        <Link
          className="btn"
          href={`/setup?step=${Number(n) + 1}`}
          style={{ justifySelf: "start", textDecoration: "none" }}
        >
          Next
        </Link>
      )}
    </main>
  );
}
