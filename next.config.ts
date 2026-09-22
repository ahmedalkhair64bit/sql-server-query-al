import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["saxes"],
  outputFileTracingIncludes: {
    "/api/plans": [
      "./lib/plan-worker.mjs",
      "./lib/plan-parser.mjs",
      "./lib/plan-decoder.mjs",
      "./node_modules/saxes/**",
      "./node_modules/xmlchars/**",
    ],
  },
};

export default nextConfig;
