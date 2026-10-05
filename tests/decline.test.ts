import test from "node:test";
import assert from "node:assert/strict";
import { explainDecline, passesChecks, blockReason } from "../lib/decline.ts";

const dims = (fit: number) => ({
  bottleneck_fit: { value: fit, confidence: 0.8 },
  semantic_safety: { value: 1, confidence: 0.8 },
  ease: { value: 0.5, confidence: 0.8 },
  root_cause: { value: 0.8, confidence: 0.8 },
});
const row = (key: string, flags: string[] = [], fit = 0.8, composite = 0.7) =>
  ({ key, flags, dims: dims(fit), composite }) as any;
const cands = [
  { key: "idx", title: "Cover the key lookup", option_type: "index" },
  { key: "stats", title: "Refresh statistics", option_type: "statistics" },
] as any[];
const verdict = (v: object) =>
  ({
    version: 2,
    status: "abstained",
    source: "none",
    headline: null,
    jev_pick: null,
    jev_confidence: 0,
    agrees: false,
    anything_worth_running: 0.9,
    weights: {},
    flags: [],
    order: [],
    ...v,
  }) as any;

test("the count of options that passed uses every blocking check, fit included", () => {
  assert.equal(passesChecks(row("a")), true);
  assert.equal(passesChecks(row("a", ["misses_bottleneck"])), false);
  assert.equal(passesChecks(row("a", ["estimates_accurate"])), false);
  assert.equal(passesChecks(row("a", [], 0.1)), false);
  assert.equal(passesChecks(row("a", ["change_control"])), true);
  assert.equal(
    blockReason(row("a", [], 0.1)),
    "it fits the measured bottleneck poorly",
  );
});

test("no option passed: says so and names the best-scored option with its reason", () => {
  const d = explainDecline(
    verdict({
      flags: ["no_suitable_action"],
      order: [
        row("stats", ["misses_bottleneck"]),
        row("idx", ["verify_semantics"]),
      ],
    }),
    cands,
  );
  assert.equal(d.title, "No option passed the checks");
  assert.match(d.reason, /None of the 2 options passed/);
  assert.equal(d.closest?.key, "stats");
  assert.match(d.closest!.why, /does not address the measured bottleneck/);
});

test("options passed but Jev chose to wait: no claim that every option failed", () => {
  const d = explainDecline(
    verdict({
      flags: ["no_suitable_action"],
      order: [row("idx"), row("stats", ["misses_bottleneck"])],
      jev_probabilities: { idx: 0.35, no_suitable_action: 0.6 },
    }),
    cands,
    { actual: true },
  );
  assert.match(
    d.reason,
    /1 of 2 options passed the checks, but Jev judged none/,
  );
  assert.match(d.reason, /60% on collecting more evidence/);
  assert.doesNotMatch(d.reason, /failed/);
  assert.equal(d.closest?.title, "Cover the key lookup");
  assert.ok(!d.next.some((n) => /actual execution plan/.test(n)));
  assert.ok(d.next.some((n) => /existing indexes/.test(n)));
});

test("low confidence and nothing worthwhile each name their own number", () => {
  const low = explainDecline(
    verdict({
      flags: ["low_confidence"],
      order: [row("idx")],
      jev_probabilities: { idx: 0.42, stats: 0.3, no_suitable_action: 0.28 },
    }),
    cands,
  );
  assert.match(low.reason, /42% of its weight, short of the 50%/);
  const worth = explainDecline(
    verdict({
      flags: ["nothing_clearly_worthwhile"],
      anything_worth_running: 0.31,
      order: [row("idx")],
      jev_probabilities: { idx: 0.7, no_suitable_action: 0.3 },
    }),
    cands,
    { actual: false },
  );
  assert.match(worth.reason, /at 31%, under the 50%/);
  assert.match(worth.next[0], /actual execution plan/);
});

test("an answer naming an option that does not exist is reported as an answer error, not a judgment", () => {
  const d = explainDecline(
    verdict({
      flags: ["no_suitable_action"],
      order: [row("idx")],
      jev_probabilities: { ghost: 0.87, no_suitable_action: 0.05 },
    }),
    cands,
  );
  assert.match(d.reason, /not on the list/);
  assert.doesNotMatch(d.reason, /collecting more evidence/);
  assert.equal(
    d.closest?.key,
    "idx",
    "the closest is always an option that passed",
  );
});

test("an answer favouring an option that failed the checks never offers it as the closest", () => {
  const d = explainDecline(
    verdict({
      flags: ["no_suitable_action"],
      order: [row("idx"), row("stats", ["misses_bottleneck"])],
      jev_probabilities: { stats: 0.87, idx: 0.08, no_suitable_action: 0.05 },
    }),
    cands,
  );
  assert.match(
    d.reason,
    /favoured "Refresh statistics", which had not passed the checks \(it does not address the measured bottleneck\)/,
  );
  assert.equal(d.closest?.key, "idx");
});
