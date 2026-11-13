import type { NextConfig } from "next";

/**
 * The browser talks to this app only. /api/backend, /webhook and /health are
 * proxy route handlers (app/api/backend/[...path], app/webhook/[...path],
 * app/health) rather than rewrites: a rewrite is resolved when Next builds, so
 * the API_URL of the build machine would be baked into the image and a container
 * could never reach a sibling container. Read next.config's own comment history
 * before moving them back.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  transpilePackages: ["@qansa/core"],
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
