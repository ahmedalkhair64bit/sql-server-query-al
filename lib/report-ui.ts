import { createElement as el } from "react";
import { defineComponent, createLibrary } from "@openuidev/react-lang";
import { specs } from "./report-spec.ts";

// Props, descriptions and the prompt come from lib/report-spec.ts (React-free, usable in the API route).
// This file only says what each component looks like. Names and schemas cannot drift: they are imported.
// No JSX here either — `node --test` imports modules and Node does not strip JSX.
const p = (style: Record<string, string | number>, ...kids: any[]) => el("p", { style }, ...kids);
const muted = { color: "var(--qai-ink-muted)" };
const small = { fontSize: "var(--qai-text-xs)", color: "var(--qai-ink-muted)" };
const disp = { fontFamily: "var(--qai-font-display)" };

// Model output is untrusted: the schema says a number is optional, models still send null, and one throw
// deletes the whole block from the report. 0 is the honest stand-in for "the model did not give a number".
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const conf = (v: unknown) => (typeof v === "number" ? ` ${v.toFixed(2)}` : " not reported");

const renderers: Record<string, (x: any) => any> = {
  Headline: ({ props }) => el("header", null,
    el("p", { className: "label" }, props.severity === "critical" ? "Critical" : props.severity === "warning" ? "Warning" : "Note"),
    el("h2", { style: { ...disp, fontSize: "var(--qai-text-2xl)", margin: "var(--qai-space-s) 0" } }, props.title),
    props.subtitle ? p(muted, props.subtitle) : null),

  Metric: ({ props }) => el("div", { className: "card" },
    el("p", { className: "label" }, props.label),
    p({ ...disp, fontSize: "var(--qai-text-xl)" }, props.value),
    props.note ? p(small, props.note) : null),

  MetricGrid: ({ props, renderNode }: any) => el("div", { className: "grid-metrics" }, renderNode(props.items)),

  Finding: ({ props }) => el("div", { className: "card" },
    el("p", { className: "label" }, props.where),
    p({ margin: "var(--qai-space-s) 0" }, el("strong", null, props.issue)),
    el("p", { className: "sql" }, props.evidence),
    p(muted, props.impact)),

  Findings: ({ props, renderNode }: any) => el("section", { className: "report" }, renderNode(props.items)),

  Step: ({ props }) => el("li", { className: "card", style: { display: "flex", gap: "var(--qai-space-md)",
      alignItems: "center", flexWrap: "wrap" } },
    el("span", { style: { flex: "1 1 200px", minWidth: 0 } }, props.text),
    props.effort ? el("span", { className: "pill" }, `effort ${props.effort}`) : null,
    props.owner ? el("span", { className: "pill" }, props.owner) : null,
    props.changeControl ? el("span", { className: "pill" }, "change control") : null),

  StepList: ({ props, renderNode }: any) => el("section", null,
    el("h3", { style: disp }, props.title),
    el("ol", { style: { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "var(--qai-space-md)" } },
      renderNode(props.steps))),

  SqlBlock: ({ props }) => el("figure", { className: "card", style: { margin: 0 } },
    el("figcaption", { className: "label" }, props.title),
    el("pre", { className: "sql" }, props.sql),
    el("button", { className: "btn no-print", onClick: () => navigator.clipboard.writeText(props.sql) }, "Copy SQL"),
    props.caption ? el("p", { style: small }, props.caption) : null),

  ScoreBar: ({ props }) => el("div", null,
    el("p", { className: "label" }, props.label + (props.confidence === undefined
      ? " · no confidence reported" : ` · confidence${conf(props.confidence)}`)),
    el("div", { className: "bar", style: { width: `${Math.round(num(props.value) * 100)}%` } }),
    props.note ? el("p", { style: small }, props.note) : null),

  OptionRow: ({ props }) => el("tr", { "data-headline": props.headline || undefined },
    el("td", null, String(props.rank)), el("td", null, props.title),
    el("td", { className: "sql" }, num(props.composite).toFixed(2)),
    el("td", null, props.flags || "—")),

  OptionTable: ({ props, renderNode }: any) => el("section", { className: "card" },
    el("h3", { style: disp }, props.title),
    el("p", { style: small }, props.weights),
    el("table", { style: { width: "100%", borderCollapse: "collapse" } }, el("tbody", null, renderNode(props.rows)))),

  VerdictBlock: ({ props }) => el("section", { className: "card", "data-verdict": "" },
    el("p", { className: "label" }, "First move · " + (props.source === "jev"
      ? `Jev, confidence${conf(props.confidence)}` : "composite order — Jev did not decide")),
    p({ ...disp, fontSize: "var(--qai-text-lg)" }, props.headline),
    p({}, props.why)),

  Callout: ({ props }) => el("div", { className: "card", "data-level": props.level,
      role: props.level === "danger" ? "alert" : "note" },
    el("p", null, el("strong", null, props.title)), el("p", null, props.text)),

  Report: ({ props, renderNode }: any) => el("div", { className: "report", id: "report" }, renderNode(props.blocks)),
};

export const library = createLibrary({
  root: "Report",
  components: specs.map((s) => defineComponent({ name: s.name, props: s.props, description: s.description,
    component: renderers[s.name] })),
});
