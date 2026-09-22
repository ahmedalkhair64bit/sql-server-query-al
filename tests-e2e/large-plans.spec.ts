import { test, expect } from "@playwright/test";
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
test.use({ storageState: ".auth/user.json" });
function makePlan(bytes: number) {
  mkdirSync(".playwright-data/large-fixtures", { recursive: true });
  const path = `.playwright-data/large-fixtures/${bytes}.sqlplan`;
  const fd = openSync(path, "w");
  const head =
      '<ShowPlanXML><StmtSimple StatementText="SELECT * FROM dbo.T"><QueryPlan>',
    tail = "</QueryPlan></StmtSimple></ShowPlanXML>";
  const op =
    '<RelOp NodeId="1" PhysicalOp="Index Scan" EstimateRows="10" EstimatedTotalSubtreeCost="1"><IndexScan><Object Schema="[dbo]" Table="[T]"/></IndexScan></RelOp>';
  const chunk = op.repeat(5000);
  let left = bytes - head.length - tail.length;
  writeSync(fd, head);
  while (left >= chunk.length) {
    writeSync(fd, chunk);
    left -= chunk.length;
  }
  writeSync(fd, " ".repeat(left));
  writeSync(fd, tail);
  closeSync(fd);
  return path;
}
for (const bytes of [10_000_000, 50_000_000, 100_000_000])
  test(`upload ${bytes / 1e6} MB while health remains responsive`, async ({
    page,
    request,
  }, info) => {
    const path = makePlan(bytes);
    await page.goto("/app");
    const start = Date.now();
    const uploaded = page.waitForResponse(
      (r) => r.url().endsWith("/api/plans") && r.request().method() === "POST",
      { timeout: 120000 },
    );
    let finished = false;
    void uploaded.then(() => {
      finished = true;
    });
    await page.setInputFiles("input[type=file]", path);
    const health = [];
    do {
      const now = Date.now();
      expect((await request.get("/api/healthz", { timeout: 2000 })).ok()).toBe(
        true,
      );
      health.push(Date.now() - now);
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!finished);
    const response = await uploaded;
    expect(response.status()).toBe(200);
    await expect(page.locator("#statement")).toBeVisible();
    expect(Math.max(...health)).toBeLessThan(2000);
    await info.attach("upload-metrics", {
      body: JSON.stringify({
        bytes,
        totalMs: Date.now() - start,
        healthMs: health,
      }),
      contentType: "application/json",
    });
  });
test("oversized file is rejected before upload", async ({ page }) => {
  await page.goto("/app");
  const path = makePlan(100_000_001);
  let sent = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/plans")) sent = true;
  });
  await page.setInputFiles("input[type=file]", path);
  await expect(page.locator(".notice[role=alert]")).toContainText("100 MB");
  expect(sent).toBe(false);
});
test("plan IDs and stored analyses are private to their owner", async ({
  request,
  browser,
  baseURL,
}) => {
  const uploaded = await request.post("/api/plans", {
    data: '<ShowPlanXML><StmtSimple StatementText="SELECT 1"/></ShowPlanXML>',
    headers: { "content-type": "application/octet-stream" },
  });
  const plan = await uploaded.json();
  const other = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const r = await other.request.get(`${baseURL}/api/plans/${plan.id}`);
  expect(r.status()).toBe(401);
  const p = await other.newPage();
  await p.goto(`${baseURL}/signup`);
  await p.fill("#email", `other-${Date.now()}@qai.test`);
  await p.fill("#password", "different account password");
  await p.getByRole("button", { name: "Create account" }).click();
  await expect(p).toHaveURL(/setup/);
  expect(
    (await other.request.get(`${baseURL}/api/plans/${plan.id}`)).status(),
  ).toBe(404);
  await other.close();
});
