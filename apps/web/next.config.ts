import type { NextConfig } from "next";

/**
 * The browser talks to this app only. Requests under /api/backend are proxied to
 * the Fastify API, so session cookies stay first-party on the claim and admin
 * hosts and no CORS preflight is needed in production.
 */
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  transpilePackages: ["@qansa/core"],
  async rewrites() {
    return [
      { source: "/api/backend/:path*", destination: `${apiUrl}/api/:path*` },
      { source: "/webhook/:path*", destination: `${apiUrl}/webhook/:path*` },
      { source: "/health", destination: `${apiUrl}/health` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
