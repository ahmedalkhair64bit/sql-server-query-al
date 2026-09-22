import { mkdir, open } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
const root = join(process.cwd(), ".playwright-data", "benchmarks");
await mkdir(root, { recursive: true });
for (const target of [10_000_000, 50_000_000, 100_000_000]) {
  const dir = join(root, String(target));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "plan.xml");
  const fd = await open(file, "w");
  const head =
    '<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT * FROM dbo.T"><QueryPlan>';
  const tail =
    "</QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>";
  let used = Buffer.byteLength(head) + Buffer.byteLength(tail);
  await fd.write(head);
  let i = 0;
  while (true) {
    const op = `<RelOp NodeId="${i++}" PhysicalOp="Index Scan" EstimateRows="100" EstimatedTotalSubtreeCost="1"><IndexScan><Object Schema="[dbo]" Table="[T]"/></IndexScan></RelOp>`;
    if (used + op.length > target) break;
    await fd.write(op);
    used += op.length;
  }
  await fd.write(" ".repeat(target - used) + tail);
  await fd.close();
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const w = new Worker(join(process.cwd(), "lib/plan-worker.mjs"), {
      workerData: { file, directory: join(dir, "result") },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.on("message", resolve);
    w.on("error", reject);
  });
  console.log(
    JSON.stringify({
      bytes: target,
      ms: Math.round(performance.now() - start),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      result,
    }),
  );
}
