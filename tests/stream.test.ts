import test from "node:test";
import assert from "node:assert/strict";
const { sse, readSse, openAiTextDeltas } = await import("../lib/stream.ts");

const streamOf = (parts: string[]) => new ReadableStream<Uint8Array>({ start(c) {
  parts.forEach((p) => c.enqueue(new TextEncoder().encode(p))); c.close(); } });

test("sse frames one event", () =>
  assert.equal(sse("stage", { stage: "digesting" }), 'event: stage\ndata: {"stage":"digesting"}\n\n'));

test("readSse rejoins frames split anywhere", async () => {
  const raw = sse("stage", { stage: "digesting" }) + sse("oul", { chunk: "root = Report([])" });
  const events: any[] = [];
  for await (const e of readSse(streamOf([raw.slice(0, 12), raw.slice(12, 40), raw.slice(40)]))) events.push(e);
  assert.deepEqual(events, [{ event: "stage", data: { stage: "digesting" } },
                            { event: "oul", data: { chunk: "root = Report([])" } }]);
});
test("readSse ignores frames it cannot parse", async () => {
  const events: any[] = [];
  for await (const e of readSse(streamOf([": ping\n\n", sse("done", { id: "1" })]))) events.push(e);
  assert.deepEqual(events, [{ event: "done", data: { id: "1" } }]);
});
test("openAiTextDeltas yields content and stops at [DONE]", async () => {
  const res = new Response(streamOf(['data: {"choices":[{"delta":{"content":"ab"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"cd"}}]}\n\n', "data: [DONE]\n\n"]), { status: 200 });
  const out: string[] = [];
  for await (const d of openAiTextDeltas(res)) out.push(d);
  assert.equal(out.join(""), "abcd");
});
test("openAiTextDeltas survives a delta split across chunks", async () => {
  const res = new Response(streamOf(['data: {"choices":[{"delta":{"con', 'tent":"xy"}}]}\n\ndata: [DONE]\n\n']), { status: 200 });
  const out: string[] = [];
  for await (const d of openAiTextDeltas(res)) out.push(d);
  assert.equal(out.join(""), "xy");
});
