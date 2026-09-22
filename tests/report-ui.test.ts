import test from "node:test";
import assert from "node:assert/strict";
const { promptLibrary, reportPromptOptions, specs } = await import("../lib/report-spec.ts");

test("the prompt advertises every component and the root", () => {
  const p = promptLibrary.prompt(reportPromptOptions);
  for (const n of ["Report", "Headline", "VerdictBlock", "MetricGrid", "Findings", "OptionTable",
                   "StepList", "SqlBlock", "ScoreBar", "Callout"]) assert.ok(p.includes(n), `missing ${n}`);
  assert.match(p, /root/i);
  assert.match(p, /never invent/i);
});
test("every spec has a renderer, so the model can never emit an unrenderable block", async () => {
  const { library } = await import("../lib/report-ui.ts");
  for (const s of specs) assert.ok(library.components[s.name], `no renderer for ${s.name}`);
});

test("a null confidence from the model does not blank the block", async () => {
  // The prompt says optional; models still send null. confidence != undefined let null through to .toFixed().
  const { library } = await import("../lib/report-ui.ts");
  const renderNode = () => null;
  for (const [name, props] of [
    ["ScoreBar", { label: "fit", value: 0.5, confidence: null }],
    ["VerdictBlock", { headline: "h", why: "w", source: "jev", confidence: null }],
  ] as const) {
    const el = library.components[name].component({ props: props as any, renderNode } as any);
    assert.ok(el, `${name} returned nothing`);
  }
});
