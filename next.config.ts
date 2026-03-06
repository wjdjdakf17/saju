import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep heavy Chromium runtime package external for server bundle stability.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // Ensure Brotli binaries are included in traced output for /api/generate.
  outputFileTracingIncludes: {
    "/api/generate": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/generate/route": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
