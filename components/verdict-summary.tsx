import type { Verdict } from "@/lib/jev";
export function VerdictSummary({ verdict }: { verdict: Verdict }) {
  const win =
    verdict.order.find((o) => o.key === verdict.headline) ?? verdict.order[0];
  return (
    <section className="card" data-verdict>
      <p className="label">
        Jev verdict ·{" "}
        {verdict.source === "jev"
          ? `chosen, confidence ${verdict.jev_confidence.toFixed(2)}`
          : "composite order — Jev did not decide"}
      </p>
      <p
        style={{
          fontFamily: "var(--qai-font-display)",
          fontSize: "var(--qai-text-lg)",
        }}
      >
        {win?.key}
      </p>
      <p className="label">
        weights{" "}
        {Object.entries(verdict.weights as Record<string, number>)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")}
      </p>
      {Array.isArray(verdict.flags) && verdict.flags.length > 0 && (
        <p style={{ color: "var(--qai-warn)" }}>{verdict.flags.join(" · ")}</p>
      )}
    </section>
  );
}
