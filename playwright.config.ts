import { defineConfig, devices } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
if (existsSync(".env.local"))
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
mkdirSync(".auth", { recursive: true });
const live = process.env.QAI_LIVE === "1";
export default defineConfig({
  testDir: "./tests-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.QAI_BASE_URL ?? "http://localhost:3100",
    trace: live ? "off" : "retain-on-failure",
    screenshot: live ? "off" : "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /session\.spec\.ts/,
    },
    ...(!live
      ? [
          {
            name: "firefox",
            use: { ...devices["Desktop Firefox"] },
            dependencies: ["setup"],
            testMatch: /workspace\.spec\.ts/,
          },
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
            dependencies: ["setup"],
            testMatch: /(session|workspace|account)\.spec\.ts/,
          },
          {
            name: "mobile",
            use: { ...devices["Pixel 7"] },
            dependencies: ["setup"],
            testMatch: /(responsive|workspace)\.spec\.ts/,
          },
        ]
      : []),
  ],
  webServer: process.env.QAI_EXTERNAL_SERVER
    ? []
    : [
        ...(!live
          ? [
              {
                command: "node scripts/qa-providers.mjs",
                url: "http://127.0.0.1:18889/health",
                reuseExistingServer: false,
              },
            ]
          : []),
        {
          command: "npm run start -- --port 3100",
          url: "http://localhost:3100/api/healthz",
          reuseExistingServer: false,
          timeout: 120000,
          env: {
            DATA_DIR: ".playwright-data",
            APP_SECRET: process.env.APP_SECRET ?? "playwright-secret-value",
            ...(!live ? { TYPESAFE_BASE_URL: "http://127.0.0.1:18889" } : {}),
          },
        },
      ],
});
