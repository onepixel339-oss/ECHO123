import type { NextConfig } from "next";
import { contentSecurityPolicy } from "./lib/echo/providers/registry";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  devIndicators: false,
  // allow the sandbox preview proxy to fetch /_next/* assets without warnings
  allowedDevOrigins: ["*.space-z.ai", "*.localhost"],
  async headers() {
    const headers = [];
    // A2/§5.4: the Content-Security-Policy allowlist is GENERATED from the
    // provider registry (single source of truth, doc 07 §3). Production
    // only — the dev server's HMR websocket would fight a strict CSP.
    if (process.env.NODE_ENV === "production") {
      headers.push({
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(),
          },
        ],
      });
    }
    return headers;
  },
};

export default nextConfig;
