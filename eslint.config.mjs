import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Existing dynamic OpenUI/SQLite/SSE boundaries and deliberately malformed test inputs.
  {
    files: ["tests/**", "lib/report-ui.ts", "lib/db.ts", "lib/stream.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".ua/**",
    "kb/.ua/**",
    "playwright-report/**",
    "test-results/**",
    ".playwright-data/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
