import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy.
// - Mantine injects inline <style> tags, so style-src must allow 'unsafe-inline'.
// - Next.js requires 'unsafe-inline' (and 'unsafe-eval' in dev) for its runtime/scripts.
// - Sentry ingest must be reachable from the browser via connect-src.
//   Replace the *.ingest.sentry.io host below with your project's ingest host if different.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://js.stripe.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.stripe.com",
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// CSP mode: default to REPORT-ONLY (safe — logs violations without breaking the page).
// Flip to enforcing only after a browser smoke test confirms zero violations, by setting
// CSP_MODE=enforce in that environment. This avoids silently breaking prod before validation.
const cspMode = (process.env.CSP_MODE ?? "report-only").toLowerCase();
const cspHeaderKey =
  cspMode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

const securityHeaders = [
  { key: cspHeaderKey, value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

// Sentry build integration. Runtime error reporting comes from src/instrumentation.ts and
// src/instrumentation-client.ts; this wrapper adds release/route metadata and, when credentials are
// present at build time, uploads source maps so stack traces in Sentry are readable. Without
// SENTRY_AUTH_TOKEN the build still succeeds and errors are still reported (just minified).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
  silent: !process.env.CI,
});
