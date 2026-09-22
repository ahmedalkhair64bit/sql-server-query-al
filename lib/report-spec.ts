import { defineComponent, createLibrary } from "@openuidev/lang-core";
import { z } from "zod/v4";

// The single source of truth for what the analyst model is allowed to emit.
// This module must never import React or @openuidev/react-lang: the API route runs it in a plain
// Node runtime to build the prompt, and React's server build throws on createContext there.
// lib/report-ui.ts attaches the React renderers to these same specs, so prompt and renderer cannot drift.

const noop = () => null;

export const Headline = defineComponent({ props: z.object({ title: z.string(), subtitle: z.string().optional(),
    severity: z.enum(["critical", "warning", "info"]).optional() }),
  name: "Headline", description: "Report title: the one-line finding, with severity.", component: noop });

export const Metric = defineComponent({ props: z.object({ label: z.string(), value: z.string(), note: z.string().optional() }),
  name: "Metric", description: "One plan metric.", component: noop });

export const MetricGrid = defineComponent({ props: z.object({ items: z.array(Metric.ref) }),
  name: "MetricGrid", description: "Row of plan metrics.", component: noop });

export const Finding = defineComponent({ props: z.object({ where: z.string(), issue: z.string(), evidence: z.string(), impact: z.string() }),
  name: "Finding", description: "One problem, the plan evidence for it, its impact.", component: noop });

export const Findings = defineComponent({ props: z.object({ items: z.array(Finding.ref) }),
  name: "Findings", description: "Everything wrong with the plan.", component: noop });

export const Step = defineComponent({ props: z.object({ text: z.string(), effort: z.enum(["low", "medium", "high"]).optional(),
    owner: z.enum(["dba", "developer", "both"]).optional(), changeControl: z.boolean().optional() }),
  name: "Step", description: "One action step.", component: noop });

export const StepList = defineComponent({ props: z.object({ title: z.string(), steps: z.array(Step.ref) }),
  name: "StepList", description: "Ordered action plan for one option.", component: noop });

export const SqlBlock = defineComponent({ props: z.object({ title: z.string(), sql: z.string(), caption: z.string().optional() }),
  name: "SqlBlock", description: "A SQL snippet the user can copy.", component: noop });

export const ScoreBar = defineComponent({ props: z.object({ label: z.string(), value: z.number(),
    confidence: z.number().optional(), note: z.string().optional() }),
  name: "ScoreBar", description: "One Jev dimension: normalised value plus confidence.", component: noop });

export const OptionRow = defineComponent({ props: z.object({ rank: z.number(), title: z.string(), composite: z.number(),
    headline: z.boolean(), flags: z.string().optional() }),
  name: "OptionRow", description: "One ranked option.", component: noop });

export const OptionTable = defineComponent({ props: z.object({ title: z.string(), weights: z.string(), rows: z.array(OptionRow.ref) }),
  name: "OptionTable", description: "All options ranked by composite score.", component: noop });

export const VerdictBlock = defineComponent({ props: z.object({ headline: z.string(), why: z.string(),
    source: z.enum(["jev", "composite"]), confidence: z.number() }),
  name: "VerdictBlock", description: "What Jev decided, and how sure it was.", component: noop });

export const Callout = defineComponent({ props: z.object({ level: z.enum(["info", "warn", "danger", "success"]),
    title: z.string(), text: z.string() }),
  name: "Callout", description: "A warning or note the user must not miss.", component: noop });

export const Report = defineComponent({ props: z.object({ blocks: z.array(z.union([Headline.ref, VerdictBlock.ref,
    MetricGrid.ref, Findings.ref, OptionTable.ref, StepList.ref, SqlBlock.ref, ScoreBar.ref, Callout.ref])) }),
  name: "Report", description: "Root. A query-plan report in reading order.", component: noop });

export const specs = [Headline, Metric, MetricGrid, Finding, Findings, Step, StepList, SqlBlock, ScoreBar,
  OptionRow, OptionTable, VerdictBlock, Callout, Report];

/** Prompt-side library: same specs, no renderers. Safe in a non-React Node runtime. */
export const promptLibrary = createLibrary({ root: "Report", components: specs });

export const reportPromptOptions = {
  preamble: "You output only OpenUI Lang. No prose, no markdown fences, no commentary before or after.",
  additionalRules: [
    "root = Report([...]) and it must list every block you define.",
    "Block order: Headline, VerdictBlock, MetricGrid, Findings, OptionTable, then per option its StepList and SqlBlock, then ScoreBars, then Callout.",
    "Use ONLY numbers present in the input. Never invent a cost, row count, impact, or confidence.",
    "One SqlBlock per rewrite, titled with that option's key. T-SQL only, no markdown.",
    "Every option flagged verify_semantics gets a Callout level danger: compare result rows before deploying.",
    "If verdict.source is composite, say plainly that Jev did not decide.",
  ],
  examples: [`root = Report([head, verdict])
head = Headline("Clustered Index Scan on Sales.Orders is 84% of the plan", "No usable key on CustomerId", "critical")
verdict = VerdictBlock("Create the covering index", "bottleneck_fit 1.00, semantic_safety 1.00, ease 0.50.", "jev", 0.82)`],
};

export const reportPrompt = () => promptLibrary.prompt(reportPromptOptions);
