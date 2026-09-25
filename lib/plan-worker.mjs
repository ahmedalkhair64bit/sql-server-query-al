import { parentPort, workerData } from "node:worker_threads";
import {
  createReadStream,
  openSync,
  writeSync,
  closeSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createPlanParser, statementWeight } from "./plan-parser.mjs";
import { createDecoder, detectEncoding } from "./plan-decoder.mjs";
let fd;
try {
  mkdirSync(workerData.directory, { recursive: true });
  fd = openSync(join(workerData.directory, "statements.ndjson"), "w");
  const sourceBytes = statSync(workerData.file).size;
  let peakRSS = process.memoryUsage().rss,
    count = 0,
    recommended = null,
    cost = -1,
    offset = 0;
  const parser = createPlanParser((d) => {
    d.bytes = sourceBytes;
    const value = JSON.stringify(d) + "\n";
    writeSync(fd, value);
    const summary = {
      id: d.statementId,
      sql: d.sql.slice(0, 300),
      estimatedCost: d.subtreeCost,
      actual: d.actual,
      ...(d.queryHash ? { queryHash: d.queryHash } : {}),
      offset,
      length: Buffer.byteLength(value),
    };
    writeSync(summaryFd, JSON.stringify(summary) + "\n");
    offset += summary.length;
    count++;
    if (count > 100000)
      throw new Error(
        "Plan exceeds 100,000 statements; split the batch before upload.",
      );
    const weight = statementWeight(d);
    if (weight > cost) {
      cost = weight;
      recommended = d.statementId;
    }
  });
  const summaryFd = openSync(join(workerData.directory, "index.ndjson"), "w");
  let decoder,
    prefix = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(workerData.file, {
      highWaterMark: 65536,
    })) {
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
      if (!decoder) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 200) continue;
        decoder = createDecoder(detectEncoding(prefix));
        parser.write(decoder.write(prefix));
        prefix = null;
      } else parser.write(decoder.write(chunk));
    }
    if (!decoder) {
      decoder = createDecoder(detectEncoding(prefix));
      parser.write(decoder.write(prefix));
    }
    parser.write(decoder.end());
    const meta = parser.end();
    parentPort.postMessage({
      ok: true,
      count,
      recommended,
      peakRSS,
      coverage: meta.coverage,
    });
  } finally {
    closeSync(summaryFd);
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
} finally {
  if (fd !== undefined) closeSync(fd);
}
